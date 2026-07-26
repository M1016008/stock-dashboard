import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { NIKKEI225_TICKERS, parseUniverseFilter, universeSqlCondition } from '@/lib/market-universe'
import { getCurrentSimilars } from '@/lib/queries/ml-insights'
import { buildShortTermCheck } from '@/lib/short-term-check'
import type {
  AssistantModelEvidence,
  AssistantPlannedToolCall,
  AssistantResultRow,
  AssistantToolResult,
} from '@/lib/assistant/types'

type SearchRow = {
  ticker: string
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
}

type StockOverviewRow = SearchRow & {
  date: string | null
  close: number | null
  prev_close: number | null
  volume: number | null
  avg_volume_30d: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  physics_up_rank: number | null
  physics_up_score: number | null
  physics_down_rank: number | null
  physics_down_score: number | null
  classic_up_rank: number | null
  classic_down_rank: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  physical_momentum_prev_score: number | null
  ml_up_count: number | null
  ml_down_count: number | null
  ml_similar_count: number | null
  ml_top_similarity: number | null
}

type ScreenRow = StockOverviewRow

type WeeklyBearishBreakRow = SearchRow & {
  date: string | null
  close: number | null
  prev_close: number | null
  volume: number | null
  avg_volume_20d: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  week_start: string
  week_end: string
  week_open: number
  week_high: number
  week_low: number
  week_close: number
  week_volume: number
  ma5: number
  ma10: number
  ma25: number
  prev_week_close: number | null
  prev_ma5: number | null
  prev_ma10: number | null
  prev_ma25: number | null
  ma5_slope_pct: number | null
  ma10_slope_pct: number | null
  ma25_slope_pct: number | null
  physics_up_rank: number | null
  physics_up_score: number | null
  physics_down_rank: number | null
  physics_down_score: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  physical_momentum_prev_score: number | null
  ml_up_count: number | null
  ml_down_count: number | null
  ml_similar_count: number | null
  ml_top_similarity: number | null
  bearish_score: number | null
}

type EarningsRow = {
  ticker: string
  name: string | null
  announce_date: string
  fiscal_period: string | null
  close: number | null
  volume: number | null
  avg_volume_30d: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
}

type VectorRow = {
  ticker: string
  date: string
  stage_code: string | null
  vector_json: string
  feature_json: string | null
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
}

type HistoricalAnchorSimilarRow = SearchRow & {
  date: string
  stage_code: string | null
  vector_json: string
  feature_json: string | null
  close: number | null
  volume: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  physical_momentum_prev_score: number | null
  physics_down_rank: number | null
  physics_down_score: number | null
  ml_up_count: number | null
  ml_down_count: number | null
  ml_similar_count: number | null
  ml_top_similarity: number | null
}

type ModelEvaluationRow = {
  evaluation_date: string
  direction: 'up' | 'down'
  horizon_days: number
  sample_count: number
  precision_at_20: number | null
  precision_at_50: number | null
  hit_rate: number | null
  metrics_json: string
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ticker = value.trim().toUpperCase().replace(/\.T$/i, '')
  return /^[0-9A-Z]{1,8}$/.test(ticker) ? ticker : null
}

function clampLimit(value: unknown, fallback = 8, max = 30): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}

function stageCode(row: {
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}): string | null {
  const values = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  if (values.every((v) => v == null)) return null
  return values.map((v) => (v == null ? '-' : String(v))).join('')
}

function pctChange(close: number | null, prevClose: number | null): number | null {
  if (close == null || prevClose == null || prevClose <= 0) return null
  return ((close - prevClose) / prevClose) * 100
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function fmtLift(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function fmtPrice(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 1 : 2 })
}

function fmtVolume(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function vectorDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let sum = 0
  let used = 0
  for (let i = 0; i < length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const diff = a[i] - b[i]
    sum += diff * diff
    used += 1
  }
  return used === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sum / used)
}

function averageVectors(vectors: number[][]): number[] {
  const width = vectors.reduce((max, vector) => Math.max(max, vector.length), 0)
  const sums = new Array<number>(width).fill(0)
  const counts = new Array<number>(width).fill(0)
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) {
      const value = vector[i]
      if (!Number.isFinite(value)) continue
      sums[i] += value
      counts[i] += 1
    }
  }
  return sums.map((sum, i) => counts[i] > 0 ? sum / counts[i] : Number.NaN)
}

function numberFrom(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readNestedNumber(value: unknown, path: string[]): number | null {
  let current: unknown = value
  for (const key of path) {
    const record = readRecord(current)
    if (!record || !(key in record)) return null
    current = record[key]
  }
  return numberFrom(current)
}

function clampTradingDays(value: unknown, fallback = 60): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(180, Math.max(10, Math.round(n)))
}

function isoDateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function historicalCommonPoints(feature: Record<string, unknown>, anchorFeature?: Record<string, unknown>): string[] {
  const points: string[] = []
  const stage = typeof feature.stageCode === 'string' ? feature.stageCode : null
  if (stage) points.push(`6桁ステージ ${stage}`)

  const sma5Velocity = readNestedNumber(feature, ['velocities', 'sma5', 'd5'])
  const sma25Velocity = readNestedNumber(feature, ['velocities', 'sma25', 'd5'])
  const sma75Velocity = readNestedNumber(feature, ['velocities', 'sma75', 'd5'])
  if (sma5Velocity != null && sma5Velocity < 0) points.push('5日線低下')
  if (sma25Velocity != null && sma25Velocity < 0) points.push('25日線低下')
  if (sma75Velocity != null && sma75Velocity < 0) points.push('75日線鈍化/低下')

  const priceToSma5 = readNestedNumber(feature, ['pricePosition', 'sma5'])
  const priceToSma25 = readNestedNumber(feature, ['pricePosition', 'sma25'])
  if (priceToSma5 != null && priceToSma5 < 0) points.push('価格が5日線下')
  if (priceToSma25 != null && priceToSma25 < 0) points.push('価格が25日線下')

  const bundleVelocity5 = numberFrom(feature.bundleWidthVelocity5)
  const bundleVelocity10 = numberFrom(feature.bundleWidthVelocity10)
  if ((bundleVelocity5 != null && bundleVelocity5 < 0) || (bundleVelocity10 != null && bundleVelocity10 < 0)) {
    points.push('MA束収縮')
  }

  const shortGapVelocity = readNestedNumber(feature, ['gapVelocity', 'sma5To25D5'])
  if (shortGapVelocity != null && shortGapVelocity < 0) points.push('短期線が中期線へ収縮')

  const anchorStage = anchorFeature && typeof anchorFeature.stageCode === 'string' ? anchorFeature.stageCode : null
  if (anchorStage && stage && stage.slice(0, 2) === anchorStage.slice(0, 2)) {
    points.push('日足ステージ構造が近い')
  }

  return Array.from(new Set(points)).slice(0, 5)
}

function evidenceFromEvaluation(row: ModelEvaluationRow): AssistantModelEvidence {
  const metrics = parseJson<Record<string, unknown>>(row.metrics_json, {})
  const baseline = readRecord(metrics.baseline)
  const top60 = readRecord(metrics.top60)
  return {
    direction: row.direction === 'down' ? 'down' : 'up',
    horizonDays: Number(row.horizon_days),
    evaluationDate: row.evaluation_date,
    sampleCount: Number(row.sample_count),
    baselineHitRate: numberFrom(baseline?.hitRate ?? row.hit_rate),
    top60HitRate: numberFrom(top60?.hitRate ?? row.precision_at_50),
    top60AdverseRate: numberFrom(top60?.adverseRate),
    top60AvgDirectionalReturnPct: numberFrom(top60?.avgDirectionalReturnPct),
    liftTop60VsBaseline: numberFrom(metrics.liftTop60VsBaseline),
    split: typeof metrics.split === 'string' ? metrics.split : null,
  }
}

async function fetchObjectiveEvidenceForHorizon(horizonDays: number): Promise<Map<'up' | 'down', AssistantModelEvidence>> {
  const rows = await execAll<ModelEvaluationRow>(
    `
    SELECT evaluation_date, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, hit_rate, metrics_json
    FROM ml_model_evaluations
    WHERE direction IN ('up', 'down')
      AND horizon_days = ?
      AND model_type LIKE '%objective%holdout%'
      AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
    ORDER BY direction ASC,
             CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
             evaluation_date DESC,
             created_at DESC
    `,
    [horizonDays],
  )
  const map = new Map<'up' | 'down', AssistantModelEvidence>()
  for (const row of rows) {
    const direction = row.direction === 'down' ? 'down' : 'up'
    if (!map.has(direction)) map.set(direction, evidenceFromEvaluation(row))
  }
  return map
}

function evidenceSummary(evidence: AssistantModelEvidence): string {
  const direction = evidence.direction === 'down' ? '下落' : '上昇'
  const parts = [
    `${direction}${evidence.horizonDays}日`,
    `top60 ${fmtRate(evidence.top60HitRate)}`,
    `lift ${fmtLift(evidence.liftTop60VsBaseline)}`,
    evidence.top60AdverseRate == null ? null : `逆行 ${fmtRate(evidence.top60AdverseRate)}`,
  ].filter(Boolean)
  return parts.join(' ')
}

function stockHref(ticker: string): string {
  return `/stock/${encodeURIComponent(ticker)}`
}

function usStockHref(ticker: string): string {
  return `/us/stock/${encodeURIComponent(ticker)}`
}

