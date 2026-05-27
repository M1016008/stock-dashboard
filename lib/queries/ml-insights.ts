import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { MIN_DISPLAY_SIMILARITY_SCORE } from '@/lib/ml/similarity-threshold'

export type MlDirectionFilter = 'up' | 'down' | 'both'

export type CurrentSimilarInsight = {
  asOfDate: string
  baseTicker: string
  rank: number
  similarTicker: string
  similarityScore: number
  baseDirection: 'up' | 'down' | null
  similarDirection: 'up' | 'down' | null
  payload: {
    base?: Record<string, unknown>
    similar?: Record<string, unknown>
  }
  reason: Record<string, string>
}

export type MlSectorRanking = {
  asOfDate: string
  sectorType: '17' | '33'
  sectorName: string
  direction: 'up' | 'down'
  candidateCount: number
  avgScore: number | null
  representativeTickers: Array<{
    ticker: string
    rank?: number
    score?: number
    direction?: 'up' | 'down'
  }>
}

export type MlPerformance = {
  asOfDate: string
  direction: 'up' | 'down'
  horizonDays: number
  sectorType: string
  sectorName: string
  sampleCount: number
  upRate: number | null
  downRate: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
  payload: Record<string, unknown>
}

export type MlModelStatus = {
  latestFeatureDate: string | null
  latestPhysicsFeatureDate: string | null
  latestPredictionDate: string | null
  latestEvaluationDate: string | null
  healthChecks: Array<{
    checkKey: string
    status: string
    expectedDate: string | null
    actualDate: string | null
    expectedCount: number | null
    actualCount: number | null
  }>
  similarityEvaluations: Array<{
    asOfDate: string
    horizonDays: number
    pairCount: number
    upRate: number | null
    downRate: number | null
    medianReturnPct: number | null
    maxDrawdownPct: number | null
  }>
  models: Array<{
    modelName: string
    modelType: string
    direction: 'up' | 'down' | 'wait'
    horizonDays: number
    metrics: Record<string, unknown>
    trainedAt: number | string | null
  }>
  rlPolicyEvaluations: Array<{
    evaluationDate: string
    policyName: string
    policyType: string
    horizonDays: number
    sampleCount: number
    winRate: number | null
    oracleMatchRate: number | null
    avgReward: number | null
    medianReward: number | null
    avgReturnPct: number | null
    maxDrawdownPct: number | null
    metrics: Record<string, unknown>
  }>
  evaluations: MlPerformance[]
}

export type MlPredictionHistoryRow = {
  asOfDate: string
  horizonDays: number
  direction: 'up' | 'down'
  ticker: string
  rank: number
  score: number
  modelName: string | null
  explanation: Record<string, unknown>
  outcome: {
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
    hitLabel: boolean
    missLabel: boolean
    payload: Record<string, unknown>
  } | null
}

type SimilarRow = {
  as_of_date: string
  base_ticker: string
  rank: number
  similar_ticker: string
  similarity_score: number
  base_direction: string | null
  similar_direction: string | null
  payload_json: string
  reason_json: string
}

type SectorRankingRow = {
  as_of_date: string
  sector_type: string
  sector_name: string
  direction: string
  candidate_count: number
  avg_score: number | null
  representative_tickers_json: string
}

type PerformanceRow = {
  as_of_date: string
  direction: string
  horizon_days: number
  sector_type: string
  sector_name: string
  sample_count: number
  up_rate: number | null
  down_rate: number | null
  median_return_pct: number | null
  avg_return_pct: number | null
  payload_json: string
}

type EvaluationRow = {
  evaluation_date: string
  model_name: string | null
  model_type: string
  direction: string
  horizon_days: number
  sample_count: number
  precision_at_20: number | null
  precision_at_50: number | null
  precision_at_80: number | null
  hit_rate: number | null
  median_return_pct: number | null
  avg_return_pct: number | null
  max_drawdown_pct: number | null
  metrics_json: string
}

