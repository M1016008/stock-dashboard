import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { STAGE_LABELS } from '@/lib/hex-stage'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export type UsTradeWorkbenchAction = 'buy_candidate' | 'downside_watch' | 'watch' | 'avoid'
export type UsTradeWorkbenchAvailability = 'ready' | 'partial' | 'unavailable'

export interface UsTradeWorkbenchExecutor {
  all<T>(sql: string, args?: readonly unknown[]): Promise<T[]>
  get<T>(sql: string, args?: readonly unknown[]): Promise<T | undefined>
}

export interface UsTradeWorkbenchCoverage {
  availability: UsTradeWorkbenchAvailability
  reason: string | null
  asOfDate: string | null
  snapshotDate: string | null
  priceDate: string | null
  priceBasis: string | null
  source: 'US_ANALYTICS_SERVING'
  rawCandidateCount: number
  completeCandidateCount: number
  displayedCandidateCount: number
  excludedCandidateCount: number
  completeRate: number | null
  unavailableEvidence: Array<
    'BORROW_AVAILABILITY'
    | 'VALIDATED_OUTCOME_EVIDENCE'
    | 'SIGNAL_RETURN_STATISTICS'
    | 'EARNINGS_CALENDAR'
  >
}

export interface UsTradeWorkbenchCandidate {
  ticker: string
  name: string
  exchange: string | null
  sector: string | null
  industry: string | null
  asOfDate: string
  close: number
  previousClose: number | null
  changePct: number | null
  volume: number
  stages: Array<number | null>
  stageCode: string | null
  stageLabels: string[]
  maState: {
    order: 'SHORT_ABOVE_MIDDLE_ABOVE_LONG' | 'LONG_ABOVE_MIDDLE_ABOVE_SHORT' | 'MIXED' | 'UNAVAILABLE'
    label: string
    angle: 'RISING' | 'FALLING' | 'FLAT_OR_MIXED' | 'UNAVAILABLE'
    angleLabel: string
    sma5SlopePct: number | null
    sma25SlopePct: number | null
    priceVsSma25Pct: number | null
  }
  ml: {
    up: { rank: number | null; score: number | null; modelName: string | null }
    down: { rank: number | null; score: number | null; modelName: string | null }
    wait: { rank: number | null; score: number | null; modelName: string | null }
  }
  decision: {
    action: UsTradeWorkbenchAction
    label: string
    score: number
    confidence: '高' | '中' | '低'
    summary: string
    why: string[]
    riskNotes: string[]
    nextChecks: string[]
  }
  orderDraft: {
    side: 'BUY' | null
    orderType: 'LIMIT_DRAFT'
    currency: 'USD'
    lotSize: 1
    budgetUsd: number
    referencePrice: number
    suggestedLimitPrice: number
    quantity: number | null
    estimatedAmount: number | null
    valid: boolean
    guardrails: string[]
  }
}

export interface UsTradeWorkbenchResult {
  coverage: UsTradeWorkbenchCoverage
  params: {
    horizonDays: number
    limit: number
    budgetUsd: number
  }
  summary: {
    total: number
    buyCandidates: number
    downsideWatch: number
    watch: number
    avoid: number
  }
  candidates: UsTradeWorkbenchCandidate[]
}

type MetadataRow = {
  as_of_date: string | null
  snapshot_date: string | null
  price_date: string | null
  price_basis: string | null
  raw_candidate_count: number | null
  complete_candidate_count: number | null
}

export type UsTradeWorkbenchRawRow = {
  ticker: string
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  as_of_date: string
  close: number
  previous_close: number | null
  volume: number
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  prev_ma_5: number | null
  prev_ma_25: number | null
  up_rank: number | null
  up_score: number | null
  up_model: string | null
  down_rank: number | null
  down_score: number | null
  down_model: string | null
  wait_rank: number | null
  wait_score: number | null
  wait_model: string | null
}

const DEFAULT_HORIZON = 20
const DEFAULT_LIMIT = 40
const DEFAULT_BUDGET_USD = 5_000
const HORIZONS = new Set([5, 10, 20, 40, 60, 90, 200])