function rowFromOverview(
  row: StockOverviewRow,
  evidenceMap?: Map<'up' | 'down', AssistantModelEvidence>,
  market: 'JP' | 'US' = 'JP',
): AssistantResultRow {
  const code = stageCode(row)
  const changePct = pctChange(row.close, row.prev_close)
  const upEvidence = row.physics_up_rank ? evidenceMap?.get('up') ?? null : null
  const downEvidence = row.physics_down_rank ? evidenceMap?.get('down') ?? null : null
  const modelEvidence = [upEvidence, downEvidence].filter((item): item is AssistantModelEvidence => Boolean(item))
  const shortTerm = buildShortTermCheck({
    stages: {
      dailyA: row.daily_a_stage,
      dailyB: row.daily_b_stage,
      weeklyA: row.weekly_a_stage,
      weeklyB: row.weekly_b_stage,
      monthlyA: row.monthly_a_stage,
      monthlyB: row.monthly_b_stage,
    },
    physicalMomentumScore: row.physical_momentum_score,
    physicalForceScore: row.physical_force_score,
    changePercent: changePct,
    mlUpCount: row.ml_up_count,
    mlDownCount: row.ml_down_count,
    mlSimilarCount: row.ml_similar_count,
    mlTopSimilarity: row.ml_top_similarity,
  })
  const reasonParts = [
    code ? `6桁ステージ ${code}` : null,
    shortTerm.label ? `短期 ${shortTerm.label}` : null,
    row.physical_momentum_score != null ? `PMS ${row.physical_momentum_score.toFixed(2)}` : null,
    row.physical_force_score != null ? `PFS ${row.physical_force_score.toFixed(2)}` : null,
    row.physics_up_rank ? `物理ML上昇#${row.physics_up_rank}` : null,
    row.physics_down_rank ? `物理ML下落#${row.physics_down_rank}` : null,
    ...modelEvidence.map((item) => `過去検証 ${evidenceSummary(item)}`),
    row.ml_similar_count ? `類似ML ${row.ml_similar_count}件/最高${fmtRate(row.ml_top_similarity)}` : null,
    row.avg_volume_30d ? `30日平均出来高 ${Math.round(row.avg_volume_30d).toLocaleString()}` : null,
  ].filter(Boolean)
  return {
    ticker: row.ticker,
    name: row.name,
    href: market === 'US' ? usStockHref(row.ticker) : stockHref(row.ticker),
    date: row.date,
    price: row.close,
    changePct,
    volume: row.volume,
    avgVolume30d: row.avg_volume_30d,
    stageCode: code,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    marketSegment: row.market_segment,
    marginType: row.margin_type,
    score: row.physics_up_score ?? row.physics_down_score ?? null,
    physicalMomentumScore: row.physical_momentum_score,
    physicalForceScore: row.physical_force_score,
    physicalEnergyScore: row.physical_energy_score,
    shortTermCheckLabel: shortTerm.label,
    shortTermCheckScore: shortTerm.score,
    mlEvidenceSummary: row.ml_similar_count
      ? `ML類似 ${row.ml_similar_count}件、上昇類似${row.ml_up_count ?? 0}件、下落類似${row.ml_down_count ?? 0}件、最高類似度${fmtRate(row.ml_top_similarity)}`
      : null,
    modelEvidence,
    reason: reasonParts.join(' / ') || null,
  }
}

function rowFromWeeklyBearishBreak(row: WeeklyBearishBreakRow, evidenceMap?: Map<'up' | 'down', AssistantModelEvidence>): AssistantResultRow {
  const code = stageCode(row)
  const weeklyChangePct = pctChange(row.week_close, row.week_open)
  const downEvidence = row.physics_down_rank ? evidenceMap?.get('down') ?? null : null
  const modelEvidence = [downEvidence].filter((item): item is AssistantModelEvidence => Boolean(item))
  const maCrossText = [
    `5週線 ${fmtPrice(row.ma5)}`,
    `10週線 ${fmtPrice(row.ma10)}`,
    `25週線 ${fmtPrice(row.ma25)}`,
  ].join(' / ')
  const slopeText = [
    `5週 ${fmtPct(row.ma5_slope_pct)}`,
    `10週 ${fmtPct(row.ma10_slope_pct)}`,
    `25週 ${fmtPct(row.ma25_slope_pct)}`,
  ].join(' / ')
  const momentumTrend = row.physical_momentum_score != null && row.physical_momentum_prev_score != null
    ? row.physical_momentum_score < row.physical_momentum_prev_score
      ? 'PMS低下'
      : 'PMS横ばい以上'
    : null
  const reasonParts = [
    `週足陰線 ${row.week_start}〜${row.week_end}: 始値 ${fmtPrice(row.week_open)} → 終値 ${fmtPrice(row.week_close)} (${fmtPct(weeklyChangePct)})`,
    `高値/始値側が5週・10週線上、終値が両線下: ${maCrossText}`,
    `20日平均出来高 ${fmtVolume(row.avg_volume_20d)}株`,
    `週MA傾き ${slopeText}`,
    row.physical_momentum_score != null ? `PMS ${row.physical_momentum_score.toFixed(2)}` : null,
    row.physical_force_score != null ? `PFS ${row.physical_force_score.toFixed(2)}` : null,
    momentumTrend,
    row.physics_down_rank ? `物理ML下落#${row.physics_down_rank}` : null,
    row.physics_up_rank ? `物理ML上昇#${row.physics_up_rank}` : null,
    ...modelEvidence.map((item) => `過去検証 ${evidenceSummary(item)}`),
    row.ml_similar_count ? `類似ML 下落${row.ml_down_count ?? 0}件/上昇${row.ml_up_count ?? 0}件` : null,
  ].filter(Boolean)

  return {
    ticker: row.ticker,
    name: row.name,
    href: stockHref(row.ticker),
    date: row.week_end,
    price: row.week_close,
    changePct: weeklyChangePct,
    volume: row.week_volume,
    avgVolume20d: row.avg_volume_20d,
    stageCode: code,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    marketSegment: row.market_segment,
    marginType: row.margin_type,
    rank: row.physics_down_rank,
    score: row.bearish_score,
    physicalMomentumScore: row.physical_momentum_score,
    physicalForceScore: row.physical_force_score,
    physicalEnergyScore: row.physical_energy_score,
    weeklyDate: row.week_end,
    weeklyOpen: row.week_open,
    weeklyHigh: row.week_high,
    weeklyLow: row.week_low,
    weeklyClose: row.week_close,
    weeklyMa5: row.ma5,
    weeklyMa10: row.ma10,
    weeklyMa25: row.ma25,
    weeklyMa5SlopePct: row.ma5_slope_pct,
    weeklyMa10SlopePct: row.ma10_slope_pct,
    weeklyMa25SlopePct: row.ma25_slope_pct,
    mlEvidenceSummary: row.ml_similar_count
      ? `ML類似 ${row.ml_similar_count}件、下落類似${row.ml_down_count ?? 0}件、上昇類似${row.ml_up_count ?? 0}件、最高類似度${fmtRate(row.ml_top_similarity)}`
      : null,
    modelEvidence,
    direction: 'down',
    reason: reasonParts.join(' / ') || null,
  }
}

async function latestSnapshotDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM daily_snapshots`))?.date ?? null
}

async function latestPhysicsDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates`))?.date ?? null
}