type ModelRow = {
  model_name: string
  model_type: string
  direction: string
  horizon_days: number
  metrics_json: string
  trained_at: number | string | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function normalizeDirection(value: string | null): MlDirectionFilter {
  return value === 'up' || value === 'down' || value === 'both' ? value : 'both'
}

function dirOrNull(value: string | null): 'up' | 'down' | null {
  return value === 'up' || value === 'down' ? value : null
}

async function latestDate(table: string): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM ${table}`))?.date ?? null
}

async function latestCompleteSimilarDate(): Promise<string | null> {
  const latestSimilar = await latestDate('serving_current_similars')
  if (!latestSimilar) return null
  const counts = await execGet<{ base_count: number; feature_count: number }>(
    `
    SELECT
      (SELECT COUNT(DISTINCT base_ticker) FROM serving_current_similars WHERE as_of_date = ?) AS base_count,
      (SELECT COUNT(*) FROM ml_feature_vectors_v2 WHERE feature_set = ? AND date = ?) AS feature_count
    `,
    [latestSimilar, ML_PHYSICS_FEATURE_SET, latestSimilar],
  )
  const baseCount = Number(counts?.base_count ?? 0)
  const featureCount = Number(counts?.feature_count ?? 0)
  if (featureCount === 0 || baseCount >= Math.floor(featureCount * 0.85)) return latestSimilar

  const row = await execGet<{ date: string | null }>(
    `
    WITH candidate_dates AS (
      SELECT DISTINCT as_of_date
      FROM serving_current_similars
      WHERE as_of_date < ?
      ORDER BY as_of_date DESC
      LIMIT 20
    )
    SELECT c.as_of_date AS date
    FROM candidate_dates c
    WHERE
      (SELECT COUNT(DISTINCT base_ticker) FROM serving_current_similars WHERE as_of_date = c.as_of_date)
      >=
      CAST((
        SELECT COUNT(*)
        FROM ml_feature_vectors_v2
        WHERE feature_set = ? AND date = c.as_of_date
      ) * 0.85 AS INTEGER)
    ORDER BY c.as_of_date DESC
    LIMIT 1
    `,
    [latestSimilar, ML_PHYSICS_FEATURE_SET],
  )
  return row?.date ?? latestSimilar
}

async function latestColumnDate(table: string, column: string): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(${column}) AS date FROM ${table}`))?.date ?? null
}

export async function getCurrentSimilars(params: {
  ticker?: string | null
  date?: string | null
  limit?: number
} = {}): Promise<{ asOfDate: string | null; rows: CurrentSimilarInsight[] }> {
  const asOfDate = params.date ?? await latestCompleteSimilarDate()
  if (!asOfDate) return { asOfDate: null, rows: [] }
  const limit = Math.min(200, Math.max(1, params.limit ?? 20))
  const ticker = params.ticker?.trim()
  const where = ticker ? 'as_of_date = ? AND base_ticker = ?' : 'as_of_date = ?'
  const args: Array<string | number> = ticker ? [asOfDate, ticker] : [asOfDate]
  const filteredWhere = `${where} AND similarity_score >= ?`
  const rows = await execAll<SimilarRow>(
    `
    SELECT as_of_date, base_ticker, rank, similar_ticker, similarity_score,
           base_direction, similar_direction, payload_json, reason_json
    FROM serving_current_similars
    WHERE ${filteredWhere}
    ORDER BY ${ticker ? 'rank ASC' : 'similarity_score DESC, base_ticker ASC, rank ASC'}
    LIMIT ?
    `,
    [...args, MIN_DISPLAY_SIMILARITY_SCORE, limit],
  )
  return {
    asOfDate,
    rows: rows.map((row) => ({
      asOfDate: row.as_of_date,
      baseTicker: row.base_ticker,
      rank: Number(row.rank),
      similarTicker: row.similar_ticker,
      similarityScore: Number(row.similarity_score),
      baseDirection: dirOrNull(row.base_direction),
      similarDirection: dirOrNull(row.similar_direction),
      payload: parseJson(row.payload_json, {}),
      reason: parseJson(row.reason_json, {}),
    })),
  }
}