const defaultExecutor: UsTradeWorkbenchExecutor = {
  all: (sql, args = []) => execUsAnalyticsAll(sql, args as Parameters<typeof execUsAnalyticsAll>[1]),
  get: (sql, args = []) => execUsAnalyticsGet(sql, args as Parameters<typeof execUsAnalyticsGet>[1]),
}

export const US_TRADE_WORKBENCH_METADATA_SQL = `
WITH candidate_date AS (
  SELECT MAX(as_of_date) AS date
  FROM serving_ml_physics_candidates
  WHERE horizon_days = ?
    AND direction IN ('up', 'down', 'wait')
), previous_snapshot_date AS (
  SELECT MAX(date) AS date FROM daily_snapshots WHERE date < (SELECT date FROM candidate_date)
)
SELECT
  candidate_date.date AS as_of_date,
  (SELECT MAX(date) FROM daily_snapshots WHERE date <= candidate_date.date) AS snapshot_date,
  (SELECT MAX(date) FROM ohlcv_daily WHERE date <= candidate_date.date) AS price_date,
  (SELECT value FROM us_analytics_metadata WHERE key = 'ohlcv_price_basis' LIMIT 1) AS price_basis,
  (
    SELECT COUNT(DISTINCT ticker)
    FROM serving_ml_physics_candidates
    WHERE as_of_date = candidate_date.date
      AND horizon_days = ?
      AND direction IN ('up', 'down', 'wait')
  ) AS raw_candidate_count,
  (
    SELECT COUNT(DISTINCT c.ticker)
    FROM serving_ml_physics_candidates c
    INNER JOIN ticker_universe u
      ON u.ticker = c.ticker
     AND u.active = 1
    INNER JOIN ohlcv_daily p
      ON p.ticker = c.ticker
     AND p.date = candidate_date.date
    INNER JOIN daily_snapshots s
      ON s.ticker = c.ticker
     AND s.date = candidate_date.date
    LEFT JOIN daily_snapshots previous_snapshot
      ON previous_snapshot.ticker = c.ticker
     AND previous_snapshot.date = (SELECT date FROM previous_snapshot_date)
    WHERE c.as_of_date = candidate_date.date
      AND c.horizon_days = ?
      AND c.direction IN ('up', 'down', 'wait')
      AND p.close > 0
      AND s.daily_a_stage BETWEEN 1 AND 6
      AND s.daily_b_stage BETWEEN 1 AND 6
      AND s.weekly_a_stage BETWEEN 1 AND 6
      AND s.weekly_b_stage BETWEEN 1 AND 6
      AND s.monthly_a_stage BETWEEN 1 AND 6
      AND s.monthly_b_stage BETWEEN 1 AND 6
      AND s.ma_5 IS NOT NULL
      AND s.ma_25 IS NOT NULL
      AND s.ma_75 IS NOT NULL
      AND previous_snapshot.ma_5 IS NOT NULL
      AND previous_snapshot.ma_25 IS NOT NULL
      AND ${usInvestableSymbolSql('c.ticker')}
  ) AS complete_candidate_count
FROM candidate_date
`

