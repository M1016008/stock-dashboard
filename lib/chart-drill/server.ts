import { execAll } from '@/lib/db/client'
import { COMMODITY_INSTRUMENTS } from '@/lib/commodities'
import { SECTOR_ETF_TICKERS } from '@/lib/sector-etfs'
import {
  answerIsCorrect,
  buildAnswerExplanation,
  buildHintSummary,
  computeOutcome,
  deviationPct,
  enrichCandlesWithMa,
  isCandidateForDifficulty,
  slopePct,
} from './scoring'
import type {
  DrillAnswer,
  DrillAnswerResult,
  DrillCandle,
  DrillConfidence,
  DrillDifficulty,
  DrillDirection,
  DrillMarket,
  DrillMetricSnapshot,
  DrillQuestion,
  DrillStageSnapshot,
  DrillTarget,
} from './types'

const LOOKBACK_CANDLES = 140
const HISTORY_LIMIT = 1100
const MAX_HORIZON = 200
const PRECOMPUTED_MIN_DATE = '2008-05-07'
const PRECOMPUTED_HORIZONS = new Set([5, 10, 15, 20, 30, 40, 60, 90, 180, 200])

type UniverseItem = {
  market: DrillMarket
  ticker: string
  name: string | null
}

type RawSeriesRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  name: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  velocity: number | null
  acceleration: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
}

type ProblemPayload = {
  v: 1
  market: DrillMarket
  ticker: string
  asOfDate: string
  horizonDays: number
  thresholdPct: number
  direction: DrillDirection
  target: DrillTarget
  difficulty: DrillDifficulty
}

export interface DrillQuestionParams {
  horizonDays: number
  thresholdPct: number
  direction: DrillDirection
  target: DrillTarget
  difficulty: DrillDifficulty
  watchlistTickers?: string[]
}

export interface DrillAnswerParams {
  problemId: string
  answer: DrillAnswer
  confidence: DrillConfidence
  memo?: string | null
}

export function normalizeQuestionParams(searchParams: URLSearchParams): DrillQuestionParams {
  const horizonDays = clampInt(Number(searchParams.get('horizonDays') ?? 10), 1, MAX_HORIZON)
  const thresholdPct = clampNumber(Number(searchParams.get('thresholdPct') ?? 5), 0.5, 80)
  const direction = normalizeDirection(searchParams.get('direction'))
  const target = normalizeTarget(searchParams.get('target'))
  const difficulty = normalizeDifficulty(searchParams.get('difficulty'))
  const watchlistTickers = (searchParams.get('watchlist') ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase().replace(/\.T$/i, ''))
    .filter(Boolean)
    .slice(0, 200)
  return { horizonDays, thresholdPct, direction, target, difficulty, watchlistTickers }
}

export function normalizeAnswer(value: unknown): DrillAnswer {
  return value === 'up' || value === 'down' || value === 'pass' ? value : 'pass'
}

export function normalizeConfidence(value: unknown): DrillConfidence {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium'
}

export async function createDrillQuestion(params: DrillQuestionParams): Promise<DrillQuestion> {
  const universe = await loadUniverse(params.target, params.watchlistTickers ?? [])
  if (universe.length === 0) {
    throw new Error('指定対象に出題可能な銘柄がありません。対象市場またはウォッチリストを確認してください。')
  }

  const intendedPool = intendedAnswers(params.direction, params.difficulty)
  for (const intended of shuffle(intendedPool)) {
    const found = await findPrecomputedQuestion(params, intended)
    if (found) return found
  }

  const shuffled = shuffle(universe).slice(0, Math.min(universe.length, 45))

  for (const intended of shuffle(intendedPool)) {
    const found = await findQuestionForIntended(shuffled, params, intended)
    if (found) return found
  }

  const wider = shuffle(universe).slice(0, Math.min(universe.length, 90))
  for (const intended of shuffle(['up', 'down', 'pass'] as DrillAnswer[])) {
    const found = await findQuestionForIntended(wider, { ...params, difficulty: 'practical' }, intended)
    if (found) return found
  }

  throw new Error('条件に合う問題を生成できませんでした。期間・変動率・対象を少し緩めてください。')
}

