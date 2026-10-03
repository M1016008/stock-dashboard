import { execAll } from '@/lib/db/client'
import { execUsAnalyticsAll } from '@/lib/db/us-analytics'
import { normalizedVectorSimilarity } from '@/lib/ml/historical-analogs'
import {
  MA_SEQUENCE_SCORING_PROFILES,
  findMaSequenceIndex,
  prepareMaSequence,
  rescoreMaSequenceComponents,
  scoreMaSequence,
  scoreMaSequenceAligned,
  type MaSequencePrepared,
  type MaSequencePriceRow,
  type MaSequenceScoringProfile,
  type MaSequenceScoreComponent,
} from '@/lib/ml/ma-sequence'

type Market = 'JP' | 'US'
type Split = 'calibration' | 'holdout'

type PriceRow = MaSequencePriceRow & {
  ticker: string
}

type PreparedTicker = {
  ticker: string
  prepared: MaSequencePrepared
  vectors: Map<string, number[]>
}

type BaseCase = {
  market: Market
  split: Split
  ticker: string
  date: string
  index: number
  prepared: MaSequencePrepared
  vectors: Map<string, number[]>
}

type Candidate = {
  ticker: string
  date: string
  index: number
  prepared: MaSequencePrepared
  components: MaSequenceScoreComponent[]
  mlSimilarity: number | null
  outcomes: Map<number, number>
}

type Prediction = {
  market: Market
  split: Split
  baseTicker: string
  baseDate: string
  profileKey: string
  horizon: number
  actual: number
  predicted: number
  directionHit: boolean
  absoluteError: number
}

const PANELS: Record<Market, string[]> = {
  JP: ['7003', '6496', '7203', '6758', '8306', '6501'],
  US: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'JPM', 'XOM'],
}

const SPLIT_DATES: Array<{ split: Split; date: string }> = [
  { split: 'calibration', date: '2019-06-28' },
  { split: 'calibration', date: '2020-06-30' },
  { split: 'calibration', date: '2021-06-30' },
  { split: 'calibration', date: '2022-06-30' },
  { split: 'calibration', date: '2023-06-30' },
  { split: 'holdout', date: '2024-06-28' },
  { split: 'holdout', date: '2025-06-30' },
]

const HORIZONS = [20, 60, 200] as const
const ERROR_SCALES = new Map<number, number>([
  [20, 12],
  [60, 22],
  [200, 40],
])
const CANDIDATE_STRIDE = 42
const ALIGNED_PER_PROFILE = 24
const NEIGHBOR_COUNT = 10
const MIN_HISTORY_INDEX = 260
const ML_WEIGHTS = [0, 0.03, 0.06, 0.1] as const

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function futureReturn(prepared: MaSequencePrepared, index: number, horizon: number): number | null {
  const current = prepared.rows[index]?.close
  const future = prepared.rows[index + horizon]?.close
  if (!finite(current) || !finite(future) || current <= 0) return null
  return ((future / current) - 1) * 100
}

function candidateScore(
  row: Candidate,
  profile: MaSequenceScoringProfile,
  mlWeight = 0,
): number {
  const structural = rescoreMaSequenceComponents(row.components, profile).score
  return row.mlSimilarity == null
    ? structural
    : structural * (1 - mlWeight) + row.mlSimilarity * mlWeight
}

function weightedPrediction(
  rows: Candidate[],
  profile: MaSequenceScoringProfile,
  horizon: number,
  mlWeight = 0,
): number | null {
  let weighted = 0
  let totalWeight = 0
  for (const row of rows) {
    const outcome = row.outcomes.get(horizon)
    if (!finite(outcome)) continue
    const similarity = candidateScore(row, profile, mlWeight)
    const weight = Math.max(0.0001, similarity ** 4)
    weighted += outcome * weight
    totalWeight += weight
  }
  return totalWeight > 0 ? weighted / totalWeight : null
}

async function loadRows(market: Market, tickers: string[]): Promise<PriceRow[]> {
  const placeholders = tickers.map(() => '?').join(', ')
  const sql = `
    SELECT ticker, date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE ticker IN (${placeholders})
    ORDER BY ticker, date
  `
  return market === 'US'
    ? execUsAnalyticsAll<PriceRow>(sql, tickers)
    : execAll<PriceRow>(sql, tickers)
}

