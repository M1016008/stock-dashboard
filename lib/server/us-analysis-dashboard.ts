import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  hasUsAnalyticsDb,
} from '@/lib/db/us-analytics'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

type SqlArg = string | number | null

export type UsAnalysisStatus = {
  available: boolean
  priceDate: string | null
  featureDate: string | null
  candidateDate: string | null
  evaluationDate: string | null
  analogDate: string | null
  priceBasis: string | null
  derivedPriceBasis: string | null
  analogPriceBasis: string | null
}

export type UsPhysicsCandidate = {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  horizonDays: number
  rank: number
  ticker: string
  name: string | null
  sector: string | null
  candidateScore: number
  stageCode: string | null
}

export type UsModelEvaluation = {
  evaluationDate: string
  modelType: string
  direction: string
  horizonDays: number
  sampleCount: number
  precisionAt20: number | null
  precisionAt50: number | null
  hitRate: number | null
  medianReturnPct: number | null
  maxDrawdownPct: number | null
}

export type UsCurrentSimilar = {
  asOfDate: string
  baseTicker: string
  similarTicker: string
  similarityScore: number
  baseDirection: string | null
  similarDirection: string | null
}

export type UsPatternDistribution = {
  patternCode: string
  count: number
}

export type UsStageTransition = {
  axis: string
  fromStage: number
  toStage: number
  count: number
}

export type UsPatternStat = {
  patternCode: string
  count: number
  p25: number | null
  p50: number | null
  p75: number | null
}

export type UsPhysicsStatusEvaluation = {
  evaluationDate: string
  statusLabel: string
  targetDirection: string
  horizonDays: number
  sampleCount: number
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  medianReturnPct: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
}

export type UsRlEvaluation = {
  evaluationDate: string
  policyName: string
  horizonDays: number
  sampleCount: number
  winRate: number | null
  oracleMatchRate: number | null
  avgReward: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
}

export type UsSimilarityEvaluation = {
  asOfDate: string
  horizonDays: number
  source: string
  baseCount: number
  pairCount: number
  upRate: number | null
  downRate: number | null
  medianReturnPct: number | null
  maxDrawdownPct: number | null
}

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

async function safeGet<T>(sql: string, args: readonly SqlArg[] = []): Promise<T | undefined> {
  try {
    return await execUsAnalyticsGet<T>(sql, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no such table|SQLITE_BUSY|database is locked/i.test(message)) return undefined
    throw error
  }
}

async function safeAll<T>(sql: string, args: readonly SqlArg[] = []): Promise<T[]> {
  try {
    return await execUsAnalyticsAll<T>(sql, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no such table|SQLITE_BUSY|database is locked/i.test(message)) return []
    throw error
  }
}

export async function loadUsAnalysisStatus(): Promise<UsAnalysisStatus> {
  if (!hasUsAnalyticsDb()) {
    return {
      available: false,
      priceDate: null,
      featureDate: null,
      candidateDate: null,
      evaluationDate: null,
      analogDate: null,
      priceBasis: null,
      derivedPriceBasis: null,
      analogPriceBasis: null,
    }
  }

  const [dates, metadata] = await Promise.all([
    safeGet<{
      priceDate: string | null
      featureDate: string | null
      candidateDate: string | null
      evaluationDate: string | null
      analogDate: string | null
    }>(
      `
        SELECT
          (SELECT MAX(date) FROM ohlcv_daily) AS priceDate,
          (SELECT MAX(date) FROM ml_feature_vectors_v2) AS featureDate,
          (SELECT MAX(as_of_date) FROM serving_ml_physics_candidates) AS candidateDate,
          (
            SELECT MAX(evaluation_date)
            FROM ml_model_evaluations
            WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)
          ) AS evaluationDate,
          (SELECT MAX(as_of_date) FROM serving_current_similars) AS analogDate
      `,
    ),
    safeAll<{ key: string; value: string | null }>(
      `
        SELECT key, value
        FROM us_analytics_metadata
        WHERE key IN ('ohlcv_price_basis', 'derived_price_basis', 'analog_index_price_basis')
      `,
    ),
  ])
  const metadataMap = new Map(metadata.map((row) => [row.key, row.value]))
  return {
    available: true,
    priceDate: dates?.priceDate ?? null,
    featureDate: dates?.featureDate ?? null,
    candidateDate: dates?.candidateDate ?? null,
    evaluationDate: dates?.evaluationDate ?? null,
    analogDate: dates?.analogDate ?? null,
    priceBasis: metadataMap.get('ohlcv_price_basis') ?? null,
    derivedPriceBasis: metadataMap.get('derived_price_basis') ?? null,
    analogPriceBasis: metadataMap.get('analog_index_price_basis') ?? null,
  }
}