export async function getMlSectorRankings(params: {
  sectorType?: '17' | '33' | 'all'
  direction?: MlDirectionFilter
  date?: string | null
  limit?: number
} = {}): Promise<{ asOfDate: string | null; rows: MlSectorRanking[] }> {
  const asOfDate = params.date ?? await latestDate('serving_ml_sector_rankings')
  if (!asOfDate) return { asOfDate: null, rows: [] }
  const sectorType = params.sectorType ?? 'all'
  const direction = normalizeDirection(params.direction ?? 'both')
  const limit = Math.min(200, Math.max(1, params.limit ?? 20))
  const where: string[] = ['as_of_date = ?']
  const args: Array<string | number> = [asOfDate]
  if (sectorType !== 'all') {
    where.push('sector_type = ?')
    args.push(sectorType)
  }
  if (direction !== 'both') {
    where.push('direction = ?')
    args.push(direction)
  }
  const rows = await execAll<SectorRankingRow>(
    `
    SELECT as_of_date, sector_type, sector_name, direction, candidate_count, avg_score, representative_tickers_json
    FROM serving_ml_sector_rankings
    WHERE ${where.join(' AND ')}
    ORDER BY direction ASC, sector_type ASC, candidate_count DESC, avg_score DESC
    LIMIT ?
    `,
    [...args, limit],
  )
  return {
    asOfDate,
    rows: rows.map((row) => ({
      asOfDate: row.as_of_date,
      sectorType: row.sector_type === '33' ? '33' : '17',
      sectorName: row.sector_name,
      direction: row.direction === 'down' ? 'down' : 'up',
      candidateCount: Number(row.candidate_count),
      avgScore: row.avg_score == null ? null : Number(row.avg_score),
      representativeTickers: parseJson(row.representative_tickers_json, []),
    })),
  }
}

export async function getMlPerformance(params: {
  direction?: MlDirectionFilter
  horizonDays?: number | null
  sectorType?: string | null
  date?: string | null
  limit?: number
} = {}): Promise<{ asOfDate: string | null; rows: MlPerformance[] }> {
  const evalDate = params.date ?? await latestColumnDate('ml_model_evaluations', 'evaluation_date')
  if (evalDate) {
    const direction = normalizeDirection(params.direction ?? 'both')
    const limit = Math.min(300, Math.max(1, params.limit ?? 40))
    const where: string[] = ['evaluation_date = ?']
    const args: Array<string | number> = [evalDate]
    if (direction !== 'both') {
      where.push('direction = ?')
      args.push(direction)
    }
    if (params.horizonDays) {
      where.push('horizon_days = ?')
      args.push(params.horizonDays)
    }
    const rows = await execAll<EvaluationRow>(
      `
      SELECT evaluation_date, model_name, model_type, direction, horizon_days, sample_count,
             precision_at_20, precision_at_50, precision_at_80, hit_rate,
             median_return_pct, avg_return_pct, max_drawdown_pct, metrics_json
      FROM ml_model_evaluations
      WHERE ${where.join(' AND ')}
      ORDER BY horizon_days ASC, direction ASC, validation_end_date DESC, sample_count DESC
      LIMIT ?
      `,
      [...args, limit],
    )
    if (rows.length > 0) {
      return {
        asOfDate: evalDate,
        rows: rows.map((row) => ({
          asOfDate: row.evaluation_date,
          direction: row.direction === 'down' ? 'down' : 'up',
          horizonDays: Number(row.horizon_days),
          sectorType: 'all',
          sectorName: 'ALL',
          sampleCount: Number(row.sample_count),
          upRate: row.direction === 'up' ? row.hit_rate : null,
          downRate: row.direction === 'down' ? row.hit_rate : null,
          medianReturnPct: row.median_return_pct == null ? null : Number(row.median_return_pct),
          avgReturnPct: row.avg_return_pct == null ? null : Number(row.avg_return_pct),
          payload: {
            mode: 'model_evaluation',
            modelName: row.model_name,
            modelType: row.model_type,
            precisionAt20: row.precision_at_20,
            precisionAt50: row.precision_at_50,
            precisionAt80: row.precision_at_80,
            hitRate: row.hit_rate,
            maxDrawdownPct: row.max_drawdown_pct,
            metrics: parseJson(row.metrics_json, {}),
          },
        })),
      }
    }
  }

  const asOfDate = params.date ?? await latestDate('serving_ml_performance')
  if (!asOfDate) return { asOfDate: null, rows: [] }
  const direction = normalizeDirection(params.direction ?? 'both')
  const limit = Math.min(300, Math.max(1, params.limit ?? 40))
  const where: string[] = ['as_of_date = ?']
  const args: Array<string | number> = [asOfDate]
  if (direction !== 'both') {
    where.push('direction = ?')
    args.push(direction)
  }
  if (params.horizonDays) {
    where.push('horizon_days = ?')
    args.push(params.horizonDays)
  }
  if (params.sectorType) {
    where.push('sector_type = ?')
    args.push(params.sectorType)
  }
  const rows = await execAll<PerformanceRow>(
    `
    SELECT as_of_date, direction, horizon_days, sector_type, sector_name, sample_count,
           up_rate, down_rate, median_return_pct, avg_return_pct, payload_json
    FROM serving_ml_performance
    WHERE ${where.join(' AND ')}
    ORDER BY horizon_days ASC, direction ASC, sector_type ASC, sample_count DESC
    LIMIT ?
    `,
    [...args, limit],
  )
  return {
    asOfDate,
    rows: rows.map((row) => ({
      asOfDate: row.as_of_date,
      direction: row.direction === 'down' ? 'down' : 'up',
      horizonDays: Number(row.horizon_days),
      sectorType: row.sector_type,
      sectorName: row.sector_name,
      sampleCount: Number(row.sample_count),
      upRate: row.up_rate == null ? null : Number(row.up_rate),
      downRate: row.down_rate == null ? null : Number(row.down_rate),
      medianReturnPct: row.median_return_pct == null ? null : Number(row.median_return_pct),
      avgReturnPct: row.avg_return_pct == null ? null : Number(row.avg_return_pct),
      payload: parseJson(row.payload_json, {}),
    })),
  }
}