async function loadVectors(
  market: Market,
  tickers: string[],
): Promise<Array<{ ticker: string; date: string; vector_json: string }>> {
  const placeholders = tickers.map(() => '?').join(', ')
  const sql = `
    SELECT ticker, date, vector_json
    FROM ml_feature_vectors_v2
    WHERE feature_set = 'ma_physics_v4'
      AND ticker IN (${placeholders})
    ORDER BY ticker, date
  `
  return market === 'US'
    ? execUsAnalyticsAll(sql, tickers)
    : execAll(sql, tickers)
}

function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
  } catch {
    return []
  }
}

async function loadPanel(market: Market): Promise<PreparedTicker[]> {
  const [rows, vectorRows] = await Promise.all([
    loadRows(market, PANELS[market]),
    loadVectors(market, PANELS[market]),
  ])
  const grouped = new Map<string, PriceRow[]>()
  const vectors = new Map<string, Map<string, number[]>>()
  for (const row of rows) {
    const current = grouped.get(row.ticker) ?? []
    current.push(row)
    grouped.set(row.ticker, current)
  }
  for (const row of vectorRows) {
    const vector = parseVector(row.vector_json)
    if (vector.length === 0) continue
    const current = vectors.get(row.ticker) ?? new Map<string, number[]>()
    current.set(row.date, vector)
    vectors.set(row.ticker, current)
  }
  return PANELS[market]
    .map((ticker) => ({
      ticker,
      prepared: prepareMaSequence(grouped.get(ticker) ?? []),
      vectors: vectors.get(ticker) ?? new Map<string, number[]>(),
    }))
    .filter((row) => row.prepared.rows.length > MIN_HISTORY_INDEX + 200)
}

function buildBaseCases(market: Market, panel: PreparedTicker[]): BaseCase[] {
  const cases: BaseCase[] = []
  for (const row of panel) {
    for (const target of SPLIT_DATES) {
      const index = findMaSequenceIndex(row.prepared, target.date)
      if (
        index < MIN_HISTORY_INDEX
        || index + Math.max(...HORIZONS) >= row.prepared.rows.length
      ) continue
      cases.push({
        market,
        split: target.split,
        ticker: row.ticker,
        date: row.prepared.rows[index].date,
        index,
        prepared: row.prepared,
        vectors: row.vectors,
      })
    }
  }
  return cases
}

function candidateAnchors(base: BaseCase, panel: PreparedTicker[]): Array<{
  ticker: string
  index: number
  prepared: MaSequencePrepared
}> {
  const rows: Array<{ ticker: string; index: number; prepared: MaSequencePrepared }> = []
  const maxHorizon = Math.max(...HORIZONS)
  for (const candidate of panel) {
    for (
      let index = MIN_HISTORY_INDEX;
      index + maxHorizon < candidate.prepared.rows.length;
      index += CANDIDATE_STRIDE
    ) {
      const outcomeEndDate = candidate.prepared.rows[index + maxHorizon].date
      if (outcomeEndDate >= base.date) break
      rows.push({
        ticker: candidate.ticker,
        index,
        prepared: candidate.prepared,
      })
    }
  }
  return rows
}

function diversify(candidates: Candidate[], profile: MaSequenceScoringProfile): Candidate[] {
  return diversifyWithMl(candidates, profile, 0)
}

function diversifyWithMl(
  candidates: Candidate[],
  profile: MaSequenceScoringProfile,
  mlWeight: number,
): Candidate[] {
  const ranked = [...candidates].sort((a, b) =>
    candidateScore(b, profile, mlWeight) - candidateScore(a, profile, mlWeight),
  )
  const counts = new Map<string, number>()
  const selected: Candidate[] = []
  for (const row of ranked) {
    const count = counts.get(row.ticker) ?? 0
    if (count >= 2) continue
    selected.push(row)
    counts.set(row.ticker, count + 1)
    if (selected.length >= NEIGHBOR_COUNT) break
  }
  return selected
}

function profileTopKeys(
  rows: Array<{
    key: string
    components: MaSequenceScoreComponent[]
  }>,
): Set<string> {
  const selected = new Set<string>()
  for (const profile of MA_SEQUENCE_SCORING_PROFILES) {
    const ranked = [...rows].sort((a, b) =>
      rescoreMaSequenceComponents(b.components, profile).score
      - rescoreMaSequenceComponents(a.components, profile).score,
    )
    for (const row of ranked.slice(0, ALIGNED_PER_PROFILE)) selected.add(row.key)
  }
  return selected
}