export async function answerDrillQuestion(params: DrillAnswerParams): Promise<DrillAnswerResult> {
  const payload = decodeProblemId(params.problemId)
  const rows = await loadSeries(payload.market, payload.ticker)
  const index = rows.findIndex((row) => row.date === payload.asOfDate)
  if (index < LOOKBACK_CANDLES || index < 0 || index + payload.horizonDays >= rows.length) {
    throw new Error('問題の価格データを再取得できませんでした。別の問題を出題してください。')
  }
  const question = buildQuestionFromIndex(rows, index, payload, false)
  const future = rows.slice(index + 1, index + 1 + payload.horizonDays)
  const revealStart = Math.max(0, index - LOOKBACK_CANDLES + 1)
  const revealChart = rows.slice(revealStart, index + 1 + payload.horizonDays)
  const outcome = computeOutcome({
    base: rows[index],
    future,
    thresholdPct: payload.thresholdPct,
  })
  const { explanations, reviewTags } = buildAnswerExplanation(question.stage, question.metrics, outcome)
  const correct = answerIsCorrect(params.answer, outcome)
  return {
    correct,
    expectedAnswer: outcome.actual,
    userAnswer: params.answer,
    confidence: params.confidence,
    memo: params.memo?.trim() ? params.memo.trim().slice(0, 500) : null,
    question: {
      ticker: question.ticker,
      name: question.name,
      market: question.market,
      marketLabel: question.marketLabel,
      target: question.target,
      asOfDate: question.asOfDate,
      horizonDays: question.horizonDays,
      thresholdPct: question.thresholdPct,
      direction: question.direction,
      difficulty: question.difficulty,
      chart: question.chart,
      stage: question.stage,
      metrics: question.metrics,
      hints: question.hints,
    },
    outcome,
    revealChart,
    futureChart: future,
    explanations,
    reviewTags,
  }
}

async function findQuestionForIntended(
  universe: UniverseItem[],
  params: DrillQuestionParams,
  intended: DrillAnswer,
): Promise<DrillQuestion | null> {
  for (const item of universe) {
    const rows = await loadSeries(item.market, item.ticker)
    if (rows.length < LOOKBACK_CANDLES + params.horizonDays + 10) continue
    const candidates = candidateIndexes(rows, params, intended)
    if (candidates.length === 0) continue
    const index = candidates[Math.floor(Math.random() * candidates.length)]
    return buildQuestionFromIndex(rows, index, {
      v: 1,
      market: item.market,
      ticker: item.ticker,
      asOfDate: rows[index].date,
      horizonDays: params.horizonDays,
      thresholdPct: params.thresholdPct,
      direction: params.direction,
      target: params.target,
      difficulty: params.difficulty,
    }, true)
  }
  return null
}

async function findPrecomputedQuestion(params: DrillQuestionParams, intended: DrillAnswer): Promise<DrillQuestion | null> {
  if (params.target === 'us' || !PRECOMPUTED_HORIZONS.has(params.horizonDays)) {
    return null
  }

  const rangeRows = await execAll<{ maxDate: string | null }>(
    `
    SELECT date AS maxDate
    FROM forward_extrema INDEXED BY fext_horizon_date_idx
    WHERE horizon_days = ?
    ORDER BY date DESC
    LIMIT 1
    `,
    [params.horizonDays],
  )
  const maxDate = rangeRows[0]?.maxDate
  if (!maxDate) return null

  const where = ['fe.horizon_days = ?']
  const criteriaArgs: Array<string | number> = []
  if (intended === 'up') {
    where.push('fe.max_return_pct >= ?')
    criteriaArgs.push(params.thresholdPct)
  } else if (intended === 'down') {
    where.push('fe.min_return_pct <= ?')
    criteriaArgs.push(-params.thresholdPct)
  } else {
    where.push('fe.max_return_pct < ?', 'fe.min_return_pct > ?')
    criteriaArgs.push(params.thresholdPct, -params.thresholdPct)
  }

  const universeArgs: Array<string | number> = []
  const universeSql = jpUniverseFilterSql(params.target, params.watchlistTickers ?? [], universeArgs)
  if (!universeSql) return null

  let rows: Array<{ ticker: string; date: string }> = []
  for (let attempt = 0; attempt < 4 && rows.length === 0; attempt += 1) {
    const pivotDate = attempt === 3 ? maxDate : randomDateBetween(PRECOMPUTED_MIN_DATE, maxDate)
    const args: Array<string | number> = [params.horizonDays, ...criteriaArgs, pivotDate, ...universeArgs]
    const indexHint = universeSql.tickerScoped ? 'sqlite_autoindex_forward_extrema_1' : 'fext_horizon_date_idx'
    rows = await execAll<{ ticker: string; date: string }>(
      `
      SELECT fe.ticker, fe.date
      FROM forward_extrema fe INDEXED BY ${indexHint}
      ${universeSql.joinSql}
      WHERE ${where.join(' AND ')}
        AND fe.date <= ?
        ${universeSql.whereSql}
      ORDER BY fe.date DESC
      LIMIT 120
      `,
      args,
    )
  }

  let looseQuestion: DrillQuestion | null = null
  for (const row of rows) {
    const series = await loadSeries('JP', row.ticker)
    const index = series.findIndex((item) => item.date === row.date)
    if (index < LOOKBACK_CANDLES || index + params.horizonDays >= series.length) continue
    const outcome = computeOutcome({
      base: series[index],
      future: series.slice(index + 1, index + 1 + params.horizonDays),
      thresholdPct: params.thresholdPct,
    })
    if (outcome.actual !== intended) continue
    const question = buildQuestionFromIndex(series, index, {
      v: 1,
      market: 'JP',
      ticker: row.ticker,
      asOfDate: row.date,
      horizonDays: params.horizonDays,
      thresholdPct: params.thresholdPct,
      direction: params.direction,
      target: params.target,
      difficulty: params.difficulty,
    }, true)
    if (isCandidateForDifficulty(outcome, intended, params.thresholdPct, params.difficulty)) return question
    looseQuestion ??= question
  }

  return looseQuestion
}