export async function getMlModelStatus(): Promise<MlModelStatus> {
  const [latestFeatureDate, latestPhysicsFeatureDate, latestPredictionDate, latestEvaluationDate, modelRows, evaluations, healthRows, similarityRows, rlPolicyRows] = await Promise.all([
    latestColumnDate('ml_feature_vectors', 'date'),
    latestColumnDate('ml_feature_vectors_v2', 'date'),
    latestColumnDate('ml_predictions', 'as_of_date'),
    latestColumnDate('ml_model_evaluations', 'evaluation_date'),
    execAll<ModelRow>(
      `
      SELECT m.model_name, m.model_type, m.direction, m.horizon_days, m.metrics_json, m.trained_at
      FROM ml_models m
      WHERE NOT EXISTS (
        SELECT 1
        FROM ml_models newer
        WHERE newer.direction = m.direction
          AND newer.horizon_days = m.horizon_days
          AND newer.trained_at > m.trained_at
      )
      ORDER BY m.horizon_days ASC, m.direction ASC
      `,
    ),
    getMlPerformance({ limit: 12 }),
    execAll<{
      check_key: string
      status: string
      expected_date: string | null
      actual_date: string | null
      expected_count: number | null
      actual_count: number | null
    }>(
      `
      WITH latest AS (
        SELECT MAX(check_date) AS check_date FROM ml_feature_health_checks
      )
      SELECT check_key, status, expected_date, actual_date, expected_count, actual_count
      FROM ml_feature_health_checks h
      INNER JOIN latest l ON l.check_date = h.check_date
      ORDER BY check_key
      `,
    ),
    execAll<{
      as_of_date: string
      horizon_days: number
      pair_count: number
      up_rate: number | null
      down_rate: number | null
      median_return_pct: number | null
      max_drawdown_pct: number | null
    }>(
      `
      WITH latest AS (
        SELECT MAX(as_of_date) AS as_of_date FROM ml_similarity_evaluations
      )
      SELECT e.as_of_date, e.horizon_days, e.pair_count, e.up_rate, e.down_rate, e.median_return_pct, e.max_drawdown_pct
      FROM ml_similarity_evaluations e
      INNER JOIN latest l ON l.as_of_date = e.as_of_date
      ORDER BY e.horizon_days
      `,
    ),
    execAll<{
      evaluation_date: string
      policy_name: string
      policy_type: string
      horizon_days: number
      sample_count: number
      win_rate: number | null
      oracle_match_rate: number | null
      avg_reward: number | null
      median_reward: number | null
      avg_return_pct: number | null
      max_drawdown_pct: number | null
      metrics_json: string
    }>(
      `
      WITH latest AS (
        SELECT MAX(evaluation_date) AS evaluation_date FROM ml_rl_policy_evaluations
      )
      SELECT e.evaluation_date, e.policy_name, e.policy_type, e.horizon_days, e.sample_count,
             e.win_rate, e.oracle_match_rate, e.avg_reward, e.median_reward,
             e.avg_return_pct, e.max_drawdown_pct, e.metrics_json
      FROM ml_rl_policy_evaluations e
      INNER JOIN latest l ON l.evaluation_date = e.evaluation_date
      ORDER BY e.horizon_days ASC, e.policy_name ASC
      `,
    ),
  ])
  return {
    latestFeatureDate,
    latestPhysicsFeatureDate,
    latestPredictionDate,
    latestEvaluationDate,
    healthChecks: healthRows.map((row) => ({
      checkKey: row.check_key,
      status: row.status,
      expectedDate: row.expected_date,
      actualDate: row.actual_date,
      expectedCount: row.expected_count == null ? null : Number(row.expected_count),
      actualCount: row.actual_count == null ? null : Number(row.actual_count),
    })),
    similarityEvaluations: similarityRows.map((row) => ({
      asOfDate: row.as_of_date,
      horizonDays: Number(row.horizon_days),
      pairCount: Number(row.pair_count),
      upRate: row.up_rate == null ? null : Number(row.up_rate),
      downRate: row.down_rate == null ? null : Number(row.down_rate),
      medianReturnPct: row.median_return_pct == null ? null : Number(row.median_return_pct),
      maxDrawdownPct: row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
    })),
    models: modelRows.map((row) => ({
      modelName: row.model_name,
      modelType: row.model_type,
      direction: row.direction === 'down' ? 'down' : row.direction === 'wait' ? 'wait' : 'up',
      horizonDays: Number(row.horizon_days),
      metrics: parseJson(row.metrics_json, {}),
      trainedAt: row.trained_at,
    })),
    rlPolicyEvaluations: rlPolicyRows.map((row) => ({
      evaluationDate: row.evaluation_date,
      policyName: row.policy_name,
      policyType: row.policy_type,
      horizonDays: Number(row.horizon_days),
      sampleCount: Number(row.sample_count),
      winRate: row.win_rate == null ? null : Number(row.win_rate),
      oracleMatchRate: row.oracle_match_rate == null ? null : Number(row.oracle_match_rate),
      avgReward: row.avg_reward == null ? null : Number(row.avg_reward),
      medianReward: row.median_reward == null ? null : Number(row.median_reward),
      avgReturnPct: row.avg_return_pct == null ? null : Number(row.avg_return_pct),
      maxDrawdownPct: row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
      metrics: parseJson(row.metrics_json, {}),
    })),
    evaluations: evaluations.rows,
  }
}

