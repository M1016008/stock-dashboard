import { randomUUID } from 'crypto'
import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { evaluateTradeScenario } from './scoring'
import type {
  TradeScenario,
  TradeScenarioConfidence,
  TradeScenarioCreateInput,
  TradeScenarioOverview,
  TradeScenarioOverviewItem,
  TradeScenarioDirection,
  TradeScenarioOutcome,
  TradeScenarioPriceRow,
  TradeScenarioStatus,
  TradeScenarioUpdateInput,
} from './types'

type ScenarioDbRow = {
  id: string
  ticker: string
  market: string
  name: string | null
  direction: TradeScenarioDirection
  status: TradeScenarioStatus
  confidence: TradeScenarioConfidence
  anchor_date: string
  anchor_close: number | null
  horizon_days: number
  entry_plan_price: number | null
  target_price: number | null
  stop_loss_price: number | null
  thesis: string
  invalidation: string | null
  review_memo: string | null
  selected_start_date: string | null
  selected_end_date: string | null
  source_range_label: string | null
  context_json: string | null
  created_at: string
  updated_at: string
}

type AnchorRow = {
  date: string
  close: number
  high: number
  low: number
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
}

const VALID_DIRECTIONS = new Set<TradeScenarioDirection>(['bullish', 'bearish', 'watch'])
const VALID_CONFIDENCE = new Set<TradeScenarioConfidence>(['low', 'medium', 'high'])
const VALID_STATUS = new Set<TradeScenarioStatus>(['open', 'reviewed', 'archived'])

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase().replace(/\.T$/i, '')
}