function candidateIndexes(rows: DrillCandle[], params: DrillQuestionParams, intended: DrillAnswer): number[] {
  const minIndex = LOOKBACK_CANDLES - 1
  const maxIndex = rows.length - params.horizonDays - 1
  if (maxIndex <= minIndex) return []
  const indexes = shuffle(Array.from({ length: maxIndex - minIndex + 1 }, (_, offset) => minIndex + offset)).slice(0, 180)
  return indexes.filter((index) => {
    const outcome = computeOutcome({
      base: rows[index],
      future: rows.slice(index + 1, index + 1 + params.horizonDays),
      thresholdPct: params.thresholdPct,
    })
    if (outcome.actual !== intended) return false
    return isCandidateForDifficulty(outcome, intended, params.thresholdPct, params.difficulty)
  })
}

function jpUniverseFilterSql(
  target: DrillTarget,
  watchlistTickers: string[],
  args: Array<string | number>,
): { joinSql: string; whereSql: string; tickerScoped: boolean } | null {
  if (target === 'jp' || target === 'all') {
    return {
      joinSql: 'INNER JOIN ticker_universe u ON u.ticker = fe.ticker',
      whereSql: "AND COALESCE(u.active, 1) = 1 AND u.market_segment IN ('プライム', 'スタンダード', 'グロース')",
      tickerScoped: false,
    }
  }
  if (target === 'etf') {
    const placeholders = SECTOR_ETF_TICKERS.map(() => '?').join(',')
    args.push(...SECTOR_ETF_TICKERS)
    return {
      joinSql: '',
      whereSql: `AND fe.ticker IN (${placeholders})`,
      tickerScoped: true,
    }
  }
  if (target === 'commodity') {
    const jpCommodityTickers = COMMODITY_INSTRUMENTS.filter((item) => item.market === 'JP').map((item) => item.ticker)
    if (jpCommodityTickers.length === 0) return null
    const placeholders = jpCommodityTickers.map(() => '?').join(',')
    args.push(...jpCommodityTickers)
    return {
      joinSql: '',
      whereSql: `AND fe.ticker IN (${placeholders})`,
      tickerScoped: true,
    }
  }
  if (target === 'watchlist') {
    if (watchlistTickers.length === 0) return null
    const placeholders = watchlistTickers.map(() => '?').join(',')
    args.push(...watchlistTickers)
    return {
      joinSql: '',
      whereSql: `AND fe.ticker IN (${placeholders})`,
      tickerScoped: true,
    }
  }
  return null
}