async function latestClassicMlDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`))?.date ?? null
}

async function latestUsDate(table: string, column: 'date' | 'as_of_date'): Promise<string | null> {
  if (!hasUsAnalyticsDb()) return null
  return (await execUsAnalyticsGet<{ date: string | null }>(
    `SELECT MAX(${column}) AS date FROM ${table}`,
  ))?.date ?? null
}

async function searchUsStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const query = (call.query ?? call.ticker ?? '').trim().toUpperCase()
  if (!query) {
    return { tool: 'search_stocks', title: '米国株検索', summary: '検索語が不足しています。', rows: [] }
  }
  if (!hasUsAnalyticsDb()) {
    return { tool: 'search_stocks', title: '米国株検索', summary: 'US分析DBを利用できません。', rows: [] }
  }
  const escaped = query.replace(/[%_]/g, (m) => `\\${m}`)
  const rows = await execUsAnalyticsAll<SearchRow>(
    `
    SELECT ticker, name, sector17_name, sector33_name, market_segment, margin_type
    FROM ticker_universe
    WHERE active = 1
      AND (UPPER(ticker) LIKE ? ESCAPE '\\' OR UPPER(COALESCE(name, '')) LIKE ? ESCAPE '\\')
    ORDER BY CASE WHEN ticker = ? THEN 0 ELSE 1 END, ticker ASC
    LIMIT ?
    `,
    [`%${escaped}%`, `%${escaped}%`, query, clampLimit(call.limit, 8, 20)],
  )
  return {
    tool: 'search_stocks',
    title: '米国株検索',
    summary: `${query} に一致する米国株を ${rows.length} 件見つけました。`,
    href: '/us/screener',
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      href: usStockHref(row.ticker),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      reason: [row.market_segment, row.sector17_name, row.sector33_name].filter(Boolean).join(' / ') || null,
    })),
    meta: { market: 'US' },
  }
}

export async function searchStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  if (call.market === 'US') return searchUsStocks(call)
  const query = (call.query ?? call.ticker ?? '').trim()
  if (!query) {
    return { tool: 'search_stocks', title: '銘柄検索', summary: '検索語が不足しています。', rows: [] }
  }
  const escaped = query.replace(/[%_]/g, (m) => `\\${m}`)
  const rows = await execAll<SearchRow>(
    `
    SELECT ticker, name, sector17_name, sector33_name, market_segment, margin_type
    FROM ticker_universe
    WHERE active = 1
      AND (ticker LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
    ORDER BY CASE WHEN ticker = ? THEN 0 ELSE 1 END, ticker ASC
    LIMIT ?
    `,
    [`%${escaped}%`, `%${escaped}%`, query, clampLimit(call.limit, 8, 20)],
  )
  return {
    tool: 'search_stocks',
    title: '銘柄検索',
    summary: `${query} に一致する銘柄を ${rows.length} 件見つけました。`,
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      href: stockHref(row.ticker),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      marginType: row.margin_type,
      reason: [row.sector17_name, row.sector33_name, row.margin_type].filter(Boolean).join(' / ') || null,
    })),
  }
}

async function getUsStockOverview(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const ticker = normalizeTicker(call.ticker)
  if (!ticker) {
    return { tool: 'get_stock_overview', title: '米国株個別分析', summary: 'ティッカーが不足しています。', rows: [] }
  }
  if (!hasUsAnalyticsDb()) {
    return { tool: 'get_stock_overview', title: '米国株個別分析', summary: 'US分析DBを利用できません。', rows: [] }
  }
  const horizonDays = Number(call.horizonDays ?? 20)
  const [snapshotDate, physicsDate, classicDate] = await Promise.all([
    latestUsDate('daily_snapshots', 'date'),
    latestUsDate('serving_ml_physics_candidates', 'as_of_date'),
    latestUsDate('serving_ml_candidates', 'as_of_date'),
  ])
  if (!snapshotDate) {
    return { tool: 'get_stock_overview', title: '米国株個別分析', summary: 'US日次スナップショットが未作成です。', rows: [] }
  }
  const row = await execUsAnalyticsGet<StockOverviewRow>(
    `
    WITH prices AS (
      SELECT close, volume, date,
             ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
      FROM ohlcv_daily
      WHERE ticker = ? AND date <= ?
    ),
    avg_volume AS (
      SELECT AVG(volume) AS avg_volume_30d FROM prices WHERE rn <= 30
    ),
    ml_summary AS (
      SELECT
        base_ticker,
        SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS ml_up_count,
        SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS ml_down_count,
        COUNT(*) AS ml_similar_count,
        MAX(similarity_score) AS ml_top_similarity
      FROM serving_current_similars
      WHERE as_of_date = (SELECT MAX(as_of_date) FROM serving_current_similars)
        AND base_ticker = ?
      GROUP BY base_ticker
    )
    SELECT
      u.ticker, u.name, u.sector17_name, u.sector33_name, u.market_segment, u.margin_type,
      ds.date,
      cur.close,
      prev.close AS prev_close,
      cur.volume,
      av.avg_volume_30d,
      ds.daily_a_stage, ds.daily_b_stage,
      ds.weekly_a_stage, ds.weekly_b_stage,
      ds.monthly_a_stage, ds.monthly_b_stage,
      ds.ma_5, ds.ma_25, ds.ma_75, ds.ma_300,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      ms.ml_up_count, ms.ml_down_count, ms.ml_similar_count, ms.ml_top_similarity
    FROM ticker_universe u
    LEFT JOIN daily_snapshots ds ON ds.ticker = u.ticker AND ds.date = ?
    LEFT JOIN prices cur ON cur.rn = 1
    LEFT JOIN prices prev ON prev.rn = 2
    LEFT JOIN avg_volume av ON 1 = 1
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'US' AND pm.symbol = u.ticker AND pm.date = ds.date
    LEFT JOIN physical_momentum_metrics pm_prev
      ON pm_prev.market = 'US' AND pm_prev.symbol = u.ticker AND pm_prev.date = prev.date
    LEFT JOIN ml_summary ms ON ms.base_ticker = u.ticker
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = u.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = u.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = u.ticker AND c_up.as_of_date = ? AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = u.ticker AND c_down.as_of_date = ? AND c_down.direction = 'down'
    WHERE u.ticker = ?
    LIMIT 1
    `,
    [
      ticker,
      snapshotDate,
      ticker,
      snapshotDate,
      physicsDate ?? '',
      horizonDays,
      physicsDate ?? '',
      horizonDays,
      classicDate ?? '',
      classicDate ?? '',
      ticker,
    ],
  )
  if (!row) {
    return { tool: 'get_stock_overview', title: '米国株個別分析', summary: `${ticker} はUSユニバースにありません。`, rows: [] }
  }
  const result = rowFromOverview(row, undefined, 'US')
  return {
    tool: 'get_stock_overview',
    title: `${ticker} 米国株分析`,
    summary: `${row.name ?? ticker} は ${snapshotDate} 時点で ${result.stageCode ?? 'ステージ未判定'}。US専用DBの価格・PMS・MLだけを参照しています。`,
    href: usStockHref(ticker),
    rows: [result],
    meta: { market: 'US', snapshotDate, physicsDate, classicDate, horizonDays },
  }
}

export async function getStockOverview(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  if (call.market === 'US') return getUsStockOverview(call)
  const ticker = normalizeTicker(call.ticker)
  if (!ticker) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: '銘柄コードが不足しています。', rows: [] }
  }
  const horizonDays = Number(call.horizonDays ?? 20)
  const [snapshotDate, physicsDate, classicDate, evidenceMap] = await Promise.all([
    latestSnapshotDate(),
    latestPhysicsDate(),
    latestClassicMlDate(),
    fetchObjectiveEvidenceForHorizon(horizonDays),
  ])
  if (!snapshotDate) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: '日次スナップショットが未作成です。', rows: [] }
  }
  const row = await execGet<StockOverviewRow>(
    `
    WITH prev_date AS (
      SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ? AND date < ?
    ),
    avg_volume AS (
      SELECT AVG(volume) AS avg_volume_30d
      FROM (
        SELECT volume
        FROM ohlcv_daily
        WHERE ticker = ? AND date <= ?
        ORDER BY date DESC
        LIMIT 30
      )
    ),
    latest_similar_date AS (
      SELECT MAX(as_of_date) AS d
      FROM serving_current_similars
    ),
    ml_summary AS (
      SELECT
        base_ticker,
        SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS ml_up_count,
        SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS ml_down_count,
        COUNT(*) AS ml_similar_count,
        MAX(similarity_score) AS ml_top_similarity
      FROM serving_current_similars
      WHERE as_of_date = (SELECT d FROM latest_similar_date)
      GROUP BY base_ticker
    )
    SELECT
      u.ticker,
      u.name,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      ds.date,
      od.close,
      prev.close AS prev_close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      ds.ma_5,
      ds.ma_25,
      ds.ma_75,
      ds.ma_300,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      ms.ml_up_count,
      ms.ml_down_count,
      ms.ml_similar_count,
      ms.ml_top_similarity
    FROM ticker_universe u
    LEFT JOIN daily_snapshots ds ON ds.ticker = u.ticker AND ds.date = ?
    LEFT JOIN ohlcv_daily od ON od.ticker = u.ticker AND od.date = ds.date
    LEFT JOIN prev_date pd ON 1 = 1
    LEFT JOIN ohlcv_daily prev ON prev.ticker = u.ticker AND prev.date = pd.date
    LEFT JOIN avg_volume ON 1 = 1
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'JP' AND pm.symbol = u.ticker AND pm.date = ds.date
    LEFT JOIN physical_momentum_metrics pm_prev
      ON pm_prev.market = 'JP' AND pm_prev.symbol = u.ticker AND pm_prev.date = pd.date
    LEFT JOIN ml_summary ms ON ms.base_ticker = u.ticker
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = u.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = u.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = u.ticker AND c_up.as_of_date = ? AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = u.ticker AND c_down.as_of_date = ? AND c_down.direction = 'down'
    WHERE u.ticker = ?
    LIMIT 1
    `,
    [
      ticker,
      snapshotDate,
      ticker,
      snapshotDate,
      snapshotDate,
      physicsDate ?? '',
      horizonDays,
      physicsDate ?? '',
      horizonDays,
      classicDate ?? '',
      classicDate ?? '',
      ticker,
    ],
  )
  if (!row) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: `${ticker} は見つかりませんでした。`, rows: [] }
  }
  const result = rowFromOverview(row, evidenceMap)
  const directionNote = row.physics_down_rank && (!row.physics_up_rank || row.physics_down_rank < row.physics_up_rank)
    ? `下落警戒の物理ML順位が強めです。`
    : row.physics_up_rank
      ? `上昇候補の物理ML順位があります。`
      : `物理ML候補には入っていません。`
  return {
    tool: 'get_stock_overview',
    title: `${ticker} 個別分析`,
    summary: `${row.name ?? ticker} は ${snapshotDate} 時点で ${result.stageCode ?? 'ステージ未判定'}。${directionNote}`,
    href: stockHref(ticker),
    rows: [result],
    meta: { snapshotDate, physicsDate, classicDate, horizonDays },
  }
}

async function screenUsStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  if (!hasUsAnalyticsDb()) {
    return { tool: 'screen_jp_stocks', title: '米国株スクリーニング', summary: 'US分析DBを利用できません。', rows: [] }
  }
  const horizonDays = Number(call.horizonDays ?? 20)
  const [snapshotDate, physicsDate] = await Promise.all([
    latestUsDate('daily_snapshots', 'date'),
    latestUsDate('serving_ml_physics_candidates', 'as_of_date'),
  ])
  if (!snapshotDate || !physicsDate) {
    return { tool: 'screen_jp_stocks', title: '米国株スクリーニング', summary: 'USスナップショットまたは物理ML候補が未作成です。', rows: [] }
  }
  const direction = call.direction === 'down' ? 'down' : call.direction === 'neutral' ? 'neutral' : 'up'
  const limit = clampLimit(call.limit, 10, 30)
  const where = [
    'ds.date = ?',
    'u.active = 1',
    'od.close >= 0.1',
    'od.volume > 0',
    'prev.close > 0',
    'ABS(100.0 * (od.close - prev.close) / prev.close) <= 100',
    "NOT (LENGTH(ds.ticker) >= 5 AND SUBSTR(ds.ticker, -1, 1) IN ('W', 'U', 'R'))",
  ]
  const args: Array<string | number> = [snapshotDate]
  if (call.marketSegment?.trim()) {
    where.push('u.market_segment = ?')
    args.push(call.marketSegment.trim())
  }
  if (call.sector17?.trim()) {
    where.push('u.sector17_name = ?')
    args.push(call.sector17.trim())
  }
  const minAvgVolume = Number(call.minAvgVolume ?? 0)
  if (Number.isFinite(minAvgVolume) && minAvgVolume > 0) {
    where.push('av.avg_volume_30d >= ?')
    args.push(minAvgVolume)
  }
  const pmsMin = Number(call.pmsMin ?? Number.NaN)
  const pfsMin = Number(call.pfsMin ?? Number.NaN)
  const pesMin = Number(call.pesMin ?? Number.NaN)
  if (Number.isFinite(pmsMin)) {
    where.push('pm.physical_momentum_score >= ?')
    args.push(pmsMin)
  }
  if (Number.isFinite(pfsMin)) {
    where.push('pm.physical_force_score >= ?')
    args.push(pfsMin)
  }
  if (Number.isFinite(pesMin)) {
    where.push('pm.physical_energy_score >= ?')
    args.push(pesMin)
  }
  if (call.pmsTrend === 'rising') where.push('pm.physical_momentum_score > pm_prev.physical_momentum_score')
  if (call.pmsTrend === 'falling') where.push('pm.physical_momentum_score < pm_prev.physical_momentum_score')
  if (direction === 'up') where.push('candidate.direction = \'up\'')
  if (direction === 'down') where.push('candidate.direction = \'down\'')
  const orderBy = call.sort === 'pfs'
    ? 'pm.physical_force_score DESC'
    : call.sort === 'pms'
      ? 'pm.physical_momentum_score DESC'
      : direction === 'neutral'
        ? 'av.avg_volume_30d DESC'
        : 'candidate.rank ASC'
  const rows = await execUsAnalyticsAll<ScreenRow>(
    `
    WITH prev_date AS (
      SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?
    ),
    recent_dates AS (
      SELECT DISTINCT date
      FROM ohlcv_daily
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT 30
    ),
    avg_volume AS (
      SELECT ticker, AVG(volume) AS avg_volume_30d
      FROM ohlcv_daily
      WHERE date IN (SELECT date FROM recent_dates)
      GROUP BY ticker
    )
    SELECT
      u.ticker, u.name, u.sector17_name, u.sector33_name, u.market_segment, u.margin_type,
      ds.date, od.close, prev.close AS prev_close, od.volume, av.avg_volume_30d,
      ds.daily_a_stage, ds.daily_b_stage,
      ds.weekly_a_stage, ds.weekly_b_stage,
      ds.monthly_a_stage, ds.monthly_b_stage,
      ds.ma_5, ds.ma_25, ds.ma_75, ds.ma_300,
      CASE WHEN candidate.direction = 'up' THEN candidate.rank END AS physics_up_rank,
      CASE WHEN candidate.direction = 'up' THEN candidate.candidate_score END AS physics_up_score,
      CASE WHEN candidate.direction = 'down' THEN candidate.rank END AS physics_down_rank,
      CASE WHEN candidate.direction = 'down' THEN candidate.candidate_score END AS physics_down_score,
      NULL AS classic_up_rank, NULL AS classic_down_rank,
      pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      NULL AS ml_up_count, NULL AS ml_down_count, NULL AS ml_similar_count, NULL AS ml_top_similarity
    FROM daily_snapshots ds
    INNER JOIN ticker_universe u ON u.ticker = ds.ticker
    LEFT JOIN ohlcv_daily od ON od.ticker = ds.ticker AND od.date = ds.date
    LEFT JOIN ohlcv_daily prev ON prev.ticker = ds.ticker AND prev.date = (SELECT date FROM prev_date)
    LEFT JOIN avg_volume av ON av.ticker = ds.ticker
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'US' AND pm.symbol = ds.ticker AND pm.date = ds.date
    LEFT JOIN physical_momentum_metrics pm_prev
      ON pm_prev.market = 'US' AND pm_prev.symbol = ds.ticker AND pm_prev.date = prev.date
    LEFT JOIN serving_ml_physics_candidates candidate
      ON candidate.ticker = ds.ticker
     AND candidate.as_of_date = ?
     AND candidate.horizon_days = ?
     AND candidate.direction = ?
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}, ds.ticker ASC
    LIMIT ?
    `,
    [
      snapshotDate,
      snapshotDate,
      physicsDate,
      horizonDays,
      direction === 'neutral' ? 'up' : direction,
      ...args,
      limit,
    ],
  )
  const title = direction === 'down' ? '米国株 下落警戒候補' : direction === 'up' ? '米国株 上昇候補' : '米国株スクリーニング'
  return {
    tool: 'screen_jp_stocks',
    title,
    summary: `${snapshotDate} 時点のUS専用データから ${rows.length} 件抽出しました。価格0・出来高0は除外しています。`,
    href: `/us/screener?sort=${call.sort === 'pfs' ? 'pfs' : call.sort === 'pms' ? 'pms' : 'volume'}&dir=desc`,
    rows: rows.map((row) => ({
      ...rowFromOverview(row, undefined, 'US'),
      rank: direction === 'down' ? row.physics_down_rank : row.physics_up_rank,
      direction,
    })),
    meta: { market: 'US', snapshotDate, physicsDate, horizonDays },
  }
}

export async function screenJpStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  if (call.market === 'US') return screenUsStocks(call)
  const horizonDays = Number(call.horizonDays ?? 20)
  const [snapshotDate, physicsDate, classicDate, evidenceMap] = await Promise.all([
    latestSnapshotDate(),
    latestPhysicsDate(),
    latestClassicMlDate(),
    fetchObjectiveEvidenceForHorizon(horizonDays),
  ])
  if (!snapshotDate) {
    return { tool: 'screen_jp_stocks', title: 'スクリーニング', summary: '日次スナップショットが未作成です。', rows: [] }
  }

  const direction = call.direction === 'down' ? 'down' : call.direction === 'neutral' ? 'neutral' : 'up'
  const limit = clampLimit(call.limit, 10, 30)
  const where: string[] = ['ds.date = ?', 'u.active = 1', "COALESCE(u.market_segment, '') <> 'その他'"]
  const args: Array<string | number> = [snapshotDate]
  const universe = universeSqlCondition('ds.ticker', parseUniverseFilter(call.universe))
  if (universe.sql) {
    where.push(universe.sql)
    args.push(...universe.params)
  }
  if (call.marginType?.trim()) {
    where.push('u.margin_type = ?')
    args.push(call.marginType.trim())
  }
  if (call.marketSegment?.trim()) {
    where.push('u.market_segment = ?')
    args.push(call.marketSegment.trim())
  }
  if (call.sector17?.trim()) {
    where.push('u.sector17_name = ?')
    args.push(call.sector17.trim())
  }
  if (call.stageCode?.trim() && /^[1-6-]{1,6}$/.test(call.stageCode.trim())) {
    const code = call.stageCode.trim()
    const cols = ['daily_a_stage', 'daily_b_stage', 'weekly_a_stage', 'weekly_b_stage', 'monthly_a_stage', 'monthly_b_stage']
    code.split('').forEach((ch, index) => {
      if (ch === '-' || !cols[index]) return
      where.push(`ds.${cols[index]} = ?`)
      args.push(Number(ch))
    })
  }
  const minAvgVolume = Number(call.minAvgVolume ?? 0)
  if (Number.isFinite(minAvgVolume) && minAvgVolume > 0) {
    where.push('avg_volume.avg_volume_30d >= ?')
    args.push(minAvgVolume)
  }
  const pmsMin = Number(call.pmsMin ?? Number.NaN)
  const pfsMin = Number(call.pfsMin ?? Number.NaN)
  const pesMin = Number(call.pesMin ?? Number.NaN)
  if (Number.isFinite(pmsMin)) {
    where.push('pm.physical_momentum_score >= ?')
    args.push(pmsMin)
  }
  if (Number.isFinite(pfsMin)) {
    where.push('pm.physical_force_score >= ?')
    args.push(pfsMin)
  }
  if (Number.isFinite(pesMin)) {
    where.push('pm.physical_energy_score >= ?')
    args.push(pesMin)
  }
  if (call.pmsTrend === 'rising') where.push('pm.physical_momentum_score > pm_prev.physical_momentum_score')
  if (call.pmsTrend === 'falling') where.push('pm.physical_momentum_score < pm_prev.physical_momentum_score')
  if (direction === 'up') where.push('p_up.rank IS NOT NULL')
  if (direction === 'down') where.push('p_down.rank IS NOT NULL')

  const orderBy = call.sort === 'pfs'
    ? 'pm.physical_force_score DESC, pm.physical_momentum_score DESC, avg_volume.avg_volume_30d DESC'
    : call.sort === 'pms'
      ? 'pm.physical_momentum_score DESC, pm.physical_force_score DESC, avg_volume.avg_volume_30d DESC'
      : direction === 'down'
    ? 'p_down.rank ASC, p_down.candidate_score DESC, avg_volume.avg_volume_30d DESC'
    : direction === 'up'
      ? 'p_up.rank ASC, p_up.candidate_score DESC, avg_volume.avg_volume_30d DESC'
      : call.sort === 'volume'
        ? 'avg_volume.avg_volume_30d DESC'
        : 'ABS(COALESCE(od.close - prev.close, 0)) DESC'

  const rows = await execAll<ScreenRow>(
    `
    WITH prev_dates AS (
      SELECT ticker, MAX(date) AS prev_date
      FROM ohlcv_daily
      WHERE date < ?
      GROUP BY ticker
    ),
    avg_volume AS (
        SELECT ticker, AVG(volume) AS avg_volume_30d
      FROM (
        SELECT ticker, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM ohlcv_daily
        WHERE date <= ?
      )
      WHERE rn <= 30
      GROUP BY ticker
    ),
    latest_similar_date AS (
      SELECT MAX(as_of_date) AS d
      FROM serving_current_similars
    ),
    ml_summary AS (
      SELECT
        base_ticker,
        SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS ml_up_count,
        SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS ml_down_count,
        COUNT(*) AS ml_similar_count,
        MAX(similarity_score) AS ml_top_similarity
      FROM serving_current_similars
      WHERE as_of_date = (SELECT d FROM latest_similar_date)
      GROUP BY base_ticker
    )
    SELECT
      u.ticker,
      u.name,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      ds.date,
      od.close,
      prev.close AS prev_close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      ds.ma_5,
      ds.ma_25,
      ds.ma_75,
      ds.ma_300,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      ms.ml_up_count,
      ms.ml_down_count,
      ms.ml_similar_count,
      ms.ml_top_similarity
    FROM daily_snapshots ds
    INNER JOIN ticker_universe u ON u.ticker = ds.ticker
    LEFT JOIN ohlcv_daily od ON od.ticker = ds.ticker AND od.date = ds.date
    LEFT JOIN prev_dates pd ON pd.ticker = ds.ticker
    LEFT JOIN ohlcv_daily prev ON prev.ticker = ds.ticker AND prev.date = pd.prev_date
    LEFT JOIN avg_volume ON avg_volume.ticker = ds.ticker
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'JP' AND pm.symbol = ds.ticker AND pm.date = ds.date
    LEFT JOIN physical_momentum_metrics pm_prev
      ON pm_prev.market = 'JP' AND pm_prev.symbol = ds.ticker AND pm_prev.date = pd.prev_date
    LEFT JOIN ml_summary ms ON ms.base_ticker = ds.ticker
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = ds.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = ds.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = ds.ticker AND c_up.as_of_date = ? AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = ds.ticker AND c_down.as_of_date = ? AND c_down.direction = 'down'
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}, ds.ticker ASC
    LIMIT ?
    `,
    [
      snapshotDate,
      snapshotDate,
      physicsDate ?? '',
      horizonDays,
      physicsDate ?? '',
      horizonDays,
      classicDate ?? '',
      classicDate ?? '',
      ...args,
      limit,
    ],
  )
  const hrefParams = new URLSearchParams()
  hrefParams.set('limit', String(limit))
  if (call.universe) hrefParams.set('universe', call.universe)
  if (call.marginType) hrefParams.set('marginType', call.marginType)
  if (call.marketSegment) hrefParams.set('segment', call.marketSegment)
  if (minAvgVolume > 0) hrefParams.set('volumeMin', String(Math.floor(minAvgVolume)))
  if (Number.isFinite(pmsMin)) hrefParams.set('pmsMin', String(pmsMin))
  if (Number.isFinite(pfsMin)) hrefParams.set('pfsMin', String(pfsMin))
  if (Number.isFinite(pesMin)) hrefParams.set('pesMin', String(pesMin))
  if (call.pmsTrend) hrefParams.set('pmsTrend', call.pmsTrend)
  hrefParams.set('sort', call.sort === 'pfs' ? 'physicalForceScore' : call.sort === 'pms' ? 'physicalMomentumScore' : call.sort === 'short_term' ? 'shortTermCheckScore' : call.sort === 'volume' ? 'avgVolume30d' : 'volume')
  hrefParams.set('dir', 'desc')
  const title = direction === 'down' ? '下落警戒候補' : direction === 'up' ? '上昇候補' : 'スクリーニング候補'
  const mappedRows = rows.map((row) => ({
    ...rowFromOverview(row, evidenceMap),
    rank: direction === 'down' ? row.physics_down_rank : row.physics_up_rank,
    direction,
    score: direction === 'down' ? row.physics_down_score : row.physics_up_score,
  }))
  const filteredRows = call.shortTermCheck
    ? mappedRows.filter((row) => row.shortTermCheckLabel === call.shortTermCheck)
    : mappedRows
  const finalRows = call.sort === 'short_term'
    ? [...filteredRows].sort((a, b) => (b.shortTermCheckScore ?? -Infinity) - (a.shortTermCheckScore ?? -Infinity)).slice(0, limit)
    : filteredRows
  return {
    tool: 'screen_jp_stocks',
    title,
    summary: `${snapshotDate} 時点で ${title} を ${finalRows.length} 件抽出しました。${call.universe ? '日経225に限定しています。' : ''}`,
    href: `/screener?${hrefParams.toString()}`,
    rows: finalRows,
    meta: { snapshotDate, physicsDate, classicDate, horizonDays },
  }
}

export async function scanWeeklyBearishMaBreaks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const horizonDays = Number(call.horizonDays ?? 20)
  const limit = clampLimit(call.limit, 20, 30)
  const minAvgVolume = Number(call.minAvgVolume ?? 1_000_000)
  const [snapshotDate, physicsDate, evidenceMap] = await Promise.all([
    latestSnapshotDate(),
    latestPhysicsDate(),
    fetchObjectiveEvidenceForHorizon(horizonDays),
  ])
  if (!snapshotDate) {
    return {
      tool: 'scan_weekly_bearish_ma_breaks',
      title: '週足陰線 5/10週線下抜け',
      summary: '日次スナップショットが未作成です。',
      rows: [],
    }
  }

  const liquidWhere: string[] = [
    'a.avg_volume_20d >= ?',
    'u.active = 1',
    "COALESCE(u.market_segment, '') <> 'その他'",
  ]
  const args: Array<string | number> = [Number.isFinite(minAvgVolume) && minAvgVolume > 0 ? minAvgVolume : 1_000_000]
  const universe = universeSqlCondition('a.ticker', parseUniverseFilter(call.universe))
  if (universe.sql) {
    liquidWhere.push(universe.sql)
    args.push(...universe.params)
  }

  const rows = await execAll<WeeklyBearishBreakRow>(
    `
    WITH latest AS (
      SELECT MAX(date) AS latest_date FROM ohlcv_daily
    ),
    recent_volume AS (
      SELECT od.ticker, od.volume,
             ROW_NUMBER() OVER (PARTITION BY od.ticker ORDER BY od.date DESC) AS rn
      FROM ohlcv_daily od, latest
      WHERE od.date <= latest.latest_date
        AND od.date >= date(latest.latest_date, '-70 day')
    ),
    avg20 AS (
      SELECT ticker, AVG(volume) AS avg_volume_20d
      FROM recent_volume
      WHERE rn <= 20
      GROUP BY ticker
    ),
    liquid AS (
      SELECT a.ticker, a.avg_volume_20d
      FROM avg20 a
      INNER JOIN ticker_universe u ON u.ticker = a.ticker
      WHERE ${liquidWhere.join(' AND ')}
    ),
    weekly_source AS (
      SELECT od.ticker, od.date, od.open, od.high, od.low, od.close, od.volume,
             strftime('%Y-%W', od.date) AS week_key,
             ROW_NUMBER() OVER (PARTITION BY od.ticker, strftime('%Y-%W', od.date) ORDER BY od.date ASC) AS rn_open,
             ROW_NUMBER() OVER (PARTITION BY od.ticker, strftime('%Y-%W', od.date) ORDER BY od.date DESC) AS rn_close
      FROM ohlcv_daily od
      INNER JOIN liquid l ON l.ticker = od.ticker
      INNER JOIN latest ON 1 = 1
      WHERE od.date <= latest.latest_date
        AND od.date >= date(latest.latest_date, '-460 day')
    ),
    weekly AS (
      SELECT ticker,
             week_key,
             MIN(date) AS week_start,
             MAX(date) AS week_end,
             MAX(CASE WHEN rn_open = 1 THEN open END) AS week_open,
             MAX(high) AS week_high,
             MIN(low) AS week_low,
             MAX(CASE WHEN rn_close = 1 THEN close END) AS week_close,
             SUM(volume) AS week_volume
      FROM weekly_source
      GROUP BY ticker, week_key
    ),
    weekly_ma AS (
      SELECT *,
             AVG(week_close) OVER (PARTITION BY ticker ORDER BY week_end ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma5,
             AVG(week_close) OVER (PARTITION BY ticker ORDER BY week_end ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) AS ma10,
             AVG(week_close) OVER (PARTITION BY ticker ORDER BY week_end ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS ma25
      FROM weekly
    ),
    lagged AS (
      SELECT *,
             LAG(week_close) OVER (PARTITION BY ticker ORDER BY week_end) AS prev_week_close,
             LAG(ma5) OVER (PARTITION BY ticker ORDER BY week_end) AS prev_ma5,
             LAG(ma10) OVER (PARTITION BY ticker ORDER BY week_end) AS prev_ma10,
             LAG(ma25) OVER (PARTITION BY ticker ORDER BY week_end) AS prev_ma25
      FROM weekly_ma
    ),
    current_week AS (
      SELECT *
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY week_end DESC) AS rn
        FROM lagged
        WHERE ma25 IS NOT NULL
      )
      WHERE rn = 1
    ),
    base AS (
      SELECT w.*,
             l.avg_volume_20d,
             ((w.ma5 - w.prev_ma5) / NULLIF(w.prev_ma5, 0)) * 100 AS ma5_slope_pct,
             ((w.ma10 - w.prev_ma10) / NULLIF(w.prev_ma10, 0)) * 100 AS ma10_slope_pct,
             ((w.ma25 - w.prev_ma25) / NULLIF(w.prev_ma25, 0)) * 100 AS ma25_slope_pct
      FROM current_week w
      INNER JOIN liquid l ON l.ticker = w.ticker
      WHERE w.week_close < w.week_open
        AND w.week_close < w.ma5
        AND w.week_close < w.ma10
        AND w.week_high >= w.ma5
        AND w.week_high >= w.ma10
        AND w.prev_week_close >= w.prev_ma5 * 0.995
        AND w.prev_week_close >= w.prev_ma10 * 0.995
    ),
    prev_dates AS (
      SELECT od.ticker, MAX(od.date) AS prev_date
      FROM ohlcv_daily od
      WHERE od.date < ?
      GROUP BY od.ticker
    ),
    latest_similar_date AS (
      SELECT MAX(as_of_date) AS d
      FROM serving_current_similars
    ),
    ml_summary AS (
      SELECT
        base_ticker,
        SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS ml_up_count,
        SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS ml_down_count,
        COUNT(*) AS ml_similar_count,
        MAX(similarity_score) AS ml_top_similarity
      FROM serving_current_similars
      WHERE as_of_date = (SELECT d FROM latest_similar_date)
      GROUP BY base_ticker
    )
    SELECT
      u.ticker,
      u.name,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      ds.date,
      od.close,
      prev.close AS prev_close,
      od.volume,
      b.avg_volume_20d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      b.week_start,
      b.week_end,
      b.week_open,
      b.week_high,
      b.week_low,
      b.week_close,
      b.week_volume,
      b.ma5,
      b.ma10,
      b.ma25,
      b.prev_week_close,
      b.prev_ma5,
      b.prev_ma10,
      b.prev_ma25,
      b.ma5_slope_pct,
      b.ma10_slope_pct,
      b.ma25_slope_pct,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      ms.ml_up_count,
      ms.ml_down_count,
      ms.ml_similar_count,
      ms.ml_top_similarity,
      (
        CASE WHEN p_down.rank IS NOT NULL THEN 25.0 + 60.0 / (p_down.rank + 5) ELSE 0 END
        - CASE WHEN p_up.rank IS NOT NULL THEN 45.0 / (p_up.rank + 5) ELSE 0 END
        + CASE WHEN pm.physical_force_score < 0 THEN MIN(18.0, ABS(pm.physical_force_score) * 4.0) ELSE 0 END
        + CASE WHEN pm.physical_momentum_score < 0 THEN MIN(14.0, ABS(pm.physical_momentum_score) * 3.0) ELSE 0 END
        + CASE WHEN pm.physical_momentum_score < pm_prev.physical_momentum_score THEN 6 ELSE 0 END
        + CASE WHEN b.ma5_slope_pct < 0 THEN 5 ELSE 0 END
        + CASE WHEN b.ma10_slope_pct < 0 THEN 5 ELSE 0 END
        + CASE WHEN b.ma25_slope_pct < 0 THEN 4 ELSE 0 END
        + CASE WHEN b.week_close < b.ma25 THEN 4 ELSE 0 END
        + CASE WHEN b.week_open > 0 THEN ((b.week_open - b.week_close) / b.week_open) * 30 ELSE 0 END
      ) AS bearish_score
    FROM base b
    INNER JOIN ticker_universe u ON u.ticker = b.ticker
    LEFT JOIN daily_snapshots ds ON ds.ticker = b.ticker AND ds.date = ?
    LEFT JOIN ohlcv_daily od ON od.ticker = b.ticker AND od.date = ds.date
    LEFT JOIN prev_dates pd ON pd.ticker = b.ticker
    LEFT JOIN ohlcv_daily prev ON prev.ticker = b.ticker AND prev.date = pd.prev_date
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'JP' AND pm.symbol = b.ticker AND pm.date = ds.date
    LEFT JOIN physical_momentum_metrics pm_prev
      ON pm_prev.market = 'JP' AND pm_prev.symbol = b.ticker AND pm_prev.date = pd.prev_date
    LEFT JOIN ml_summary ms ON ms.base_ticker = b.ticker
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = b.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = b.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    ORDER BY bearish_score DESC,
             COALESCE(p_down.rank, 9999) ASC,
             pm.physical_force_score ASC,
             b.avg_volume_20d DESC,
             b.ticker ASC
    LIMIT ?
    `,
    [
      ...args,
      snapshotDate,
      snapshotDate,
      physicsDate ?? '',
      horizonDays,
      physicsDate ?? '',
      horizonDays,
      limit,
    ],
  )

  const params = new URLSearchParams()
  params.set('avgVolumeWindow', '20')
  params.set('avgVolumeMin', String(Math.floor(Number.isFinite(minAvgVolume) && minAvgVolume > 0 ? minAvgVolume : 1_000_000)))
  params.set('sort', 'physicalForceScore')
  params.set('dir', 'asc')
  params.set('limit', String(limit))
  if (call.universe) params.set('universe', call.universe)
  return {
    tool: 'scan_weekly_bearish_ma_breaks',
    title: '週足陰線 5/10週線下抜け',
    summary: `${snapshotDate} 時点で、20日平均出来高 ${fmtVolume(Number.isFinite(minAvgVolume) && minAvgVolume > 0 ? minAvgVolume : 1_000_000)}株以上、週足陰線、5週線・10週線を終値で下抜けた候補を ${rows.length} 件抽出しました。`,
    href: `/screener?${params.toString()}`,
    rows: rows.map((row) => rowFromWeeklyBearishBreak(row, evidenceMap)),
    meta: {
      snapshotDate,
      physicsDate,
      horizonDays,
      minAvgVolume,
      weeklyRule: 'bearish candle closes below weekly MA5 and MA10 after trading at or above both averages',
    },
  }
}

export async function findHistoricalAnchorSimilars(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const anchorTicker = normalizeTicker(call.anchorTicker ?? call.ticker)
  if (!anchorTicker) {
    return {
      tool: 'find_historical_anchor_similars',
      title: '過去アンカー類似検索',
      summary: 'アンカーにする銘柄コードが不足しています。',
      rows: [],
    }
  }

  const anchorEndDate = isoDateOrNull(call.anchorEndDate) ?? (anchorTicker === '7003' ? '2026-05-11' : null)
  if (!anchorEndDate) {
    return {
      tool: 'find_historical_anchor_similars',
      title: `${anchorTicker} 過去アンカー類似`,
      summary: 'アンカー終了日が不足しています。例: 2026-05-11 のように指定してください。',
      rows: [],
    }
  }

  const lookbackTradingDays = clampTradingDays(call.lookbackTradingDays, 60)
  const limit = clampLimit(call.limit, 20, 30)
  const horizonDays = Number.isFinite(Number(call.horizonDays)) ? Math.round(Number(call.horizonDays)) : 20
  const excludeAnchorTicker = call.excludeAnchorTicker !== false
  const anchorRows = await execAll<VectorRow>(
    `
    SELECT *
    FROM (
      SELECT
        f.ticker,
        f.date,
        f.stage_code,
        f.vector_json,
        f.feature_json,
        u.name,
        u.sector17_name,
        u.sector33_name
      FROM ml_feature_vectors_v2 f
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.ticker = ?
        AND f.date <= ?
      ORDER BY f.date DESC
      LIMIT ?
    )
    ORDER BY date ASC
    `,
    [ML_PHYSICS_FEATURE_SET, anchorTicker, anchorEndDate, lookbackTradingDays],
  )
  const anchorVectors = anchorRows
    .map((row) => parseJson<number[]>(row.vector_json, []))
    .filter((vector) => vector.some((value) => Number.isFinite(value)))
  const anchorVector = averageVectors(anchorVectors)
  const anchorStartDate = anchorRows[0]?.date ?? null
  const anchorActualEndDate = anchorRows[anchorRows.length - 1]?.date ?? anchorEndDate
  const anchorLatestFeature = parseJson<Record<string, unknown>>(anchorRows[anchorRows.length - 1]?.feature_json, {})

  if (anchorRows.length < Math.min(20, lookbackTradingDays) || anchorVector.length === 0 || !anchorVector.some((value) => Number.isFinite(value))) {
    return {
      tool: 'find_historical_anchor_similars',
      title: `${anchorTicker} 過去アンカー類似`,
      summary: `${anchorTicker} の ${anchorEndDate} 以前に、アンカーとして使える物理特徴量が不足しています。アンカー特徴量不足です。`,
      href: stockHref(anchorTicker),
      rows: [],
      meta: {
        anchorTicker,
        anchorEndDate,
        lookbackTradingDays,
        anchorRows: anchorRows.length,
        featureSet: ML_PHYSICS_FEATURE_SET,
      },
    }
  }

  const latestDate = (await execGet<{ date: string | null }>(
    `
    SELECT MAX(date) AS date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
    `,
    [ML_PHYSICS_FEATURE_SET],
  ))?.date ?? null
  if (!latestDate) {
    return {
      tool: 'find_historical_anchor_similars',
      title: `${anchorTicker} 過去アンカー類似`,
      summary: '比較対象となる現在の物理特徴量がまだ生成されていません。',
      rows: [],
      meta: { anchorTicker, anchorEndDate, lookbackTradingDays, featureSet: ML_PHYSICS_FEATURE_SET },
    }
  }

  const [evidence20, evidence60, candidates] = await Promise.all([
    fetchObjectiveEvidenceForHorizon(20),
    fetchObjectiveEvidenceForHorizon(60),
    execAll<HistoricalAnchorSimilarRow>(
      `
      WITH latest_physics_date AS (
        SELECT MAX(as_of_date) AS d FROM serving_ml_physics_candidates
      ),
      latest_similar_date AS (
        SELECT MAX(as_of_date) AS d FROM serving_current_similars
      ),
      ml_summary AS (
        SELECT
          base_ticker,
          SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS ml_up_count,
          SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS ml_down_count,
          COUNT(*) AS ml_similar_count,
          MAX(similarity_score) AS ml_top_similarity
        FROM serving_current_similars
        WHERE as_of_date = (SELECT d FROM latest_similar_date)
        GROUP BY base_ticker
      )
      SELECT
        f.ticker,
        f.date,
        f.stage_code,
        f.vector_json,
        f.feature_json,
        u.name,
        u.sector17_name,
        u.sector33_name,
        u.market_segment,
        u.margin_type,
        od.close,
        od.volume,
        ds.daily_a_stage,
        ds.daily_b_stage,
        ds.weekly_a_stage,
        ds.weekly_b_stage,
        ds.monthly_a_stage,
        ds.monthly_b_stage,
        pm.physical_momentum_score,
        pm.physical_force_score,
        pm.physical_energy_score,
        pm_prev.physical_momentum_score AS physical_momentum_prev_score,
        p_down.rank AS physics_down_rank,
        p_down.candidate_score AS physics_down_score,
        ms.ml_up_count,
        ms.ml_down_count,
        ms.ml_similar_count,
        ms.ml_top_similarity
      FROM ml_feature_vectors_v2 f
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      LEFT JOIN ohlcv_daily od ON od.ticker = f.ticker AND od.date = f.date
      LEFT JOIN daily_snapshots ds ON ds.ticker = f.ticker AND ds.date = f.date
      LEFT JOIN physical_momentum_metrics pm
        ON pm.market = 'JP' AND pm.symbol = f.ticker AND pm.date = f.date
      LEFT JOIN physical_momentum_metrics pm_prev
        ON pm_prev.market = 'JP'
       AND pm_prev.symbol = f.ticker
       AND pm_prev.date = (
          SELECT MAX(prev_pm.date)
          FROM physical_momentum_metrics prev_pm
          WHERE prev_pm.market = 'JP'
            AND prev_pm.symbol = f.ticker
            AND prev_pm.date < f.date
       )
      LEFT JOIN serving_ml_physics_candidates p_down
        ON p_down.as_of_date = (SELECT d FROM latest_physics_date)
       AND p_down.ticker = f.ticker
       AND p_down.direction = 'down'
       AND p_down.horizon_days = ?
      LEFT JOIN ml_summary ms ON ms.base_ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.date = ?
        AND (? = 0 OR f.ticker <> ?)
        AND COALESCE(u.active, 1) = 1
        AND COALESCE(u.market_segment, '') <> 'その他'
      LIMIT 8000
      `,
      [horizonDays, ML_PHYSICS_FEATURE_SET, latestDate, excludeAnchorTicker ? 1 : 0, anchorTicker],
    ),
  ])

  const downEvidence = [evidence20.get('down'), evidence60.get('down')]
    .filter((item): item is AssistantModelEvidence => Boolean(item))

  const ranked = candidates
    .map((row) => {
      const vector = parseJson<number[]>(row.vector_json, [])
      const distance = vectorDistance(anchorVector, vector)
      const score = Number.isFinite(distance) ? 1 / (1 + distance) : 0
      const feature = parseJson<Record<string, unknown>>(row.feature_json, {})
      return { row, distance, score, feature }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const similarity = b.score - a.score
      if (Math.abs(similarity) > 0.000001) return similarity
      const aRank = a.row.physics_down_rank ?? 999999
      const bRank = b.row.physics_down_rank ?? 999999
      if (aRank !== bRank) return aRank - bRank
      return (a.row.physical_force_score ?? 999999) - (b.row.physical_force_score ?? 999999)
    })
    .slice(0, limit)

  const rows: AssistantResultRow[] = ranked.map((item, index) => {
    const row = item.row
    const code = stageCode(row) ?? (typeof item.feature.stageCode === 'string' ? item.feature.stageCode : row.stage_code)
    const commonPoints = historicalCommonPoints(item.feature, anchorLatestFeature)
    const pmsTrend = row.physical_momentum_score != null && row.physical_momentum_prev_score != null
      ? row.physical_momentum_score < row.physical_momentum_prev_score
        ? 'PMS低下'
        : 'PMS横ばい以上'
      : null
    const reasonParts = [
      `7003当時との形状類似 ${Math.round(item.score * 100)}%`,
      `距離 ${item.distance.toFixed(3)}`,
      commonPoints.length ? `共通点: ${commonPoints.join(' / ')}` : null,
      row.physical_momentum_score != null ? `PMS ${row.physical_momentum_score.toFixed(2)}` : null,
      row.physical_force_score != null ? `PFS ${row.physical_force_score.toFixed(2)}` : null,
      pmsTrend,
      row.physics_down_rank ? `物理ML下落#${row.physics_down_rank}` : null,
      ...downEvidence.map((evidence) => `過去検証 ${evidenceSummary(evidence)}`),
    ].filter(Boolean)
    return {
      ticker: row.ticker,
      name: row.name,
      href: stockHref(row.ticker),
      date: row.date,
      price: row.close,
      volume: row.volume,
      stageCode: code,
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      marginType: row.margin_type,
      rank: index + 1,
      score: item.score,
      physicalMomentumScore: row.physical_momentum_score,
      physicalForceScore: row.physical_force_score,
      physicalEnergyScore: row.physical_energy_score,
      mlEvidenceSummary: `アンカー ${anchorStartDate}〜${anchorActualEndDate} / ${anchorRows.length}営業日 / 形状類似優先${row.ml_similar_count ? ` / 現在ML類似 下落${row.ml_down_count ?? 0}件・上昇${row.ml_up_count ?? 0}件` : ''}`,
      modelEvidence: downEvidence,
      direction: 'down',
      reason: reasonParts.join(' / '),
    }
  })

  const params = new URLSearchParams({
    anchorTicker,
    anchorEndDate,
    lookbackTradingDays: String(lookbackTradingDays),
    mode: 'historical-anchor',
  })
  return {
    tool: 'find_historical_anchor_similars',
    title: `${anchorTicker} 下落前アンカー類似`,
    summary: `${anchorTicker} の ${anchorStartDate}〜${anchorActualEndDate}（${anchorRows.length}営業日）を平均した物理特徴量に近い現在銘柄を ${rows.length} 件抽出しました。ランキングは形状類似優先で、下落リスク情報は補助表示です。`,
    href: `/ai/research?${params.toString()}`,
    rows,
    meta: {
      anchorTicker,
      anchorStartDate,
      anchorEndDate: anchorActualEndDate,
      requestedAnchorEndDate: anchorEndDate,
      lookbackTradingDays,
      latestDate,
      ranking: 'shape_similarity_first',
      featureSet: ML_PHYSICS_FEATURE_SET,
      excludedAnchorTicker: excludeAnchorTicker,
    },
  }
}