export async function getMlPredictionHistory(params: {
  ticker: string
  limit?: number
}): Promise<{ ticker: string; rows: MlPredictionHistoryRow[] }> {
  const ticker = params.ticker.replace(/\.T$/i, '').trim()
  const limit = Math.min(300, Math.max(1, params.limit ?? 80))
  const rows = await execAll<{
    as_of_date: string
    horizon_days: number
    direction: string
    ticker: string
    rank: number
    score: number
    model_name: string | null
    explanation_json: string
    return_pct: number | null
    max_return_pct: number | null
    min_return_pct: number | null
    hit_label: number | null
    miss_label: number | null
    outcome_json: string | null
  }>(
    `
    SELECT p.as_of_date, p.horizon_days, p.direction, p.ticker, p.rank, p.score,
           p.model_name, p.explanation_json,
           o.return_pct, o.max_return_pct, o.min_return_pct, o.hit_label, o.miss_label, o.outcome_json
    FROM ml_predictions p
    LEFT JOIN ml_prediction_outcomes o
      ON o.as_of_date = p.as_of_date
     AND o.horizon_days = p.horizon_days
     AND o.direction = p.direction
     AND o.ticker = p.ticker
    WHERE p.ticker = ?
    ORDER BY p.as_of_date DESC, p.horizon_days ASC, p.direction ASC
    LIMIT ?
    `,
    [ticker, limit],
  )
  return {
    ticker,
    rows: rows.map((row) => ({
      asOfDate: row.as_of_date,
      horizonDays: Number(row.horizon_days),
      direction: row.direction === 'down' ? 'down' : 'up',
      ticker: row.ticker,
      rank: Number(row.rank),
      score: Number(row.score),
      modelName: row.model_name,
      explanation: parseJson(row.explanation_json, {}),
      outcome: row.outcome_json
        ? {
            returnPct: row.return_pct == null ? null : Number(row.return_pct),
            maxReturnPct: row.max_return_pct == null ? null : Number(row.max_return_pct),
            minReturnPct: row.min_return_pct == null ? null : Number(row.min_return_pct),
            hitLabel: Boolean(row.hit_label),
            missLabel: Boolean(row.miss_label),
            payload: parseJson(row.outcome_json, {}),
          }
        : null,
    })),
  }
}