function buildQuestionFromIndex(rows: DrillCandle[], index: number, payload: ProblemPayload, includeProblemId: true): DrillQuestion
function buildQuestionFromIndex(rows: DrillCandle[], index: number, payload: ProblemPayload, includeProblemId: false): Omit<DrillQuestion, 'problemId'>
function buildQuestionFromIndex(rows: DrillCandle[], index: number, payload: ProblemPayload, includeProblemId: boolean): DrillQuestion | Omit<DrillQuestion, 'problemId'> {
  const asOf = rows[index]
  const asOfRaw = asOf as DrillCandle & Partial<RawSeriesRow>
  const previous = rows[index - 1] ?? null
  const past5 = rows[Math.max(0, index - 5)] ?? null
  const past20 = rows[Math.max(0, index - 20)] ?? null
  const stage = stageSnapshot(asOf, previous)
  const metrics = metricSnapshot(rows, index, past5, past20)
  const base = {
    ticker: payload.ticker,
    name: asOfRaw.name ?? null,
    market: payload.market,
    marketLabel: payload.market === 'JP' ? '日本株' : '米国株',
    target: payload.target,
    asOfDate: payload.asOfDate,
    horizonDays: payload.horizonDays,
    thresholdPct: payload.thresholdPct,
    direction: payload.direction,
    difficulty: payload.difficulty,
    chart: rows.slice(Math.max(0, index - LOOKBACK_CANDLES + 1), index + 1),
    stage,
    metrics,
    hints: buildHintSummary(stage, metrics),
  }
  return includeProblemId ? { ...base, problemId: encodeProblemId(payload) } : base
}

function stageSnapshot(row: DrillCandle, previous: DrillCandle | null): DrillStageSnapshot {
  const current = row as DrillCandle & Partial<RawSeriesRow>
  const prev = previous as (DrillCandle & Partial<RawSeriesRow>) | null
  return {
    dailyA: current.daily_a_stage ?? null,
    dailyB: current.daily_b_stage ?? null,
    weeklyA: current.weekly_a_stage ?? null,
    weeklyB: current.weekly_b_stage ?? null,
    monthlyA: current.monthly_a_stage ?? null,
    monthlyB: current.monthly_b_stage ?? null,
    previousDailyA: prev?.daily_a_stage ?? null,
  }
}

function metricSnapshot(rows: DrillCandle[], index: number, past5: DrillCandle | null, past20: DrillCandle | null): DrillMetricSnapshot {
  const row = rows[index] as DrillCandle & RawSeriesRow
  const prev = rows[index - 1] as (DrillCandle & RawSeriesRow) | undefined
  const last20 = rows.slice(Math.max(0, index - 19), index + 1)
  const avgVolume20 = last20.length > 0 ? last20.reduce((sum, item) => sum + item.volume, 0) / last20.length : null
  const velocity20 = row.velocity ?? (past20 && past20.close !== 0 ? (row.close - past20.close) / past20.close : null)
  const prevVelocity20 = prev && rows[index - 21] && rows[index - 21].close !== 0
    ? (prev.close - rows[index - 21].close) / rows[index - 21].close
    : null
  return {
    priceVsMa25Pct: deviationPct(row.close, row.ma25),
    priceVsMa75Pct: deviationPct(row.close, row.ma75),
    ma5SlopePct: slopePct(row.ma5, past5?.ma5),
    ma25SlopePct: slopePct(row.ma25, past5?.ma25),
    ma75SlopePct: slopePct(row.ma75, past5?.ma75),
    volumeRatio20: avgVolume20 && avgVolume20 > 0 ? row.volume / avgVolume20 : null,
    velocity20,
    acceleration20: row.acceleration ?? (
      velocity20 != null && prevVelocity20 != null ? velocity20 - prevVelocity20 : null
    ),
    physicalMomentumScore: row.physical_momentum_score ?? null,
    physicalForceScore: row.physical_force_score ?? null,
    physicalEnergyScore: row.physical_energy_score ?? null,
  }
}

