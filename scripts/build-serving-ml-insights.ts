// scripts/build-serving-ml-insights.ts
//
// ML候補を画面で使いやすくするため、最新類似銘柄・業種ランキング・モデル成績を軽量テーブルへ集約する。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { dot, sigmoid, type MlDirection, type MlFeatureProfile } from '@/lib/backtest/ml'
import { ML_PHYSICS_FEATURE_SET, type PhysicsDirection, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
import { physicsSimilarity, physicsSimilarityScore } from '@/lib/ml/physics-similarity'

type FeatureRow = {
  ticker: string
  date: string
  stage_code: string | null
  feature_json: string
  vector_json: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

type CandidateRow = {
  as_of_date: string
  direction: MlDirection | PhysicsDirection
  rank: number
  ticker: string
  candidate_score: number
  explanation_json: string
}

type DirectionalCandidateRow = CandidateRow & { direction: MlDirection }

type ModelRow = {
  model_name: string
  direction: MlDirection
  horizon_days: number
  weights_json: string
  intercept: number
  metrics_json: string
  trained_at: number | string | null
}

type PerformanceSampleRow = {
  ticker: string
  date: string
  vector_json: string
  return_pct: number | null
  sector17_name: string | null
  sector33_name: string | null
}

type ScoredPerformanceRow = {
  ticker: string
  date: string
  score: number
  returnPct: number
  sector17Name: string
  sector33Name: string
}

const SIMILAR_LIMIT = Math.max(1, Number(process.env.ML_SIMILAR_LIMIT ?? 5))
const SIMILAR_BASE_LIMIT = Number(process.env.ML_SIMILAR_BASE_LIMIT ?? 0)
const PERFORMANCE_PER_YEAR_LIMIT = Math.max(100, Number(process.env.ML_PERFORMANCE_PER_YEAR_LIMIT ?? 900))
const PERFORMANCE_TOP_LIMIT = Math.max(500, Number(process.env.ML_PERFORMANCE_TOP_LIMIT ?? 8000))
const PERFORMANCE_MIN_SECTOR_N = Math.max(10, Number(process.env.ML_PERFORMANCE_MIN_SECTOR_N ?? 20))
const PERFORMANCE_MODE = (process.env.ML_PERFORMANCE_MODE ?? 'metrics').trim()

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (!finite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function latestDate(): Promise<string | null> {
  return execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
    [ML_PHYSICS_FEATURE_SET],
  )
    .then((row) => row?.date ?? null)
}

async function loadLatestFeatures(date: string): Promise<FeatureRow[]> {
  return execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ?
      AND f.date = ?
    `,
    [ML_PHYSICS_FEATURE_SET, date],
  )
}

async function loadCandidates(date: string): Promise<CandidateRow[]> {
  return execAll<CandidateRow>(
    `
    SELECT as_of_date, direction, rank, ticker, candidate_score, explanation_json
    FROM serving_ml_physics_candidates
    WHERE as_of_date = ?
      AND horizon_days = ?
    ORDER BY direction, rank
    LIMIT ?
    `,
    [date, Number(process.env.ML_SIMILAR_PHYSICS_HORIZON ?? 10), Math.max(1, Number(process.env.ML_SIMILAR_CANDIDATE_LIMIT ?? 2000))],
  )
}

async function loadModels(): Promise<ModelRow[]> {
  return execAll<ModelRow>(
    `
    SELECT model_name, direction, horizon_days, weights_json, intercept, metrics_json, trained_at
    FROM ml_models
    ORDER BY horizon_days ASC, direction ASC, trained_at DESC
    `,
  )
}

function vectorDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let sum = 0
  let used = 0
  for (let i = 0; i < length; i += 1) {
    const av = a[i]
    const bv = b[i]
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue
    const diff = av - bv
    sum += diff * diff
    used += 1
  }
  return used === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sum / used)
}

function stageSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const length = Math.min(a.length, b.length, 6)
  if (length === 0) return 0
  let same = 0
  for (let i = 0; i < length; i += 1) if (a[i] === b[i]) same += 1
  return same / 6
}

function summarizeProfile(profile: Partial<MlFeatureProfile & PhysicsFeatureProfile> | null): Record<string, unknown> {
  if (!profile) return {}
  return {
    close: profile.close,
    stageCode: profile.stageCode,
    maOrder: profile.maOrder,
    slopes5: profile.slopes5,
    slopes10: profile.slopes10,
    velocities: profile.velocities,
    accelerations: profile.accelerations,
    gaps: profile.gaps,
    gapVelocity: profile.gapVelocity,
    gapAcceleration: profile.gapAcceleration,
    pricePosition: profile.pricePosition,
    daysHeldAboveSma5: profile.daysHeldAboveSma5,
    daysAboveSma5: profile.daysAboveSma5,
    daysAboveSma25: profile.daysAboveSma25,
    distanceToRecentHighPct: profile.distanceToRecentHighPct,
    distanceToRecentLowPct: profile.distanceToRecentLowPct,
    regimes: profile.regimes,
    context: profile.context,
    timeSince: profile.timeSince,
  }
}

async function buildCurrentSimilars(date: string, features: FeatureRow[], candidates: CandidateRow[]): Promise<number> {
  const featureItems = features
    .map((row) => ({
      row,
      vector: parseJson<number[]>(row.vector_json, []),
      profile: parseJson<PhysicsFeatureProfile | null>(row.feature_json, null),
    }))
    .filter((item) => item.vector.length > 0)
  const featureByTicker = new Map(featureItems.map((item) => [item.row.ticker, item]))
  const bestCandidateByTicker = new Map<string, CandidateRow>()
  for (const candidate of candidates) {
    const current = bestCandidateByTicker.get(candidate.ticker)
    if (!current || candidate.candidate_score > current.candidate_score) bestCandidateByTicker.set(candidate.ticker, candidate)
  }

  await execRun(`DELETE FROM serving_current_similars WHERE as_of_date = ?`, [date])
  const baseItems = SIMILAR_BASE_LIMIT > 0
    ? Array.from(bestCandidateByTicker.values())
        .map((candidate) => featureByTicker.get(candidate.ticker))
        .filter((item): item is (typeof featureItems)[number] => Boolean(item))
        .slice(0, SIMILAR_BASE_LIMIT)
    : featureItems
  const stmts = baseItems.flatMap((base) => {
    const candidate = bestCandidateByTicker.get(base.row.ticker)
    const ranked: Array<{ item: (typeof featureItems)[number]; score: number; similarCandidate: CandidateRow | undefined }> = []
    for (const item of featureItems) {
      if (item.row.ticker === base.row.ticker) continue
      const score = physicsSimilarityScore(base.profile ?? {}, item.profile ?? {}, base.row.stage_code, item.row.stage_code)
      const entry = { item, score, similarCandidate: bestCandidateByTicker.get(item.row.ticker) }
      if (ranked.length < SIMILAR_LIMIT) {
        ranked.push(entry)
        continue
      }
      let lowestIndex = 0
      for (let i = 1; i < ranked.length; i += 1) {
        if (ranked[i].score < ranked[lowestIndex].score) lowestIndex = i
      }
      if (score > ranked[lowestIndex].score) ranked[lowestIndex] = entry
    }
    ranked.sort((a, b) => b.score - a.score)

    return ranked.map((similar, index) => {
      const reason = physicsSimilarity(
        base.profile ?? {},
        similar.item.profile ?? {},
        base.row.stage_code,
        similar.item.row.stage_code,
      ).reason
      const payload = {
        base: {
          ticker: base.row.ticker,
          name: base.row.name,
          marketSegment: base.row.market_segment,
          sector17Name: base.row.sector17_name,
          sector33Name: base.row.sector33_name,
          direction: candidate?.direction ?? null,
          score: candidate ? round(candidate.candidate_score, 4) : null,
          ...summarizeProfile(base.profile),
        },
        similar: {
          ticker: similar.item.row.ticker,
          name: similar.item.row.name,
          marketSegment: similar.item.row.market_segment,
          sector17Name: similar.item.row.sector17_name,
          sector33Name: similar.item.row.sector33_name,
          direction: similar.similarCandidate?.direction ?? null,
          score: similar.similarCandidate ? round(similar.similarCandidate.candidate_score, 4) : null,
          ...summarizeProfile(similar.item.profile),
        },
      }
      return {
        sql: `
          INSERT OR REPLACE INTO serving_current_similars
            (as_of_date, base_ticker, rank, similar_ticker, similarity_score,
             base_direction, similar_direction, payload_json, reason_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          date,
          base.row.ticker,
          index + 1,
          similar.item.row.ticker,
          round(similar.score, 6),
          candidate?.direction ?? null,
          similar.similarCandidate?.direction ?? null,
          JSON.stringify(payload),
          JSON.stringify(reason),
        ],
      }
    })
  })
  await execBatch(stmts)
  return stmts.length
}