export async function getMlSimilars(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const ticker = normalizeTicker(call.ticker)
  if (!ticker) {
    return { tool: 'get_ml_similars', title: 'ML類似銘柄', summary: '銘柄コードが不足しています。', rows: [] }
  }
  if (call.market === 'US') {
    if (!hasUsAnalyticsDb()) {
      return { tool: 'get_ml_similars', title: '米国株ML類似銘柄', summary: 'US分析DBを利用できません。', rows: [] }
    }
    const asOfDate = await latestUsDate('serving_current_similars', 'as_of_date')
    if (!asOfDate) {
      return { tool: 'get_ml_similars', title: '米国株ML類似銘柄', summary: 'US類似データがまだ生成されていません。', rows: [] }
    }
    const rows = await execUsAnalyticsAll<{
      rank: number
      similar_ticker: string
      similarity_score: number
      similar_direction: string | null
      payload_json: string
      reason_json: string
      name: string | null
      sector17_name: string | null
      sector33_name: string | null
      market_segment: string | null
    }>(
      `
      SELECT
        s.rank, s.similar_ticker, s.similarity_score, s.similar_direction,
        s.payload_json, s.reason_json,
        u.name, u.sector17_name, u.sector33_name, u.market_segment
      FROM serving_current_similars s
      LEFT JOIN ticker_universe u ON u.ticker = s.similar_ticker
      WHERE s.as_of_date = ? AND s.base_ticker = ?
      ORDER BY s.rank ASC
      LIMIT ?
      `,
      [asOfDate, ticker, clampLimit(call.limit, 8, 20)],
    )
    return {
      tool: 'get_ml_similars',
      title: `${ticker} に似た米国株`,
      summary: `${asOfDate} 時点のUS物理特徴量・ステージ類似で ${rows.length} 件見つけました。`,
      href: usStockHref(ticker),
      rows: rows.map((row) => {
        const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
        const reason = parseJson<Record<string, unknown>>(row.reason_json, {})
        return {
          ticker: row.similar_ticker,
          name: row.name,
          href: usStockHref(row.similar_ticker),
          rank: row.rank,
          score: row.similarity_score,
          direction: row.similar_direction,
          stageCode: typeof payload.stageCode === 'string' ? payload.stageCode : null,
          sector17Name: row.sector17_name,
          sector33Name: row.sector33_name,
          marketSegment: row.market_segment,
          reason: typeof reason.summary === 'string'
            ? reason.summary
            : `US専用類似度 ${Math.round(row.similarity_score * 100)}%`,
        }
      }),
      meta: { market: 'US', asOfDate, source: 'us_analytics.serving_current_similars' },
    }
  }
  const result = await getCurrentSimilars({ ticker, limit: clampLimit(call.limit, 8, 20) })
  let rows: AssistantResultRow[] = result.rows.map((row) => {
    const payload = row.payload as Record<string, unknown>
    const reason = row.reason as Record<string, unknown>
    return {
      ticker: row.similarTicker,
      name: typeof payload.name === 'string' ? payload.name : null,
      href: stockHref(row.similarTicker),
      rank: row.rank,
      score: row.similarityScore,
      direction: row.similarDirection,
      stageCode: typeof payload.stageCode === 'string' ? payload.stageCode : null,
      sector17Name: typeof payload.sector17Name === 'string' ? payload.sector17Name : null,
      reason: typeof reason.summary === 'string'
        ? reason.summary
        : `類似度 ${Math.round(row.similarityScore * 100)}%`,
    }
  })
  let source = 'serving_current_similars'
  let asOfDate = result.asOfDate
  if (rows.length === 0) {
    const fallback = await getMlSimilarsFromVectors(ticker, clampLimit(call.limit, 8, 20))
    rows = fallback.rows
    source = fallback.source
    asOfDate = fallback.asOfDate ?? asOfDate
  }
  return {
    tool: 'get_ml_similars',
    title: `${ticker} に似た現在銘柄`,
    summary: asOfDate
      ? `${asOfDate} 時点の物理特徴量・ステージ類似で ${rows.length} 件見つけました。`
      : 'ML類似データがまだ生成されていません。',
    href: `/stock/${ticker}`,
    rows,
    meta: { asOfDate, source },
  }
}