export const US_TRADE_WORKBENCH_ROWS_SQL = `
WITH ranked AS (
  SELECT
    ticker,
    MIN(CASE WHEN direction = 'up' THEN rank END) AS up_rank,
    MAX(CASE WHEN direction = 'up' THEN candidate_score END) AS up_score,
    MAX(CASE WHEN direction = 'up' THEN model_name END) AS up_model,
    MIN(CASE WHEN direction = 'down' THEN rank END) AS down_rank,
    MAX(CASE WHEN direction = 'down' THEN candidate_score END) AS down_score,
    MAX(CASE WHEN direction = 'down' THEN model_name END) AS down_model,
    MIN(CASE WHEN direction = 'wait' THEN rank END) AS wait_rank,
    MAX(CASE WHEN direction = 'wait' THEN candidate_score END) AS wait_score,
    MAX(CASE WHEN direction = 'wait' THEN model_name END) AS wait_model
  FROM serving_ml_physics_candidates
  WHERE as_of_date = ?
    AND horizon_days = ?
    AND direction IN ('up', 'down', 'wait')
  GROUP BY ticker
), previous_date AS (
  SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?
), previous_snapshot_date AS (
  SELECT MAX(date) AS date FROM daily_snapshots WHERE date < ?
)
SELECT
  r.ticker,
  COALESCE(NULLIF(u.name, ''), r.ticker) AS name,
  NULLIF(u.market_segment, '') AS exchange,
  NULLIF(u.sector17_name, '') AS sector,
  NULLIF(u.sector33_name, '') AS industry,
  ? AS as_of_date,
  p.close,
  previous_price.close AS previous_close,
  p.volume,
  s.daily_a_stage,
  s.daily_b_stage,
  s.weekly_a_stage,
  s.weekly_b_stage,
  s.monthly_a_stage,
  s.monthly_b_stage,
  s.ma_5,
  s.ma_25,
  s.ma_75,
  previous_snapshot.ma_5 AS prev_ma_5,
  previous_snapshot.ma_25 AS prev_ma_25,
  r.up_rank,
  r.up_score,
  r.up_model,
  r.down_rank,
  r.down_score,
  r.down_model,
  r.wait_rank,
  r.wait_score,
  r.wait_model
FROM ranked r
INNER JOIN ticker_universe u
  ON u.ticker = r.ticker
 AND u.active = 1
INNER JOIN ohlcv_daily p
  ON p.ticker = r.ticker
 AND p.date = ?
INNER JOIN daily_snapshots s
  ON s.ticker = r.ticker
 AND s.date = ?
LEFT JOIN ohlcv_daily previous_price
  ON previous_price.ticker = r.ticker
 AND previous_price.date = (SELECT date FROM previous_date)
LEFT JOIN daily_snapshots previous_snapshot
  ON previous_snapshot.ticker = r.ticker
 AND previous_snapshot.date = (SELECT date FROM previous_snapshot_date)
WHERE ${usInvestableSymbolSql('r.ticker')}
ORDER BY
  MIN(COALESCE(r.up_rank, 999999), COALESCE(r.down_rank, 999999), COALESCE(r.wait_rank, 999999)),
  r.ticker
LIMIT ?
`

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return value != null && Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function rankScore(rank: number | null, maxRank = 120): number {
  if (!rank || rank < 1 || rank > maxRank) return 0
  return ((maxRank + 1 - rank) / maxRank) * 100
}

function stagesOf(row: UsTradeWorkbenchRawRow): Array<number | null> {
  return [
    numberOrNull(row.daily_a_stage),
    numberOrNull(row.daily_b_stage),
    numberOrNull(row.weekly_a_stage),
    numberOrNull(row.weekly_b_stage),
    numberOrNull(row.monthly_a_stage),
    numberOrNull(row.monthly_b_stage),
  ]
}

function stageCode(stages: Array<number | null>): string | null {
  return stages.every((stage) => stage != null) ? stages.join('') : null
}

function stageLabels(stages: Array<number | null>): string[] {
  const axes = ['日A', '日B', '週A', '週B', '月A', '月B']
  return stages.map((stage, index) => `${axes[index]} ${stage ?? '-'} ${stage ? STAGE_LABELS[stage] ?? '不明' : '不明'}`)
}

function bullishStageScore(stages: Array<number | null>): number {
  const weights = [1.3, 0.8, 1.2, 0.9, 1.2, 1]
  let score = 0
  let total = 0
  stages.forEach((stage, index) => {
    const weight = weights[index] ?? 1
    total += weight
    if (stage === 1) score += 100 * weight
    else if (stage === 6) score += 86 * weight
    else if (stage === 2) score += 70 * weight
    else if (stage === 5) score += 52 * weight
    else if (stage === 3) score += 28 * weight
    else if (stage === 4) score += 8 * weight
    else score += 40 * weight
  })
  return total > 0 ? score / total : 40
}