async function loadSeries(market: DrillMarket, ticker: string): Promise<Array<DrillCandle & Partial<RawSeriesRow>>> {
  const rows = market === 'US'
    ? await execAll<RawSeriesRow>(
      `
      SELECT
        o.date, o.open, o.high, o.low, o.close, o.volume,
        u.name,
        s.daily_a_stage, s.daily_b_stage, s.weekly_a_stage, s.weekly_b_stage, s.monthly_a_stage, s.monthly_b_stage,
        pm.velocity, pm.acceleration, pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score
      FROM (
        SELECT date, open, high, low, close, volume
        FROM market_ohlcv_daily
        WHERE market = 'US' AND ticker = ?
        ORDER BY date DESC
        LIMIT ?
      ) o
      LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = ?
      LEFT JOIN market_daily_snapshots s ON s.market = 'US' AND s.ticker = ? AND s.date = o.date
      LEFT JOIN physical_momentum_metrics pm ON pm.market = 'US' AND pm.symbol = ? AND pm.date = o.date
      ORDER BY o.date
      `,
      [ticker, HISTORY_LIMIT, ticker, ticker, ticker],
    )
    : await execAll<RawSeriesRow>(
      `
      SELECT
        o.date, o.open, o.high, o.low, o.close, o.volume,
        u.name,
        s.daily_a_stage, s.daily_b_stage, s.weekly_a_stage, s.weekly_b_stage, s.monthly_a_stage, s.monthly_b_stage,
        pm.velocity, pm.acceleration, pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score
      FROM (
        SELECT date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
        ORDER BY date DESC
        LIMIT ?
      ) o
      LEFT JOIN ticker_universe u ON u.ticker = ?
      LEFT JOIN daily_snapshots s ON s.ticker = ? AND s.date = o.date
      LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = ? AND pm.date = o.date
      ORDER BY o.date
      `,
      [ticker, HISTORY_LIMIT, ticker, ticker, ticker],
    )
  const enriched = enrichCandlesWithMa(rows.map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  })))
  return enriched.map((row, index) => ({ ...row, ...rows[index] }))
}

async function loadUniverse(target: DrillTarget, watchlistTickers: string[]): Promise<UniverseItem[]> {
  if (target === 'watchlist') {
    if (watchlistTickers.length === 0) return []
    const placeholders = watchlistTickers.map(() => '?').join(',')
    const rows = await execAll<{ ticker: string; name: string | null }>(
      `
      SELECT u.ticker, u.name
      FROM ticker_universe u
      WHERE u.ticker IN (${placeholders})
        AND EXISTS (SELECT 1 FROM ohlcv_daily o WHERE o.ticker = u.ticker)
      ORDER BY u.ticker
      `,
      watchlistTickers,
    )
    return rows.map((row) => ({ market: 'JP', ticker: row.ticker, name: row.name }))
  }

  if (target === 'commodity') {
    const jpTickers = COMMODITY_INSTRUMENTS.filter((item) => item.market === 'JP').map((item) => item.ticker)
    const usTickers = COMMODITY_INSTRUMENTS.filter((item) => item.market === 'US').map((item) => item.ticker)
    const [jpRows, usRows] = await Promise.all([
      loadCommodityUniverse(jpTickers, 'JP'),
      loadCommodityUniverse(usTickers, 'US'),
    ])
    const names = new Map(COMMODITY_INSTRUMENTS.map((item) => [`${item.market}:${item.ticker}`, item.name]))
    return [...jpRows, ...usRows].map((row) => ({
      ...row,
      name: row.name ?? names.get(`${row.market}:${row.ticker}`) ?? null,
    }))
  }

  if (target === 'etf') {
    const placeholders = SECTOR_ETF_TICKERS.map(() => '?').join(',')
    const rows = await execAll<{ ticker: string; name: string | null }>(
      `
      SELECT u.ticker, COALESCE(u.name, u.ticker) AS name
      FROM ticker_universe u
      WHERE u.ticker IN (${placeholders})
        AND EXISTS (SELECT 1 FROM ohlcv_daily o WHERE o.ticker = u.ticker)
      ORDER BY u.ticker
      `,
      SECTOR_ETF_TICKERS,
    )
    return rows.map((row) => ({ market: 'JP', ticker: row.ticker, name: row.name }))
  }

  const jp = target === 'jp' || target === 'all'
    ? await execAll<{ ticker: string; name: string | null }>(
      `
      SELECT u.ticker, u.name
      FROM ticker_universe u
      WHERE COALESCE(u.active, 1) = 1
        AND u.market_segment IN ('プライム', 'スタンダード', 'グロース')
        AND EXISTS (SELECT 1 FROM ohlcv_daily o WHERE o.ticker = u.ticker)
      ORDER BY u.ticker
      `,
    )
    : []
  const us = target === 'us' || target === 'all'
    ? await execAll<{ ticker: string; name: string | null }>(
      `
      SELECT u.ticker, u.name
      FROM market_universe u
      WHERE u.market = 'US'
        AND COALESCE(u.active, 1) = 1
        AND COALESCE(lower(u.asset_type), '') != 'etf'
        AND EXISTS (SELECT 1 FROM market_ohlcv_daily o WHERE o.market = 'US' AND o.ticker = u.ticker)
      ORDER BY u.ticker
      LIMIT 5000
      `,
    )
    : []
  return [
    ...jp.map((row) => ({ market: 'JP' as const, ticker: row.ticker, name: row.name })),
    ...us.map((row) => ({ market: 'US' as const, ticker: row.ticker, name: row.name })),
  ]
}