async function getMlSimilarsFromVectors(ticker: string, limit: number): Promise<{ asOfDate: string | null; source: string; rows: AssistantResultRow[] }> {
  const date = (await execGet<{ date: string | null }>(
    `
    SELECT MAX(date) AS date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ? AND ticker = ?
    `,
    [ML_PHYSICS_FEATURE_SET, ticker],
  ))?.date ?? null
  if (!date) return { asOfDate: null, source: 'ml_feature_vectors_v2_fallback', rows: [] }
  const base = await execGet<VectorRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.vector_json, f.feature_json,
           u.name, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ? AND f.ticker = ? AND f.date = ?
    LIMIT 1
    `,
    [ML_PHYSICS_FEATURE_SET, ticker, date],
  )
  const baseVector = parseJson<number[]>(base?.vector_json, [])
  if (baseVector.length === 0) return { asOfDate: date, source: 'ml_feature_vectors_v2_fallback', rows: [] }
  const candidates = await execAll<VectorRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.vector_json, f.feature_json,
           u.name, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ? AND f.date = ? AND f.ticker <> ?
    LIMIT 8000
    `,
    [ML_PHYSICS_FEATURE_SET, date, ticker],
  )
  const ranked = candidates
    .map((row) => {
      const distance = vectorDistance(baseVector, parseJson<number[]>(row.vector_json, []))
      const feature = parseJson<Record<string, unknown>>(row.feature_json, {})
      return { row, distance, score: Number.isFinite(distance) ? 1 / (1 + distance) : 0, feature }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return {
    asOfDate: date,
    source: 'ml_feature_vectors_v2_fallback',
    rows: ranked.map((item, index) => ({
      ticker: item.row.ticker,
      name: item.row.name,
      href: stockHref(item.row.ticker),
      rank: index + 1,
      score: item.score,
      stageCode: typeof item.feature.stageCode === 'string' ? item.feature.stageCode : item.row.stage_code,
      sector17Name: item.row.sector17_name,
      sector33Name: item.row.sector33_name,
      reason: `オンデマンド類似度 ${Math.round(item.score * 100)}% / 距離 ${item.distance.toFixed(3)}`,
    })),
  }
}

function jstToday(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`
}

export async function getEarningsCandidates(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const snapshotDate = await latestSnapshotDate()
  if (!snapshotDate) {
    return { tool: 'get_earnings_candidates', title: '決算候補', summary: '日次スナップショットが未作成です。', rows: [] }
  }
  const today = jstToday()
  const daysAhead = Math.min(90, Math.max(1, Number(call.daysAhead ?? 14)))
  const limit = clampLimit(call.limit, 10, 30)
  const where: string[] = ['e.announce_date >= ?', "COALESCE(u.market_segment, '') <> 'その他'"]
  const args: Array<string | number> = [today]
  const universe = universeSqlCondition('e.ticker', parseUniverseFilter(call.universe))
  if (universe.sql) {
    where.push(universe.sql)
    args.push(...universe.params)
  }
  if (call.marginType?.trim()) {
    where.push('u.margin_type = ?')
    args.push(call.marginType.trim())
  }
  const minAvgVolume = Number(call.minAvgVolume ?? 0)
  if (Number.isFinite(minAvgVolume) && minAvgVolume > 0) {
    where.push('avg_volume.avg_volume_30d >= ?')
    args.push(minAvgVolume)
  }
  where.push(`e.announce_date <= date(?, '+' || ? || ' day')`)
  args.push(today, daysAhead)

  const rows = await execAll<EarningsRow>(
    `
    WITH avg_volume AS (
      SELECT ticker, AVG(volume) AS avg_volume_30d
      FROM (
        SELECT ticker, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM ohlcv_daily
        WHERE date <= ?
      )
      WHERE rn <= 30
      GROUP BY ticker
    )
    SELECT
      e.ticker,
      COALESCE(e.company_name, u.name) AS name,
      e.announce_date,
      e.fiscal_period,
      od.close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type
    FROM earnings_calendar e
    LEFT JOIN ticker_universe u ON u.ticker = e.ticker
    LEFT JOIN daily_snapshots ds ON ds.ticker = e.ticker AND ds.date = ?
    LEFT JOIN ohlcv_daily od ON od.ticker = e.ticker AND od.date = ds.date
    LEFT JOIN avg_volume ON avg_volume.ticker = e.ticker
    WHERE ${where.join(' AND ')}
    ORDER BY e.announce_date ASC, avg_volume.avg_volume_30d DESC, e.ticker ASC
    LIMIT ?
    `,
    [snapshotDate, snapshotDate, ...args, limit],
  )
  const params = new URLSearchParams({ date: today, days: String(daysAhead), sort: 'avgVolume30', dir: 'desc', limit: String(limit) })
  if (call.universe) params.set('universe', call.universe)
  if (call.marginType) params.set('marginType', call.marginType)
  if (minAvgVolume > 0) params.set('avgVolumeMin', String(Math.floor(minAvgVolume)))
  return {
    tool: 'get_earnings_candidates',
    title: '決算候補',
    summary: `${today} から ${daysAhead} 日以内の決算予定を ${rows.length} 件抽出しました。`,
    href: `/earnings?${params.toString()}`,
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      href: stockHref(row.ticker),
      date: row.announce_date,
      price: row.close,
      volume: row.volume,
      avgVolume30d: row.avg_volume_30d,
      stageCode: stageCode(row),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      marginType: row.margin_type,
      reason: `${row.announce_date}${row.fiscal_period ? ` / ${row.fiscal_period}` : ''} / 30日平均出来高 ${row.avg_volume_30d ? Math.round(row.avg_volume_30d).toLocaleString() : '-'}`,
    })),
    meta: { snapshotDate, today, daysAhead },
  }
}

export async function runAssistantTool(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  if (call.market === 'US') {
    if (call.tool === 'scan_weekly_bearish_ma_breaks') {
      return {
        tool: call.tool,
        title: '米国株 週足ブレイク検索',
        summary: 'この専用条件はUS向け集計が未実装です。日本株データへ置き換えず、US対応まで結果を返しません。',
        rows: [],
        meta: { market: 'US', unsupported: true },
      }
    }
    if (call.tool === 'find_historical_anchor_similars') {
      return {
        tool: call.tool,
        title: '米国株 過去アンカー検索',
        summary: '米国株の本質類似局面は個別銘柄ページで利用できます。AIリサーチからの期間指定検索はUS対応準備中です。',
        href: call.anchorTicker ? `${usStockHref(call.anchorTicker)}#ml` : '/us/screener',
        rows: [],
        meta: { market: 'US', unsupported: true },
      }
    }
    if (call.tool === 'get_earnings_candidates') {
      return {
        tool: call.tool,
        title: '米国株 決算候補',
        summary: 'US決算データソースは未承認のため、推測値や日本株の決算予定は返しません。',
        rows: [],
        meta: { market: 'US', unsupported: true },
      }
    }
  }
  switch (call.tool) {
    case 'search_stocks':
      return searchStocks(call)
    case 'get_stock_overview':
      return getStockOverview(call)
    case 'screen_jp_stocks':
      return screenJpStocks(call)
    case 'scan_weekly_bearish_ma_breaks':
      return scanWeeklyBearishMaBreaks(call)
    case 'find_historical_anchor_similars':
      return findHistoricalAnchorSimilars(call)
    case 'get_ml_similars':
      return getMlSimilars(call)
    case 'get_earnings_candidates':
      return getEarningsCandidates(call)
    default:
      return {
        tool: 'search_stocks',
        title: '未対応の操作',
        summary: 'この操作はまだAIアシスタントに登録されていません。',
        rows: [],
      }
  }
}