function bearishStageScore(stages: Array<number | null>): number {
  return clamp(stages.reduce<number>((score, stage, index) => {
    const weight = index >= 2 ? 1.25 : 1
    if (stage === 4) return score + 24 * weight
    if (stage === 3) return score + 18 * weight
    if (stage === 5) return score + 8 * weight
    return score
  }, 0), 0, 100)
}

function maState(row: UsTradeWorkbenchRawRow): UsTradeWorkbenchCandidate['maState'] {
  const ma5 = numberOrNull(row.ma_5)
  const ma25 = numberOrNull(row.ma_25)
  const ma75 = numberOrNull(row.ma_75)
  const prevMa5 = numberOrNull(row.prev_ma_5)
  const prevMa25 = numberOrNull(row.prev_ma_25)
  const close = numberOrNull(row.close)
  const sma5SlopePct = ma5 != null && prevMa5 != null && prevMa5 !== 0 ? 100 * (ma5 - prevMa5) / prevMa5 : null
  const sma25SlopePct = ma25 != null && prevMa25 != null && prevMa25 !== 0 ? 100 * (ma25 - prevMa25) / prevMa25 : null
  const priceVsSma25Pct = close != null && ma25 != null && ma25 !== 0 ? 100 * (close - ma25) / ma25 : null
  const order = ma5 == null || ma25 == null || ma75 == null
    ? 'UNAVAILABLE'
    : ma5 > ma25 && ma25 > ma75
      ? 'SHORT_ABOVE_MIDDLE_ABOVE_LONG'
      : ma75 > ma25 && ma25 > ma5
        ? 'LONG_ABOVE_MIDDLE_ABOVE_SHORT'
        : 'MIXED'
  const angle = sma5SlopePct == null || sma25SlopePct == null
    ? 'UNAVAILABLE'
    : sma5SlopePct > 0.2 && sma25SlopePct >= -0.05
      ? 'RISING'
      : sma5SlopePct < -0.2 && sma25SlopePct <= 0.05
        ? 'FALLING'
        : 'FLAT_OR_MIXED'
  return {
    order,
    label: order === 'SHORT_ABOVE_MIDDLE_ABOVE_LONG'
      ? '短期 > 中期 > 長期'
      : order === 'LONG_ABOVE_MIDDLE_ABOVE_SHORT'
        ? '長期 > 中期 > 短期'
        : order === 'MIXED' ? '混在' : '算出不可',
    angle,
    angleLabel: angle === 'RISING' ? '短期線上向き' : angle === 'FALLING' ? '短期線下向き' : angle === 'FLAT_OR_MIXED' ? '横ばい/混在' : '算出不可',
    sma5SlopePct,
    sma25SlopePct,
    priceVsSma25Pct,
  }
}