function normalizeMarket(value: string | null | undefined): string {
  const market = value?.trim().toUpperCase()
  return market === 'US' ? 'US' : 'JP'
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isoNow(): string {
  return new Date().toISOString()
}

export async function ensureTradeScenarioSchema(): Promise<void> {
  await execBatch([
    {
      sql: `CREATE TABLE IF NOT EXISTS trade_scenarios (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        market TEXT NOT NULL DEFAULT 'JP',
        name TEXT,
        direction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        confidence TEXT NOT NULL DEFAULT 'medium',
        anchor_date TEXT NOT NULL,
        anchor_close REAL,
        horizon_days INTEGER NOT NULL,
        entry_plan_price REAL,
        target_price REAL,
        stop_loss_price REAL,
        thesis TEXT NOT NULL,
        invalidation TEXT,
        review_memo TEXT,
        selected_start_date TEXT,
        selected_end_date TEXT,
        source_range_label TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    },
    { sql: `CREATE INDEX IF NOT EXISTS trade_scenarios_ticker_updated_idx ON trade_scenarios(market, ticker, updated_at)` },
    { sql: `CREATE INDEX IF NOT EXISTS trade_scenarios_status_idx ON trade_scenarios(status, updated_at)` },
    { sql: `CREATE INDEX IF NOT EXISTS trade_scenarios_anchor_idx ON trade_scenarios(market, ticker, anchor_date)` },
  ])
}

async function getAnchorRow(market: string, ticker: string, anchorDate: string | null): Promise<AnchorRow | undefined> {
  if (market !== 'JP') return undefined
  const dateFilter = anchorDate ? 'AND o.date <= ?' : ''
  const args = anchorDate ? [ticker, anchorDate] : [ticker]
  return execGet<AnchorRow>(
    `
      SELECT
        o.date,
        o.close,
        o.high,
        o.low,
        ds.daily_a_stage,
        ds.daily_b_stage,
        ds.weekly_a_stage,
        ds.weekly_b_stage,
        ds.monthly_a_stage,
        ds.monthly_b_stage,
        pm.physical_momentum_score,
        pm.physical_force_score,
        pm.physical_energy_score
      FROM ohlcv_daily o
      LEFT JOIN daily_snapshots ds
        ON ds.ticker = o.ticker
       AND ds.date = o.date
      LEFT JOIN physical_momentum_metrics pm
        ON pm.market = 'JP'
       AND pm.symbol = o.ticker
       AND pm.date = o.date
      WHERE o.ticker = ?
        ${dateFilter}
      ORDER BY o.date DESC
      LIMIT 1
    `,
    args,
  )
}

async function getFutureRows(
  market: string,
  ticker: string,
  anchorDate: string,
  horizonDays: number,
  asOfDate?: string | null,
): Promise<TradeScenarioPriceRow[]> {
  if (market !== 'JP') return []
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  return execAll<TradeScenarioPriceRow>(
    `
      SELECT date, high, low, close
      FROM ohlcv_daily
      WHERE ticker = ?
        AND date > ?
        ${dateFilter}
      ORDER BY date
      LIMIT ?
    `,
    asOfDate
      ? [ticker, anchorDate, asOfDate, Math.max(1, Math.floor(horizonDays || 20))]
      : [ticker, anchorDate, Math.max(1, Math.floor(horizonDays || 20))],
  )
}

function rowToScenario(row: ScenarioDbRow, outcome: TradeScenarioOutcome): TradeScenario {
  return {
    id: row.id,
    ticker: row.ticker,
    market: row.market,
    name: row.name,
    direction: row.direction,
    status: row.status,
    confidence: row.confidence,
    anchorDate: row.anchor_date,
    anchorClose: row.anchor_close,
    horizonDays: row.horizon_days,
    entryPlanPrice: row.entry_plan_price,
    targetPrice: row.target_price,
    stopLossPrice: row.stop_loss_price,
    thesis: row.thesis,
    invalidation: row.invalidation ?? '',
    reviewMemo: row.review_memo,
    selectedStartDate: row.selected_start_date,
    selectedEndDate: row.selected_end_date,
    sourceRangeLabel: row.source_range_label,
    contextJson: row.context_json ?? '{}',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outcome,
  }
}

function parseStages(contextJson: string | null | undefined): Array<number | null> {
  if (!contextJson) return []
  try {
    const parsed = JSON.parse(contextJson) as { anchorSnapshot?: { stages?: unknown[] } }
    const stages = parsed.anchorSnapshot?.stages
    if (!Array.isArray(stages)) return []
    return stages.slice(0, 6).map((stage) => typeof stage === 'number' ? stage : null)
  } catch {
    return []
  }
}

function pctChange(current: number | null, base: number | null): number | null {
  if (current == null || base == null || !Number.isFinite(current) || !Number.isFinite(base) || base === 0) return null
  return ((current - base) / base) * 100
}

function distanceToTarget(scenario: TradeScenario, currentClose: number | null): number | null {
  if (currentClose == null || scenario.targetPrice == null || !Number.isFinite(currentClose) || currentClose <= 0) return null
  if (scenario.outcome.status === 'target_hit') return 0
  if (scenario.direction === 'bearish') return ((currentClose - scenario.targetPrice) / currentClose) * 100
  if (scenario.direction === 'bullish') return ((scenario.targetPrice - currentClose) / currentClose) * 100
  return null
}

function distanceToStop(scenario: TradeScenario, currentClose: number | null): number | null {
  if (currentClose == null || scenario.stopLossPrice == null || !Number.isFinite(currentClose) || currentClose <= 0) return null
  if (scenario.outcome.status === 'stop_hit') return 0
  if (scenario.direction === 'bearish') return ((scenario.stopLossPrice - currentClose) / currentClose) * 100
  if (scenario.direction === 'bullish') return ((currentClose - scenario.stopLossPrice) / currentClose) * 100
  return null
}

function targetProgress(scenario: TradeScenario, currentClose: number | null): number | null {
  if (
    currentClose == null ||
    scenario.anchorClose == null ||
    scenario.targetPrice == null ||
    scenario.direction === 'watch'
  ) {
    return null
  }
  const denominator = scenario.direction === 'bearish'
    ? scenario.anchorClose - scenario.targetPrice
    : scenario.targetPrice - scenario.anchorClose
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  const numerator = scenario.direction === 'bearish'
    ? scenario.anchorClose - currentClose
    : currentClose - scenario.anchorClose
  return Math.max(0, Math.min(140, (numerator / denominator) * 100))
}

function scenarioPriority(
  scenario: TradeScenario,
  distanceTarget: number | null,
  distanceStop: number | null,
): Pick<TradeScenarioOverviewItem, 'priority' | 'priorityLabel' | 'priorityTone'> {
  if (scenario.outcome.status === 'target_hit') {
    return { priority: 100, priorityLabel: '目標到達', priorityTone: 'up' }
  }
  if (scenario.outcome.status === 'stop_hit') {
    return { priority: 96, priorityLabel: '撤退条件到達', priorityTone: 'down' }
  }
  if (scenario.status === 'open' && ['direction_missed', 'watch_missed'].includes(scenario.outcome.status)) {
    return { priority: 90, priorityLabel: '想定外の動き', priorityTone: 'warning' }
  }
  if (scenario.status === 'open' && ['direction_matched', 'watch_ok'].includes(scenario.outcome.status)) {
    return { priority: 82, priorityLabel: '振り返り待ち', priorityTone: 'neutral' }
  }
  if (scenario.outcome.status === 'pending' && distanceStop != null && distanceStop <= 2) {
    return { priority: 78, priorityLabel: '撤退価格に接近', priorityTone: 'down' }
  }
  if (scenario.outcome.status === 'pending' && distanceTarget != null && distanceTarget <= 2) {
    return { priority: 76, priorityLabel: '目標価格に接近', priorityTone: 'up' }
  }
  if (scenario.outcome.status === 'pending' && scenario.outcome.remainingDays <= 3) {
    return { priority: 72, priorityLabel: '期限間近', priorityTone: 'warning' }
  }
  if (scenario.outcome.status === 'pending') {
    return { priority: 48, priorityLabel: '検証中', priorityTone: 'neutral' }
  }
  return { priority: 40, priorityLabel: '確認済み', priorityTone: 'neutral' }
}

async function rowToOverviewItem(row: ScenarioDbRow, asOfDate?: string | null): Promise<TradeScenarioOverviewItem> {
  const futureRows = await getFutureRows(row.market, row.ticker, row.anchor_date, row.horizon_days, asOfDate)
  const latestFuture = futureRows.length > 0 ? futureRows[futureRows.length - 1] : null
  const outcome = evaluateTradeScenario({
    direction: row.direction,
    anchorPrice: row.anchor_close,
    horizonDays: row.horizon_days,
    targetPrice: row.target_price,
    stopLossPrice: row.stop_loss_price,
    futureRows,
  })
  const scenario = rowToScenario(row, outcome)
  const currentClose = latestFuture?.close ?? scenario.anchorClose
  const currentDate = latestFuture?.date ?? scenario.anchorDate
  const distanceTarget = distanceToTarget(scenario, currentClose)
  const distanceStop = distanceToStop(scenario, currentClose)
  const priority = scenarioPriority(scenario, distanceTarget, distanceStop)
  return {
    ...scenario,
    currentDate,
    currentClose,
    currentReturnPct: pctChange(currentClose, scenario.anchorClose),
    distanceToTargetPct: distanceTarget,
    distanceToStopPct: distanceStop,
    targetProgressPct: targetProgress(scenario, currentClose),
    stages: parseStages(row.context_json),
    ...priority,
  }
}

export async function listTradeScenarios(input: { ticker: string; market?: string; includeArchived?: boolean }): Promise<TradeScenario[]> {
  await ensureTradeScenarioSchema()
  const ticker = normalizeTicker(input.ticker)
  const market = normalizeMarket(input.market)
  const rows = await execAll<ScenarioDbRow>(
    `
      SELECT *
      FROM trade_scenarios
      WHERE market = ?
        AND ticker = ?
        ${input.includeArchived ? '' : "AND status <> 'archived'"}
      ORDER BY updated_at DESC
      LIMIT 60
    `,
    [market, ticker],
  )
  return Promise.all(rows.map(async (row) => {
    const futureRows = await getFutureRows(row.market, row.ticker, row.anchor_date, row.horizon_days)
    const outcome = evaluateTradeScenario({
      direction: row.direction,
      anchorPrice: row.anchor_close,
      horizonDays: row.horizon_days,
      targetPrice: row.target_price,
      stopLossPrice: row.stop_loss_price,
      futureRows,
    })
    return rowToScenario(row, outcome)
  }))
}

export async function getTradeScenarioOverview(limit = 8, asOfDate?: string | null): Promise<TradeScenarioOverview> {
  await ensureTradeScenarioSchema()
  const dateFilter = asOfDate ? 'AND anchor_date <= ?' : ''
  const rows = await execAll<ScenarioDbRow>(
    `
      SELECT *
      FROM trade_scenarios
      WHERE status <> 'archived'
        ${dateFilter}
      ORDER BY updated_at DESC
      LIMIT 120
    `,
    asOfDate ? [asOfDate] : [],
  )
  const overviewItems = await Promise.all(rows.map((row) => rowToOverviewItem(row, asOfDate)))
  const sorted = overviewItems.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  const reviewDueStatuses = new Set(['target_hit', 'stop_hit', 'direction_matched', 'direction_missed', 'watch_ok', 'watch_missed'])
  return {
    summary: {
      total: overviewItems.length,
      active: overviewItems.filter((item) => item.status === 'open').length,
      attention: overviewItems.filter((item) => item.priority >= 72 && item.status === 'open').length,
      targetHit: overviewItems.filter((item) => item.outcome.status === 'target_hit').length,
      stopHit: overviewItems.filter((item) => item.outcome.status === 'stop_hit').length,
      reviewDue: overviewItems.filter((item) => item.status === 'open' && reviewDueStatuses.has(item.outcome.status)).length,
      pending: overviewItems.filter((item) => item.outcome.status === 'pending').length,
      latestUpdatedAt: overviewItems[0]?.updatedAt ?? null,
    },
    items: sorted.slice(0, Math.max(1, Math.min(20, Math.floor(limit || 8)))),
  }
}

export async function createTradeScenario(input: TradeScenarioCreateInput): Promise<TradeScenario> {
  await ensureTradeScenarioSchema()
  const ticker = normalizeTicker(input.ticker)
  const market = normalizeMarket(input.market)
  if (!ticker) throw new Error('ticker is required')
  if (!VALID_DIRECTIONS.has(input.direction)) throw new Error('invalid direction')
  const horizonDays = Math.max(1, Math.min(260, Math.floor(Number(input.horizonDays || 20))))
  const thesis = nullableText(input.thesis)
  if (!thesis) throw new Error('thesis is required')

  const requestedAnchorDate = nullableText(input.anchorDate)
  const anchor = await getAnchorRow(market, ticker, requestedAnchorDate)
  if (!anchor) throw new Error(`price data not found for ${ticker}`)
  const now = isoNow()
  const confidence = VALID_CONFIDENCE.has(input.confidence ?? 'medium') ? (input.confidence ?? 'medium') : 'medium'
  const id = randomUUID()
  const context = {
    ...(input.context ?? {}),
    anchorSnapshot: {
      date: anchor.date,
      close: anchor.close,
      stages: [
        anchor.daily_a_stage,
        anchor.daily_b_stage,
        anchor.weekly_a_stage,
        anchor.weekly_b_stage,
        anchor.monthly_a_stage,
        anchor.monthly_b_stage,
      ],
      pms: anchor.physical_momentum_score,
      pfs: anchor.physical_force_score,
      pes: anchor.physical_energy_score,
    },
  }

  await execRun(
    `
      INSERT INTO trade_scenarios (
        id, ticker, market, name, direction, status, confidence, anchor_date, anchor_close,
        horizon_days, entry_plan_price, target_price, stop_loss_price, thesis, invalidation,
        review_memo, selected_start_date, selected_end_date, source_range_label, context_json,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      ticker,
      market,
      nullableText(input.name),
      input.direction,
      confidence,
      anchor.date,
      anchor.close,
      horizonDays,
      nullableNumber(input.entryPlanPrice),
      nullableNumber(input.targetPrice),
      nullableNumber(input.stopLossPrice),
      thesis,
      nullableText(input.invalidation),
      nullableText(input.selectedStartDate),
      nullableText(input.selectedEndDate),
      nullableText(input.sourceRangeLabel),
      JSON.stringify(context),
      now,
      now,
    ],
  )

  const scenarios = await listTradeScenarios({ ticker, market, includeArchived: true })
  const created = scenarios.find((scenario) => scenario.id === id)
  if (!created) throw new Error('failed to reload created scenario')
  return created
}

export async function updateTradeScenario(id: string, input: TradeScenarioUpdateInput): Promise<TradeScenario | null> {
  await ensureTradeScenarioSchema()
  const row = await execGet<ScenarioDbRow>('SELECT * FROM trade_scenarios WHERE id = ?', [id])
  if (!row) return null
  const status = input.status && VALID_STATUS.has(input.status) ? input.status : row.status
  const reviewMemo = input.reviewMemo === undefined ? row.review_memo : nullableText(input.reviewMemo)
  await execRun(
    `
      UPDATE trade_scenarios
      SET status = ?,
          review_memo = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [status, reviewMemo, isoNow(), id],
  )
  const scenarios = await listTradeScenarios({ ticker: row.ticker, market: row.market, includeArchived: true })
  return scenarios.find((scenario) => scenario.id === id) ?? null
}