export function buildNavigateActions(results: AssistantToolResult[]) {
  return results
    .filter((result) => result.href)
    .slice(0, 4)
    .map((result) => ({
      type: 'navigate' as const,
      label: `${result.title}を開く`,
      href: result.href as string,
    }))
}

export function describeResults(results: AssistantToolResult[]): string {
  const totalRows = results.reduce((sum, result) => sum + result.rows.length, 0)
  const isUsResult = results.some((result) => (
    result.href?.startsWith('/us/')
    || result.rows.some((row) => row.href?.startsWith('/us/'))
  ))
  if (results.length === 0) return '条件に合う機能を特定できませんでした。銘柄コードや条件を少し具体化してください。'
  if (totalRows === 0) return results.map((result) => result.summary).join(' ')
  if (results.some((result) => result.tool === 'scan_weekly_bearish_ma_breaks')) {
    const titles = results.map((result) => `${result.title}${result.rows.length ? ` ${result.rows.length}件` : ''}`).join('、')
    return `${titles}をDBから取得して表示しました。根拠は週足陰線、5週線・10週線の下抜け、20日平均出来高、週MA傾き、PMS/PFS、物理ML下落順位を確認してください。`
  }
  if (results.some((result) => result.tool === 'find_historical_anchor_similars')) {
    const titles = results.map((result) => `${result.title}${result.rows.length ? ` ${result.rows.length}件` : ''}`).join('、')
    return `${titles}をDBから取得して表示しました。ランキングはアンカー期間全体の物理特徴量との形状類似を優先し、PMS/PFS低下、物理ML下落順位、過去検証は補助根拠として確認してください。`
  }
  const titles = results.map((result) => `${result.title}${result.rows.length ? ` ${result.rows.length}件` : ''}`).join('、')
  if (isUsResult) {
    return `${titles}を米国株DBから取得して表示しました。候補の根拠は各カードの6ステージ、短期チェック、PMS/PFS、物理ML順位、出来高を確認してください。`
  }
  return `${titles}をDBから取得して表示しました。候補の根拠は各カードの6ステージ、短期チェック、PMS/PFS、物理ML順位、出来高、決算日を確認してください。`
}