function makeDecision(
  row: UsTradeWorkbenchRawRow,
  stages: Array<number | null>,
  ma: UsTradeWorkbenchCandidate['maState'],
): UsTradeWorkbenchCandidate['decision'] {
  const missingInputs: string[] = []
  if (numberOrNull(row.close) == null || Number(row.close) <= 0) missingInputs.push('有効な終値')
  if (!stages.every((stage) => stage != null && Number.isInteger(stage) && stage >= 1 && stage <= 6)) {
    missingInputs.push('6ステージ')
  }
  if (ma.order === 'UNAVAILABLE') missingInputs.push('SMA並び順')
  if (ma.angle === 'UNAVAILABLE') missingInputs.push('SMA傾き')
  if (missingInputs.length > 0) {
    return {
      action: 'watch',
      label: 'データ不足',
      score: 0,
      confidence: '低',
      summary: '注文下書きに必要な現在特徴が不足しているため、候補順位が高くても売買候補へ分類しません。',
      why: [`未算出: ${missingInputs.join('、')}`],
      riskNotes: [
        '欠損特徴を0や中立値へ補完していません。',
        'この判定は現在のServing特徴のみを比較し、将来Outcomeラベルを使用していません。',
      ],
      nextChecks: ['Serving世代で欠損特徴が算出された後に再確認する'],
    }
  }
  const upRank = numberOrNull(row.up_rank)
  const downRank = numberOrNull(row.down_rank)
  const waitRank = numberOrNull(row.wait_rank)
  const bullish = bullishStageScore(stages)
  const bearish = bearishStageScore(stages)
  const maLong = ma.order === 'SHORT_ABOVE_MIDDLE_ABOVE_LONG' ? 10 : ma.angle === 'RISING' ? 5 : ma.angle === 'FALLING' ? -9 : 0
  const maDown = ma.order === 'LONG_ABOVE_MIDDLE_ABOVE_SHORT' ? 12 : ma.angle === 'FALLING' ? 7 : ma.angle === 'RISING' ? -8 : 0
  const longScore = clamp(18 + rankScore(upRank) * 0.48 + bullish * 0.28 + maLong - rankScore(downRank) * 0.28 - rankScore(waitRank) * 0.08, 0, 100)
  const downsideScore = clamp(15 + rankScore(downRank) * 0.55 + bearish * 0.42 + maDown - rankScore(upRank) * 0.24, 0, 100)
  const action: UsTradeWorkbenchAction = longScore >= 68 && upRank != null && downsideScore < 65
    ? 'buy_candidate'
    : downsideScore >= 65 && downRank != null
      ? 'downside_watch'
      : Math.max(longScore, downsideScore) >= 50
        ? 'watch'
        : 'avoid'
  const score = action === 'downside_watch' ? downsideScore : longScore
  const label = action === 'buy_candidate' ? '買い下書き候補' : action === 'downside_watch' ? '下落警戒' : action === 'watch' ? '要確認' : '見送り'
  const summary = action === 'buy_candidate'
    ? '現行Servingの上昇候補、6ステージ、SMA形状が同じ方向を示すため、1株単位の買い指値下書きを作成できます。'
    : action === 'downside_watch'
      ? '現行Servingの下落候補と下降側のステージ・SMA根拠が優勢です。借株可否がないため空売り注文案にはしません。'
      : action === 'watch'
        ? '一部の根拠はありますが、現行特徴の方向が十分にはそろっていません。'
        : '現行Servingで注文下書きを作るだけの根拠がそろっていません。'
  const why = [
    upRank != null ? `上昇Physical ML候補 #${upRank}（スコア ${numberOrNull(row.up_score)?.toFixed(2) ?? '-'}）` : '上昇Physical ML候補には含まれていません。',
    downRank != null ? `下落Physical ML候補 #${downRank}（スコア ${numberOrNull(row.down_score)?.toFixed(2) ?? '-'}）` : '下落Physical ML候補には含まれていません。',
    `6ステージは ${stageCode(stages) ?? '欠損あり'}、SMAは「${ma.label} / ${ma.angleLabel}」です。`,
  ]
  const riskNotes = [
    'この判定は現在のServing特徴のみを比較し、将来Outcomeラベルを使用していません。',
    '米国株の借株可否・貸株料・short-sale restrictionはこのSourceにないため、空売り可否は判定しません。',
    '過去の的中率・リターン分布はこのWorkbenchでは利用不可で、Similarity ScoreやML順位を将来確率として扱いません。',
  ]
  if (downRank != null && action === 'buy_candidate') riskNotes.push('下落候補にも含まれるため、買い下書きでも逆行リスクを先に確認します。')
  return {
    action,
    label,
    score: Math.round(score * 10) / 10,
    confidence: score >= 60 ? '中' : '低',
    summary,
    why,
    riskNotes,
    nextChecks: [
      '銘柄詳細で日足・週足・月足と出来高を確認する',
      '決算日、企業イベント、取引停止などServing外の情報を確認する',
      action === 'buy_candidate' ? '撤退価格と許容損失を決めてから指値を検討する' : '根拠がそろうまでは監視候補として扱う',
    ],
  }
}