export async function loadUsPhysicsCandidates(): Promise<UsPhysicsCandidate[]> {
  const rows = await safeAll<{
    asOfDate: string
    direction: 'up' | 'down' | 'wait'
    horizonDays: number
    rank: number
    ticker: string
    name: string | null
    sector: string | null
    candidateScore: number
    featureJson: string
  }>(
    `
      WITH latest AS (
        SELECT MAX(as_of_date) AS date
        FROM serving_ml_physics_candidates
      )
      SELECT
        c.as_of_date AS asOfDate,
        c.direction,
        c.horizon_days AS horizonDays,
        c.rank,
        c.ticker,
        COALESCE(NULLIF(c.name, ''), NULLIF(u.name, ''), c.ticker) AS name,
        COALESCE(NULLIF(c.sector_large, ''), NULLIF(u.sector17_name, ''), NULLIF(u.sector33_name, '')) AS sector,
        c.candidate_score AS candidateScore,
        c.feature_json AS featureJson
      FROM serving_ml_physics_candidates c
      INNER JOIN latest l ON l.date = c.as_of_date
      INNER JOIN ticker_universe u
        ON u.ticker = c.ticker
       AND u.active = 1
      WHERE c.horizon_days IN (20, 40, 60)
        AND c.direction IN ('up', 'down')
        AND c.rank <= 8
        AND ${usInvestableSymbolSql('c.ticker')}
      ORDER BY c.horizon_days, CASE c.direction WHEN 'up' THEN 0 ELSE 1 END, c.rank
    `,
  )
  return rows.map((row) => {
    let stageCode: string | null = null
    try {
      const parsed = JSON.parse(row.featureJson) as { stageCode?: unknown }
      stageCode = typeof parsed.stageCode === 'string' ? parsed.stageCode : null
    } catch {
      stageCode = null
    }
    return {
      ...row,
      name: getUsSecondaryName(row.ticker, row.name),
      horizonDays: numeric(row.horizonDays),
      rank: numeric(row.rank),
      candidateScore: numeric(row.candidateScore),
      stageCode,
    }
  })
}

export async function loadUsModelEvaluations(): Promise<UsModelEvaluation[]> {
  const rows = await safeAll<UsModelEvaluation>(
    `
      WITH latest AS (
        SELECT MAX(evaluation_date) AS date
        FROM ml_model_evaluations
        WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)
      )
      SELECT
        e.evaluation_date AS evaluationDate,
        e.model_type AS modelType,
        e.direction,
        e.horizon_days AS horizonDays,
        e.sample_count AS sampleCount,
        e.precision_at_20 AS precisionAt20,
        e.precision_at_50 AS precisionAt50,
        e.hit_rate AS hitRate,
        e.median_return_pct AS medianReturnPct,
        e.max_drawdown_pct AS maxDrawdownPct
      FROM ml_model_evaluations e
      INNER JOIN latest l ON l.date = e.evaluation_date
      ORDER BY e.horizon_days, CASE e.direction WHEN 'up' THEN 0 ELSE 1 END
      LIMIT 30
    `,
  )
  return rows.map((row) => ({
    ...row,
    horizonDays: numeric(row.horizonDays),
    sampleCount: numeric(row.sampleCount),
    precisionAt20: nullableNumber(row.precisionAt20),
    precisionAt50: nullableNumber(row.precisionAt50),
    hitRate: nullableNumber(row.hitRate),
    medianReturnPct: nullableNumber(row.medianReturnPct),
    maxDrawdownPct: nullableNumber(row.maxDrawdownPct),
  }))
}