async function loadCommodityUniverse(tickers: string[], market: DrillMarket): Promise<UniverseItem[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  if (market === 'US') {
    const rows = await execAll<{ ticker: string; name: string | null }>(
      `
      SELECT u.ticker, u.name
      FROM market_universe u
      WHERE u.market = 'US'
        AND u.ticker IN (${placeholders})
        AND EXISTS (SELECT 1 FROM market_ohlcv_daily o WHERE o.market = 'US' AND o.ticker = u.ticker)
      ORDER BY u.ticker
      `,
      tickers,
    )
    return rows.map((row) => ({ market: 'US', ticker: row.ticker, name: row.name }))
  }
  const rows = await execAll<{ ticker: string; name: string | null }>(
    `
    SELECT u.ticker, u.name
    FROM ticker_universe u
    WHERE u.ticker IN (${placeholders})
      AND EXISTS (SELECT 1 FROM ohlcv_daily o WHERE o.ticker = u.ticker)
    ORDER BY u.ticker
    `,
    tickers,
  )
  return rows.map((row) => ({ market: 'JP', ticker: row.ticker, name: row.name }))
}

function intendedAnswers(direction: DrillDirection, difficulty: DrillDifficulty): DrillAnswer[] {
  if (direction === 'up') return ['up']
  if (direction === 'down') return ['down']
  if (difficulty === 'practical') return ['up', 'down', 'pass', 'pass']
  return ['up', 'down']
}

function encodeProblemId(payload: ProblemPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeProblemId(problemId: string): ProblemPayload {
  try {
    const parsed = JSON.parse(Buffer.from(problemId, 'base64url').toString('utf8')) as Partial<ProblemPayload>
    if (parsed.v !== 1 || !parsed.market || !parsed.ticker || !parsed.asOfDate) throw new Error('invalid payload')
    return {
      v: 1,
      market: parsed.market === 'US' ? 'US' : 'JP',
      ticker: String(parsed.ticker).trim().toUpperCase().replace(/\.T$/i, ''),
      asOfDate: String(parsed.asOfDate),
      horizonDays: clampInt(Number(parsed.horizonDays), 1, MAX_HORIZON),
      thresholdPct: clampNumber(Number(parsed.thresholdPct), 0.5, 80),
      direction: normalizeDirection(parsed.direction),
      target: normalizeTarget(parsed.target),
      difficulty: normalizeDifficulty(parsed.difficulty),
    }
  } catch {
    throw new Error('問題IDを読み取れませんでした。次の問題を取得してください。')
  }
}

function normalizeDirection(value: unknown): DrillDirection {
  return value === 'up' || value === 'down' || value === 'mixed' ? value : 'up'
}

function normalizeTarget(value: unknown): DrillTarget {
  return value === 'jp'
    || value === 'us'
    || value === 'etf'
    || value === 'commodity'
    || value === 'watchlist'
    || value === 'all'
    ? value
    : 'jp'
}

function normalizeDifficulty(value: unknown): DrillDifficulty {
  return value === 'beginner' || value === 'intermediate' || value === 'advanced' || value === 'practical'
    ? value
    : 'intermediate'
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function randomDateBetween(minDate: string, maxDate: string): string {
  const min = new Date(`${minDate}T00:00:00Z`).getTime()
  const max = new Date(`${maxDate}T00:00:00Z`).getTime()
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return maxDate
  const value = min + Math.random() * (max - min)
  return new Date(value).toISOString().slice(0, 10)
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