function evaluateBase(base: BaseCase, panel: PreparedTicker[]): Prediction[] {
  const anchors = candidateAnchors(base, panel)
  const aligned = anchors.map((row) => {
    const score = scoreMaSequenceAligned(base.prepared, base.index, row.prepared, row.index)
    return {
      ...row,
      key: `${row.ticker}\u0000${row.prepared.rows[row.index].date}`,
      components: score.components,
    }
  })
  const shortlisted = profileTopKeys(aligned)
  const exact: Candidate[] = []
  const baseVector = base.vectors.get(base.date) ?? null
  for (const row of aligned) {
    if (!shortlisted.has(row.key)) continue
    const score = scoreMaSequence(base.prepared, base.index, row.prepared, row.index)
    exact.push({
      ticker: row.ticker,
      date: row.prepared.rows[row.index].date,
      index: row.index,
      prepared: row.prepared,
      components: score.components,
      mlSimilarity: baseVector == null
        ? null
        : (() => {
            const candidateVector = panel
              .find((item) => item.ticker === row.ticker)
              ?.vectors.get(row.prepared.rows[row.index].date)
            return candidateVector
              ? normalizedVectorSimilarity(baseVector, candidateVector)
              : null
          })(),
      outcomes: new Map(HORIZONS.flatMap((horizon) => {
        const outcome = futureReturn(row.prepared, row.index, horizon)
        return outcome == null ? [] : [[horizon, outcome]]
      })),
    })
  }

  const predictions: Prediction[] = []
  for (const profile of MA_SEQUENCE_SCORING_PROFILES) {
    const neighbors = diversify(exact, profile)
    for (const horizon of HORIZONS) {
      const actual = futureReturn(base.prepared, base.index, horizon)
      const predicted = weightedPrediction(neighbors, profile, horizon)
      if (actual == null || predicted == null) continue
      predictions.push({
        market: base.market,
        split: base.split,
        baseTicker: base.ticker,
        baseDate: base.date,
        profileKey: profile.key,
        horizon,
        actual,
        predicted,
        directionHit: Math.sign(actual) === Math.sign(predicted),
        absoluteError: Math.abs(actual - predicted),
      })
    }
  }
  const marketProfileKey = base.market === 'US' ? 'trajectory-heavy' : 'structural-context'
  const marketProfile = MA_SEQUENCE_SCORING_PROFILES.find((profile) => profile.key === marketProfileKey)
  if (marketProfile) {
    for (const mlWeight of ML_WEIGHTS) {
      const neighbors = diversifyWithMl(exact, marketProfile, mlWeight)
      const profileKey = `${marketProfile.key}+ml${Math.round(mlWeight * 100)}`
      for (const horizon of HORIZONS) {
        const actual = futureReturn(base.prepared, base.index, horizon)
        const predicted = weightedPrediction(neighbors, marketProfile, horizon, mlWeight)
        if (actual == null || predicted == null) continue
        predictions.push({
          market: base.market,
          split: base.split,
          baseTicker: base.ticker,
          baseDate: base.date,
          profileKey,
          horizon,
          actual,
          predicted,
          directionHit: Math.sign(actual) === Math.sign(predicted),
          absoluteError: Math.abs(actual - predicted),
        })
      }
    }
  }
  return predictions
}