export async function loadUsCurrentSimilars(): Promise<UsCurrentSimilar[]> {
  const rows = await safeAll<UsCurrentSimilar>(
    `
      WITH latest AS (
        SELECT MAX(as_of_date) AS date
        FROM serving_current_similars
      ),
      eligible AS (
        SELECT
          s.*,
          ROW_NUMBER() OVER (
            PARTITION BY s.base_ticker
            ORDER BY s.rank ASC, s.similarity_score DESC, s.similar_ticker ASC
          ) AS eligible_rank
        FROM serving_current_similars s
        INNER JOIN latest l ON l.date = s.as_of_date
        INNER JOIN ticker_universe base_u
          ON base_u.ticker = s.base_ticker
         AND base_u.active = 1
        INNER JOIN ticker_universe similar_u
          ON similar_u.ticker = s.similar_ticker
         AND similar_u.active = 1
        WHERE ${usInvestableSymbolSql('s.base_ticker')}
          AND ${usInvestableSymbolSql('s.similar_ticker')}
      )
      SELECT
        s.as_of_date AS asOfDate,
        s.base_ticker AS baseTicker,
        s.similar_ticker AS similarTicker,
        s.similarity_score AS similarityScore,
        s.base_direction AS baseDirection,
        s.similar_direction AS similarDirection
      FROM eligible s
      WHERE s.eligible_rank = 1
      ORDER BY s.similarity_score DESC
      LIMIT 16
    `,
  )
  return rows.map((row) => ({ ...row, similarityScore: numeric(row.similarityScore) }))
}