export function buildUsTradeWorkbenchCandidate(
  row: UsTradeWorkbenchRawRow,
  budgetUsd: number,
): UsTradeWorkbenchCandidate {
  const stages = stagesOf(row)
  const ma = maState(row)
  const decision = makeDecision(row, stages, ma)
  const close = Number(row.close)
  const previousClose = numberOrNull(row.previous_close)
  const quantity = close > 0 ? Math.floor(budgetUsd / close) : 0
  const valid = decision.action === 'buy_candidate' && quantity >= 1
  return {
    ticker: row.ticker,
    name: row.name?.trim() || row.ticker,
    exchange: row.exchange,
    sector: row.sector,
    industry: row.industry,
    asOfDate: row.as_of_date,
    close,
    previousClose,
    changePct: previousClose != null && previousClose !== 0 ? 100 * (close - previousClose) / previousClose : null,
    volume: Number(row.volume),
    stages,
    stageCode: stageCode(stages),
    stageLabels: stageLabels(stages),
    maState: ma,
    ml: {
      up: { rank: numberOrNull(row.up_rank), score: numberOrNull(row.up_score), modelName: row.up_model },
      down: { rank: numberOrNull(row.down_rank), score: numberOrNull(row.down_score), modelName: row.down_model },
      wait: { rank: numberOrNull(row.wait_rank), score: numberOrNull(row.wait_score), modelName: row.wait_model },
    },
    decision,
    orderDraft: {
      side: valid ? 'BUY' : null,
      orderType: 'LIMIT_DRAFT',
      currency: 'USD',
      lotSize: 1,
      budgetUsd,
      referencePrice: close,
      suggestedLimitPrice: close,
      quantity: valid ? quantity : null,
      estimatedAmount: valid ? Math.round(quantity * close * 100) / 100 : null,
      valid,
      guardrails: [
        '実発注ではなく、検証用の買い指値下書きです。',
        '米国株は1株単位で計算し、手数料・為替・税・スリッページを含みません。',
        `仮予算は$${budgetUsd.toLocaleString('en-US')}です。`,
        decision.action === 'downside_watch' ? '借株データがないため空売り数量を生成しません。' : '成行注文は生成しません。',
      ],
    },
  }
}

function emptyResult(
  params: UsTradeWorkbenchResult['params'],
  reason: string,
  metadata: Partial<MetadataRow> = {},
): UsTradeWorkbenchResult {
  return {
    coverage: {
      availability: 'unavailable',
      reason,
      asOfDate: metadata.as_of_date ?? null,
      snapshotDate: metadata.snapshot_date ?? null,
      priceDate: metadata.price_date ?? null,
      priceBasis: metadata.price_basis ?? null,
      source: 'US_ANALYTICS_SERVING',
      rawCandidateCount: Number(metadata.raw_candidate_count ?? 0),
      completeCandidateCount: 0,
      displayedCandidateCount: 0,
      excludedCandidateCount: Number(metadata.raw_candidate_count ?? 0),
      completeRate: null,
      unavailableEvidence: ['BORROW_AVAILABILITY', 'VALIDATED_OUTCOME_EVIDENCE', 'SIGNAL_RETURN_STATISTICS', 'EARNINGS_CALENDAR'],
    },
    params,
    summary: { total: 0, buyCandidates: 0, downsideWatch: 0, watch: 0, avoid: 0 },
    candidates: [],
  }
}