export const assistantToolDescriptions = `
利用可能ツール:
- search_stocks: 銘柄名またはコードを検索する。
- get_stock_overview: 1銘柄の6ステージ、価格、出来高、PMS/PFS、短期チェック、ML候補状況を確認する。
- screen_jp_stocks: 日本株を6ステージ、物理ML上昇/下落、日経225、貸借、出来高、PMS/PFS/PES、PMS上昇/低下、短期チェックで抽出する。
- scan_weekly_bearish_ma_breaks: 日本株の週足ローソク足が陰線で、5週移動平均線と10週移動平均線を上から下へ割り込む下落候補を抽出する。平均出来高20日、週足MA傾き、PMS/PFS、物理ML下落順位を併用する。週足/陰線/5週/10週/割り込み/下抜け/弱含み/下落基調が指定された場合はこのツールを優先する。
- find_historical_anchor_similars: 指定銘柄の過去期間をアンカーにし、その期間全体の物理特徴量ベクトル平均と現在の各銘柄ベクトルを比較して類似銘柄を探す。例: 7003、2026-05-11以前、2〜3か月、下落前、現在形状が類似。過去アンカー/以前/当時/下落前/現在の形状類似が指定された場合はこのツールを優先し、get_ml_similars で代替しない。
- get_ml_similars: 指定銘柄に似た現在銘柄をML類似で探す。
- get_earnings_candidates: 近い決算予定銘柄を抽出する。
日経225指定は universe=nikkei225。貸借指定は marginType=貸借。空売り/下落警戒は direction=down。上昇候補は direction=up。
初動/動き出し/勢いは pfsMin=0, pmsTrend=rising, sort=pfs を優先。PMSが強い候補は sort=pms。短期ラベル重視は sort=short_term。
週足陰線が5週線・10週線を上から下へ割り込む、という条件は screen_jp_stocks ではなく scan_weekly_bearish_ma_breaks を使う。
過去の特定銘柄の下落前形状と現在銘柄の類似、という条件は get_ml_similars ではなく find_historical_anchor_similars を使う。
曖昧な「良さそう」「おすすめ」だけなら、上昇/下落/初動/決算/対象市場を聞き返す。
日経225の候補数は ${NIKKEI225_TICKERS.length}。
`