export async function loadUsTransitionAnalysis(): Promise<{
  date: string | null
  distribution: UsPatternDistribution[]
  transitions: UsStageTransition[]
  patterns: UsPatternStat[]
}> {
  const [dateRow, distributionRows, transitionRows, patternRows] = await Promise.all([
    safeGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM daily_snapshots`),
    safeAll<UsPatternDistribution>(
      `
        WITH latest AS (SELECT MAX(date) AS date FROM daily_snapshots)
        SELECT
          printf(
            '%d%d%d%d%d%d',
            daily_a_stage,
            daily_b_stage,
            weekly_a_stage,
            weekly_b_stage,
            monthly_a_stage,
            monthly_b_stage
          ) AS patternCode,
          COUNT(*) AS count
        FROM daily_snapshots d
        INNER JOIN latest ON latest.date = d.date
        INNER JOIN ticker_universe u
          ON u.ticker = d.ticker
         AND u.active = 1
        WHERE daily_a_stage IS NOT NULL
          AND daily_b_stage IS NOT NULL
          AND weekly_a_stage IS NOT NULL
          AND weekly_b_stage IS NOT NULL
          AND monthly_a_stage IS NOT NULL
          AND monthly_b_stage IS NOT NULL
          AND ${usInvestableSymbolSql('d.ticker')}
        GROUP BY patternCode
        ORDER BY count DESC
        LIMIT 30
      `,
    ),
    safeAll<UsStageTransition>(
      `
        SELECT axis, from_stage AS fromStage, to_stage AS toStage, count
        FROM stage_transitions
        ORDER BY axis, from_stage, to_stage
      `,
    ),
    safeAll<UsPatternStat>(
      `
        SELECT
          pattern_code AS patternCode,
          count,
          p25,
          p50,
          p75
        FROM pattern_stats
        WHERE horizon_days = 60
          AND count >= 20
        ORDER BY count DESC
        LIMIT 30
      `,
    ),
  ])
  return {
    date: dateRow?.date ?? null,
    distribution: distributionRows.map((row) => ({ ...row, count: numeric(row.count) })),
    transitions: transitionRows.map((row) => ({
      ...row,
      fromStage: numeric(row.fromStage),
      toStage: numeric(row.toStage),
      count: numeric(row.count),
    })),
    patterns: patternRows.map((row) => ({
      ...row,
      count: numeric(row.count),
      p25: nullableNumber(row.p25),
      p50: nullableNumber(row.p50),
      p75: nullableNumber(row.p75),
    })),
  }
}

export async function loadUsBacktestAnalysis(): Promise<{
  servingDate: string | null
  modelEvaluations: UsModelEvaluation[]
  physicsStatus: UsPhysicsStatusEvaluation[]
  rlEvaluations: UsRlEvaluation[]
  similarityEvaluations: UsSimilarityEvaluation[]
}> {
  const [servingDate, modelEvaluations, physicsRows, rlRows, similarityRows] = await Promise.all([
    safeGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM serving_backtest_dates`),
    loadUsModelEvaluations(),
    safeAll<UsPhysicsStatusEvaluation>(
      `
        WITH latest AS (
          SELECT MAX(evaluation_date) AS date
          FROM ml_physics_status_evaluations
          WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)
        )
        SELECT
          e.evaluation_date AS evaluationDate,
          e.status_label AS statusLabel,
          e.target_direction AS targetDirection,
          e.horizon_days AS horizonDays,
          e.sample_count AS sampleCount,
          e.hit_rate AS hitRate,
          e.base_rate AS baseRate,
          e.lift,
          e.median_return_pct AS medianReturnPct,
          e.avg_max_return_pct AS avgMaxReturnPct,
          e.avg_min_return_pct AS avgMinReturnPct
        FROM ml_physics_status_evaluations e
        INNER JOIN latest l ON l.date = e.evaluation_date
        ORDER BY e.horizon_days, e.lift DESC
        LIMIT 36
      `,
    ),
    safeAll<UsRlEvaluation>(
      `
        WITH latest AS (
          SELECT MAX(evaluation_date) AS date
          FROM ml_rl_policy_evaluations
          WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)
        )
        SELECT
          e.evaluation_date AS evaluationDate,
          e.policy_name AS policyName,
          e.horizon_days AS horizonDays,
          e.sample_count AS sampleCount,
          e.win_rate AS winRate,
          e.oracle_match_rate AS oracleMatchRate,
          e.avg_reward AS avgReward,
          e.avg_return_pct AS avgReturnPct,
          e.max_drawdown_pct AS maxDrawdownPct
        FROM ml_rl_policy_evaluations e
        INNER JOIN latest l ON l.date = e.evaluation_date
        ORDER BY e.horizon_days, e.avg_reward DESC
        LIMIT 24
      `,
    ),
    safeAll<UsSimilarityEvaluation>(
      `
        WITH latest AS (
          SELECT MAX(as_of_date) AS date
          FROM ml_similarity_evaluations
          WHERE as_of_date <= (SELECT MAX(date) FROM ohlcv_daily)
        )
        SELECT
          e.as_of_date AS asOfDate,
          e.horizon_days AS horizonDays,
          e.source,
          e.base_count AS baseCount,
          e.pair_count AS pairCount,
          e.up_rate AS upRate,
          e.down_rate AS downRate,
          e.median_return_pct AS medianReturnPct,
          e.max_drawdown_pct AS maxDrawdownPct
        FROM ml_similarity_evaluations e
        INNER JOIN latest l ON l.date = e.as_of_date
        ORDER BY e.horizon_days, e.source
        LIMIT 24
      `,
    ),
  ])

  return {
    servingDate: servingDate?.date ?? null,
    modelEvaluations,
    physicsStatus: physicsRows.map((row) => ({
      ...row,
      horizonDays: numeric(row.horizonDays),
      sampleCount: numeric(row.sampleCount),
      hitRate: nullableNumber(row.hitRate),
      baseRate: nullableNumber(row.baseRate),
      lift: nullableNumber(row.lift),
      medianReturnPct: nullableNumber(row.medianReturnPct),
      avgMaxReturnPct: nullableNumber(row.avgMaxReturnPct),
      avgMinReturnPct: nullableNumber(row.avgMinReturnPct),
    })),
    rlEvaluations: rlRows.map((row) => ({
      ...row,
      horizonDays: numeric(row.horizonDays),
      sampleCount: numeric(row.sampleCount),
      winRate: nullableNumber(row.winRate),
      oracleMatchRate: nullableNumber(row.oracleMatchRate),
      avgReward: nullableNumber(row.avgReward),
      avgReturnPct: nullableNumber(row.avgReturnPct),
      maxDrawdownPct: nullableNumber(row.maxDrawdownPct),
    })),
    similarityEvaluations: similarityRows.map((row) => ({
      ...row,
      horizonDays: numeric(row.horizonDays),
      baseCount: numeric(row.baseCount),
      pairCount: numeric(row.pairCount),
      upRate: nullableNumber(row.upRate),
      downRate: nullableNumber(row.downRate),
      medianReturnPct: nullableNumber(row.medianReturnPct),
      maxDrawdownPct: nullableNumber(row.maxDrawdownPct),
    })),
  }
}