export async function getUsTradeWorkbench(
  input: { horizonDays?: number | null; limit?: number | null; budgetUsd?: number | null } = {},
  executor: UsTradeWorkbenchExecutor = defaultExecutor,
): Promise<UsTradeWorkbenchResult> {
  const params = {
    horizonDays: HORIZONS.has(Number(input.horizonDays)) ? Number(input.horizonDays) : DEFAULT_HORIZON,
    limit: Math.min(120, Math.max(1, Math.trunc(Number(input.limit ?? DEFAULT_LIMIT)))),
    budgetUsd: Math.min(1_000_000, Math.max(100, Math.round(Number(input.budgetUsd ?? DEFAULT_BUDGET_USD)))),
  }
  if (executor === defaultExecutor && !hasUsAnalyticsDb()) {
    return emptyResult(params, 'US_ANALYTICS_DB_MISSING')
  }

  let metadata: MetadataRow | undefined
  try {
    metadata = await executor.get<MetadataRow>(US_TRADE_WORKBENCH_METADATA_SQL, [params.horizonDays, params.horizonDays, params.horizonDays])
  } catch {
    return emptyResult(params, 'US_SERVING_SCHEMA_UNAVAILABLE')
  }
  if (!metadata?.as_of_date || Number(metadata.raw_candidate_count ?? 0) < 1) {
    return emptyResult(params, 'US_SERVING_CANDIDATES_MISSING', metadata)
  }
  if (metadata.price_basis !== US_ADJUSTED_PRICE_BASIS) {
    return emptyResult(params, 'US_PRICE_BASIS_MISMATCH', metadata)
  }
  if (metadata.snapshot_date !== metadata.as_of_date || metadata.price_date !== metadata.as_of_date) {
    return emptyResult(params, 'US_SERVING_GENERATION_MISMATCH', metadata)
  }

  let rows: UsTradeWorkbenchRawRow[]
  const queryLimit = Math.min(360, Math.max(120, params.limit * 3))
  try {
    rows = await executor.all<UsTradeWorkbenchRawRow>(US_TRADE_WORKBENCH_ROWS_SQL, [
      metadata.as_of_date,
      params.horizonDays,
      metadata.as_of_date,
      metadata.as_of_date,
      metadata.as_of_date,
      metadata.as_of_date,
      metadata.as_of_date,
      queryLimit,
    ])
  } catch {
    return emptyResult(params, 'US_SERVING_QUERY_FAILED', metadata)
  }

  const rawCandidateCount = Number(metadata.raw_candidate_count ?? 0)
  const completeCandidateCount = Number(metadata.complete_candidate_count ?? 0)
  const candidates = rows
    .map((row) => buildUsTradeWorkbenchCandidate(row, params.budgetUsd))
    .sort((a, b) => {
      const weight: Record<UsTradeWorkbenchAction, number> = {
        buy_candidate: 0,
        downside_watch: 1,
        watch: 2,
        avoid: 3,
      }
      return weight[a.decision.action] - weight[b.decision.action] || b.decision.score - a.decision.score
    })
    .slice(0, params.limit)
  if (candidates.length === 0) return emptyResult(params, 'US_COMPLETE_CANDIDATES_MISSING', metadata)
  const excludedCandidateCount = Math.max(0, rawCandidateCount - completeCandidateCount)
  const coverage: UsTradeWorkbenchCoverage = {
    availability: excludedCandidateCount > 0 ? 'partial' : 'ready',
    reason: excludedCandidateCount > 0 ? 'INCOMPLETE_CANDIDATES_EXCLUDED' : null,
    asOfDate: metadata.as_of_date,
    snapshotDate: metadata.snapshot_date,
    priceDate: metadata.price_date,
    priceBasis: metadata.price_basis,
    source: 'US_ANALYTICS_SERVING',
    rawCandidateCount,
    completeCandidateCount,
    displayedCandidateCount: candidates.length,
    excludedCandidateCount,
    completeRate: rawCandidateCount > 0 ? completeCandidateCount / rawCandidateCount : null,
    unavailableEvidence: ['BORROW_AVAILABILITY', 'VALIDATED_OUTCOME_EVIDENCE', 'SIGNAL_RETURN_STATISTICS', 'EARNINGS_CALENDAR'],
  }
  const summary = candidates.reduce<UsTradeWorkbenchResult['summary']>((acc, candidate) => {
    acc.total += 1
    if (candidate.decision.action === 'buy_candidate') acc.buyCandidates += 1
    else if (candidate.decision.action === 'downside_watch') acc.downsideWatch += 1
    else if (candidate.decision.action === 'watch') acc.watch += 1
    else acc.avoid += 1
    return acc
  }, { total: 0, buyCandidates: 0, downsideWatch: 0, watch: 0, avoid: 0 })
  return { coverage, params, summary, candidates }
}