async function buildSectorRankings(date: string, candidates: CandidateRow[]): Promise<number> {
  type Group = {
    asOfDate: string
    sectorType: '17' | '33'
    sectorName: string
    direction: MlDirection
    scores: number[]
    reps: Array<{ ticker: string; rank: number; score: number; direction: MlDirection }>
  }
  const directionalCandidates = candidates.filter((candidate): candidate is DirectionalCandidateRow =>
    candidate.direction === 'up' || candidate.direction === 'down',
  )
  const rows = await execAll<{
    ticker: string
    sector17_name: string | null
    sector33_name: string | null
  }>(
    `
    SELECT ticker, sector17_name, sector33_name
    FROM ticker_universe
    WHERE ticker IN (${directionalCandidates.map(() => '?').join(',') || "''"})
    `,
    directionalCandidates.map((candidate) => candidate.ticker),
  )
  const sectorByTicker = new Map(rows.map((row) => [row.ticker, row]))
  const groups = new Map<string, Group>()
  function add(candidate: DirectionalCandidateRow, sectorType: '17' | '33', sectorName: string | null) {
    const normalized = sectorName?.trim() || 'その他'
    const key = `${sectorType}\t${normalized}\t${candidate.direction}`
    let group = groups.get(key)
    if (!group) {
      group = { asOfDate: date, sectorType, sectorName: normalized, direction: candidate.direction, scores: [], reps: [] }
      groups.set(key, group)
    }
    const target = group
    target.scores.push(candidate.candidate_score)
    target.reps.push({
      ticker: candidate.ticker,
      rank: candidate.rank,
      score: round(candidate.candidate_score, 4) ?? 0,
      direction: candidate.direction,
    })
  }
  for (const candidate of directionalCandidates) {
    const sectors = sectorByTicker.get(candidate.ticker)
    add(candidate, '17', sectors?.sector17_name ?? null)
    add(candidate, '33', sectors?.sector33_name ?? null)
  }

  await execRun(`DELETE FROM serving_ml_sector_rankings WHERE as_of_date = ?`, [date])
  const stmts = Array.from(groups.values()).map((group) => {
    const avg = group.scores.reduce((sum, value) => sum + value, 0) / Math.max(1, group.scores.length)
    const reps = group.reps.sort((a, b) => a.rank - b.rank).slice(0, 10)
    return {
      sql: `
        INSERT OR REPLACE INTO serving_ml_sector_rankings
          (as_of_date, sector_type, sector_name, direction, candidate_count, avg_score, representative_tickers_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        group.asOfDate,
        group.sectorType,
        group.sectorName,
        group.direction,
        group.reps.length,
        round(avg, 6),
        JSON.stringify(reps),
      ],
    }
  })
  await execBatch(stmts)
  return stmts.length
}

async function sampleRows(horizonDays: number): Promise<PerformanceSampleRow[]> {
  const years = await execAll<{ year: string }>(
    `
    SELECT DISTINCT substr(date, 1, 4) AS year
    FROM forward_returns
    WHERE horizon_days = ?
    ORDER BY year
    `,
    [horizonDays],
  )
  const out: PerformanceSampleRow[] = []
  for (const row of years) {
    const from = `${row.year}-01-01`
    const to = `${Number(row.year) + 1}-01-01`
    out.push(...await execAll<PerformanceSampleRow>(
      `
      SELECT f.ticker, f.date, f.vector_json, r.return_pct, u.sector17_name, u.sector33_name
      FROM forward_returns r
      INNER JOIN ml_feature_vectors f ON f.ticker = r.ticker AND f.date = r.date
      LEFT JOIN ticker_universe u ON u.ticker = r.ticker
      WHERE r.horizon_days = ?
        AND r.date >= ?
        AND r.date < ?
        AND r.return_pct IS NOT NULL
      ORDER BY r.date ASC, r.ticker ASC
      LIMIT ?
      `,
      [horizonDays, from, to, PERFORMANCE_PER_YEAR_LIMIT],
    ))
  }
  return out
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function summarizePerformance(rows: ScoredPerformanceRow[]) {
  const returns = rows.map((row) => row.returnPct).filter(Number.isFinite)
  const upCount = returns.filter((value) => value > 0).length
  const downCount = returns.filter((value) => value < 0).length
  const avg = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length)
  return {
    sampleCount: returns.length,
    upRate: returns.length ? upCount / returns.length : null,
    downRate: returns.length ? downCount / returns.length : null,
    medianReturnPct: median(returns),
    avgReturnPct: returns.length ? avg : null,
  }
}

function performanceInsert(date: string, direction: MlDirection, horizonDays: number, sectorType: string, sectorName: string, rows: ScoredPerformanceRow[]) {
  const summary = summarizePerformance(rows)
  return {
    sql: `
      INSERT OR REPLACE INTO serving_ml_performance
        (as_of_date, direction, horizon_days, sector_type, sector_name, sample_count,
         up_rate, down_rate, median_return_pct, avg_return_pct, payload_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    args: [
      date,
      direction,
      horizonDays,
      sectorType,
      sectorName,
      summary.sampleCount,
      round(summary.upRate, 6),
      round(summary.downRate, 6),
      round(summary.medianReturnPct, 4),
      round(summary.avgReturnPct, 4),
      JSON.stringify({
        ...summary,
        topSamples: rows.slice(0, 12).map((row) => ({
          ticker: row.ticker,
          date: row.date,
          score: round(row.score, 4),
          returnPct: round(row.returnPct, 2),
          sector17Name: row.sector17Name,
          sector33Name: row.sector33Name,
        })),
      }),
    ],
  }
}

async function buildPerformance(date: string, models: ModelRow[]): Promise<number> {
  await execRun(`DELETE FROM serving_ml_performance WHERE as_of_date = ?`, [date])
  if (PERFORMANCE_MODE !== 'sample') {
    const latestByModel = new Map<string, ModelRow>()
    for (const model of models) {
      const key = `${model.horizon_days}\t${model.direction}`
      if (!latestByModel.has(key)) latestByModel.set(key, model)
    }
    const stmts = Array.from(latestByModel.values()).map((model) => {
      const metrics = parseJson<Record<string, unknown>>(model.metrics_json, {})
      const samples = Number(metrics.samples)
      return {
        sql: `
          INSERT OR REPLACE INTO serving_ml_performance
            (as_of_date, direction, horizon_days, sector_type, sector_name, sample_count,
             up_rate, down_rate, median_return_pct, avg_return_pct, payload_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          date,
          model.direction,
          model.horizon_days,
          'all',
          'ALL',
          Number.isFinite(samples) ? samples : 0,
          null,
          null,
          null,
          null,
          JSON.stringify({
            mode: 'training_metrics',
            modelName: model.model_name,
            modelType: 'logistic_regression_v1',
            direction: model.direction,
            horizonDays: model.horizon_days,
            metrics,
            trainedAt: model.trained_at,
          }),
        ],
      }
    })
    await execBatch(stmts)
    return stmts.length
  }

  const latestByModel = new Map<string, ModelRow>()
  for (const model of models) {
    const key = `${model.horizon_days}\t${model.direction}`
    if (!latestByModel.has(key)) latestByModel.set(key, model)
  }
  const horizons = Array.from(new Set(Array.from(latestByModel.values()).map((model) => model.horizon_days))).sort((a, b) => a - b)
  const stmts: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const horizon of horizons) {
    const samples = await sampleRows(horizon)
    for (const direction of ['up', 'down'] as const) {
      const model = latestByModel.get(`${horizon}\t${direction}`)
      if (!model) continue
      const weights = parseJson<number[]>(model.weights_json, [])
      const scored = samples
        .map((sample) => {
          const vector = parseJson<number[]>(sample.vector_json, [])
          if (vector.length === 0 || !finite(sample.return_pct)) return null
          return {
            ticker: sample.ticker,
            date: sample.date,
            score: sigmoid((model.intercept ?? 0) + dot(weights, vector)),
            returnPct: sample.return_pct,
            sector17Name: sample.sector17_name?.trim() || 'その他',
            sector33Name: sample.sector33_name?.trim() || 'その他',
          }
        })
        .filter((row): row is ScoredPerformanceRow => row != null)
        .sort((a, b) => b.score - a.score)
        .slice(0, PERFORMANCE_TOP_LIMIT)

      stmts.push(performanceInsert(date, direction, horizon, 'all', 'ALL', scored))
      for (const sectorType of ['17', '33'] as const) {
        const groups = new Map<string, ScoredPerformanceRow[]>()
        for (const row of scored) {
          const key = sectorType === '17' ? row.sector17Name : row.sector33Name
          const group = groups.get(key) ?? []
          group.push(row)
          groups.set(key, group)
        }
        for (const [sectorName, group] of groups) {
          if (group.length < PERFORMANCE_MIN_SECTOR_N) continue
          stmts.push(performanceInsert(date, direction, horizon, sectorType, sectorName, group))
        }
      }
    }
  }
  await execBatch(stmts)
  return stmts.length
}

async function main() {
  const date = await latestDate()
  if (!date) {
    console.log('serving ml insights: ml_feature_vectors is empty')
    return
  }

  const [features, candidates, models] = await Promise.all([
    loadLatestFeatures(date),
    loadCandidates(date),
    loadModels(),
  ])
  if (candidates.length === 0) {
    console.log(`serving ml insights ${date}: serving_ml_candidates is empty`)
  }

  const similarRows = await buildCurrentSimilars(date, features, candidates)
  const sectorRows = await buildSectorRankings(date, candidates)
  const performanceRows = await buildPerformance(date, models)
  console.log(
    `serving ml insights ${date}: features=${features.length.toLocaleString()}, candidates=${candidates.length}, similars=${similarRows}, sectors=${sectorRows}, performance=${performanceRows}`,
  )
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