function average(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function summarize(
  predictions: Prediction[],
  profileKey: string,
  split: Split,
  market?: Market,
  horizon?: number,
) {
  const rows = predictions.filter((row) =>
    row.profileKey === profileKey
    && row.split === split
    && (market == null || row.market === market)
    && (horizon == null || row.horizon === horizon),
  )
  const directionAccuracy = average(rows.map((row) => row.directionHit ? 1 : 0))
  const meanAbsoluteError = average(rows.map((row) => row.absoluteError))
  const utility = average(rows.map((row) => {
    const scale = ERROR_SCALES.get(row.horizon) ?? 20
    const errorScore = Math.exp(-row.absoluteError / scale)
    return (row.directionHit ? 0.6 : 0) + errorScore * 0.4
  }))
  return {
    count: rows.length,
    directionAccuracy,
    meanAbsoluteError,
    utility,
  }
}

function printSummary(predictions: Prediction[], split: Split) {
  console.log(`\n${split.toUpperCase()}`)
  console.log('profile                 n   direction      MAE  utility')
  for (const profile of MA_SEQUENCE_SCORING_PROFILES) {
    const summary = summarize(predictions, profile.key, split)
    console.log(
      `${profile.key.padEnd(22)}`
      + `${String(summary.count).padStart(3)}`
      + `${`${(summary.directionAccuracy * 100).toFixed(1)}%`.padStart(12)}`
      + `${summary.meanAbsoluteError.toFixed(2).padStart(9)}`
      + `${summary.utility.toFixed(4).padStart(9)}`,
    )
  }
  for (const market of ['JP', 'US'] as const) {
    console.log(`\n${market} ${split}`)
    for (const profile of MA_SEQUENCE_SCORING_PROFILES) {
      const summary = summarize(predictions, profile.key, split, market)
      console.log(
        `${profile.key.padEnd(22)} direction=${`${(summary.directionAccuracy * 100).toFixed(1)}%`.padStart(6)}`
        + ` mae=${summary.meanAbsoluteError.toFixed(2).padStart(6)}`
        + ` utility=${summary.utility.toFixed(4)}`,
      )
    }
  }
  for (const horizon of HORIZONS) {
    const baseline = summarize(predictions, 'balanced-v2', split, undefined, horizon)
    const trajectory = summarize(predictions, 'trajectory-heavy', split, undefined, horizon)
    console.log(
      `${horizon}d balanced direction=${(baseline.directionAccuracy * 100).toFixed(1)}%`
      + ` mae=${baseline.meanAbsoluteError.toFixed(2)}`
      + ` | trajectory direction=${(trajectory.directionAccuracy * 100).toFixed(1)}%`
      + ` mae=${trajectory.meanAbsoluteError.toFixed(2)}`,
    )
  }
  console.log('\nML RERANK')
  for (const market of ['JP', 'US'] as const) {
    const structuralKey = market === 'US' ? 'trajectory-heavy' : 'structural-context'
    for (const mlWeight of ML_WEIGHTS) {
      const profileKey = `${structuralKey}+ml${Math.round(mlWeight * 100)}`
      const summary = summarize(predictions, profileKey, split, market)
      console.log(
        `${market} ${profileKey.padEnd(28)} direction=${`${(summary.directionAccuracy * 100).toFixed(1)}%`.padStart(6)}`
        + ` mae=${summary.meanAbsoluteError.toFixed(2).padStart(6)}`
        + ` utility=${summary.utility.toFixed(4)}`,
      )
    }
  }
}

async function printKnownAnalog(panel: PreparedTicker[]) {
  const base = panel.find((row) => row.ticker === '7003')
  const candidate = panel.find((row) => row.ticker === '6496')
  if (!base || !candidate) return
  const baseIndex = base.prepared.rows.length - 1
  const candidateIndex = findMaSequenceIndex(candidate.prepared, '2026-07-03')
  if (candidateIndex < MIN_HISTORY_INDEX) return
  const exact = scoreMaSequence(base.prepared, baseIndex, candidate.prepared, candidateIndex)
  console.log('\nKNOWN ANALOG 7003 latest -> 6496@2026-07-03')
  for (const profile of MA_SEQUENCE_SCORING_PROFILES) {
    const score = rescoreMaSequenceComponents(exact.components, profile).score
    console.log(`${profile.key.padEnd(22)} ${(score * 100).toFixed(2)}%`)
  }
}

async function main() {
  const started = Date.now()
  const predictions: Prediction[] = []
  for (const market of ['JP', 'US'] as const) {
    const panel = await loadPanel(market)
    const cases = buildBaseCases(market, panel)
    console.log(`${market}: tickers=${panel.length} baseCases=${cases.length}`)
    let completed = 0
    for (const base of cases) {
      predictions.push(...evaluateBase(base, panel))
      completed += 1
      console.log(`${market}: ${completed}/${cases.length} ${base.split} ${base.ticker}@${base.date}`)
    }
    if (market === 'JP') await printKnownAnalog(panel)
  }

  printSummary(predictions, 'calibration')
  printSummary(predictions, 'holdout')
  const calibrationRank = MA_SEQUENCE_SCORING_PROFILES
    .map((profile) => ({
      profile,
      calibration: summarize(predictions, profile.key, 'calibration'),
      holdout: summarize(predictions, profile.key, 'holdout'),
    }))
    .sort((a, b) => b.calibration.utility - a.calibration.utility)
  const winner = calibrationRank[0]
  console.log(
    `\nCALIBRATION WINNER ${winner.profile.key}`
    + ` calibration=${winner.calibration.utility.toFixed(4)}`
    + ` holdout=${winner.holdout.utility.toFixed(4)}`,
  )
  console.log(`elapsed=${((Date.now() - started) / 1_000).toFixed(1)}s predictions=${predictions.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
