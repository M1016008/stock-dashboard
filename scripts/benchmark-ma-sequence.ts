import { execAll } from '@/lib/db/client'
import { stageNeighborCodes } from '@/lib/ml/historical-analogs'
import {
  buildMaSequenceEmbedding,
  maSequenceBandNeighbors,
  maSequenceEmbeddingSimilarityRanges,
  prepareMaSequence,
  scoreMaSequence,
} from '@/lib/ml/ma-sequence'

type PriceRow = {
  ticker: string
  date: string
  close: number
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type Point = {
  date: string
  values: number[]
  stages: number[]
}

const MA_PERIODS = [5, 10, 20, 40, 60, 90, 200] as const
const WINDOWS = [10, 20, 40] as const
const WINDOW_WEIGHTS = [0.2, 0.35, 0.45] as const
const FEATURE_WEIGHTS = [
  ...MA_PERIODS.map(() => 1.2),
  ...MA_PERIODS.slice(0, -1).map(() => 1.4),
  ...MA_PERIODS.map(() => 1.0),
  ...MA_PERIODS.slice(0, -1).map(() => 0.8),
] as const

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function pct(base: number | null | undefined, value: number | null | undefined): number {
  if (!finite(base) || !finite(value) || base === 0) return 0
  return ((value / base) - 1) * 100
}

function smaSeries(rows: PriceRow[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(rows.length).fill(null)
  let sum = 0
  for (let index = 0; index < rows.length; index += 1) {
    sum += rows[index].close
    if (index >= period) sum -= rows[index - period].close
    if (index >= period - 1) result[index] = sum / period
  }
  return result
}

function normalizeFeature(value: number, scale: number): number {
  return clamp(value / scale, -3, 3)
}

function buildPoints(rows: PriceRow[]): Point[] {
  const mas = MA_PERIODS.map((period) => smaSeries(rows, period))
  return rows.map((row, index) => {
    const currentMas = mas.map((series) => series[index])
    const pricePositions = currentMas.map((ma) => normalizeFeature(pct(ma, row.close), 12))
    const adjacentGaps = currentMas.slice(0, -1).map((ma, maIndex) =>
      normalizeFeature(pct(currentMas[maIndex + 1], ma), 10),
    )
    const velocities = currentMas.map((ma, maIndex) =>
      normalizeFeature(pct(mas[maIndex][index - 5], ma), 5),
    )
    const gapFlows = currentMas.slice(0, -1).map((ma, maIndex) => {
      const previousShort = mas[maIndex][index - 5]
      const previousLong = mas[maIndex + 1][index - 5]
      const currentGap = pct(currentMas[maIndex + 1], ma)
      const previousGap = pct(previousLong, previousShort)
      return normalizeFeature(currentGap - previousGap, 4)
    })
    return {
      date: row.date,
      values: [...pricePositions, ...adjacentGaps, ...velocities, ...gapFlows],
      stages: [
        row.daily_a_stage,
        row.daily_b_stage,
        row.weekly_a_stage,
        row.weekly_b_stage,
        row.monthly_a_stage,
        row.monthly_b_stage,
      ].map((value) => finite(value) ? value : 0),
    }
  })
}

function pointDistance(a: Point, b: Point): number {
  let weighted = 0
  let weight = 0
  const length = Math.min(a.values.length, b.values.length, FEATURE_WEIGHTS.length)
  for (let index = 0; index < length; index += 1) {
    const delta = a.values[index] - b.values[index]
    const featureWeight = FEATURE_WEIGHTS[index]
    weighted += delta * delta * featureWeight
    weight += featureWeight
  }
  let stageMismatch = 0
  let stageCount = 0
  for (let index = 0; index < Math.min(a.stages.length, b.stages.length); index += 1) {
    if (a.stages[index] === 0 || b.stages[index] === 0) continue
    stageMismatch += a.stages[index] === b.stages[index] ? 0 : 1
    stageCount += 1
  }
  const featureDistance = weight > 0 ? Math.sqrt(weighted / weight) : 3
  const stageDistance = stageCount > 0 ? stageMismatch / stageCount : 0.5
  return featureDistance * 0.82 + stageDistance * 0.18
}

function alignedDistance(a: Point[], b: Point[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return Infinity
  let total = 0
  let weight = 0
  for (let index = 0; index < length; index += 1) {
    const recencyWeight = 0.45 + 0.55 * ((index + 1) / length)
    total += pointDistance(a[a.length - length + index], b[b.length - length + index]) * recencyWeight
    weight += recencyWeight
  }
  return total / weight
}

function dtwDistance(a: Point[], b: Point[], bandRatio = 0.2): number {
  if (a.length === 0 || b.length === 0) return Infinity
  const width = Math.max(Math.abs(a.length - b.length), Math.ceil(Math.max(a.length, b.length) * bandRatio))
  let previous = new Float64Array(b.length + 1)
  let current = new Float64Array(b.length + 1)
  previous.fill(Infinity)
  previous[0] = 0
  for (let rowIndex = 1; rowIndex <= a.length; rowIndex += 1) {
    current.fill(Infinity)
    const from = Math.max(1, rowIndex - width)
    const to = Math.min(b.length, rowIndex + width)
    for (let columnIndex = from; columnIndex <= to; columnIndex += 1) {
      const cost = pointDistance(a[rowIndex - 1], b[columnIndex - 1])
      current[columnIndex] = cost + Math.min(
        previous[columnIndex],
        current[columnIndex - 1],
        previous[columnIndex - 1],
      )
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] / Math.max(a.length, b.length)
}

function multiscaleDistance(
  base: Point[],
  candidate: Point[],
  metric: 'aligned' | 'dtw',
): number {
  let total = 0
  let weight = 0
  for (let index = 0; index < WINDOWS.length; index += 1) {
    const window = WINDOWS[index]
    const baseWindow = base.slice(-window)
    const candidateWindow = candidate.slice(-window)
    if (baseWindow.length < window || candidateWindow.length < window) continue
    const distance = metric === 'dtw'
      ? dtwDistance(baseWindow, candidateWindow)
      : alignedDistance(baseWindow, candidateWindow)
    total += distance * WINDOW_WEIGHTS[index]
    weight += WINDOW_WEIGHTS[index]
  }
  return weight > 0 ? total / weight : Infinity
}

function distanceBreakdown(base: Point[], candidate: Point[], metric: 'aligned' | 'dtw') {
  return WINDOWS.map((window) => {
    const baseWindow = base.slice(-window)
    const candidateWindow = candidate.slice(-window)
    const distance = metric === 'dtw'
      ? dtwDistance(baseWindow, candidateWindow)
      : alignedDistance(baseWindow, candidateWindow)
    return { window, similarity: similarity(distance) }
  })
}

function similarity(distance: number): number {
  return Math.exp(-1.35 * distance)
}

async function loadRows(tickers: string[]): Promise<PriceRow[]> {
  const placeholders = tickers.map(() => '?').join(', ')
  return execAll<PriceRow>(
    `
    SELECT
      o.ticker,
      o.date,
      o.close,
      d.daily_a_stage,
      d.daily_b_stage,
      d.weekly_a_stage,
      d.weekly_b_stage,
      d.monthly_a_stage,
      d.monthly_b_stage
    FROM ohlcv_daily o
    LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
    WHERE o.ticker IN (${placeholders})
    ORDER BY o.ticker, o.date
    `,
    tickers,
  )
}

async function benchmarkCandidateRecall(ticker: string, date: string) {
  const [base] = await execAll<{ stage_code: string; vector_json: string }>(
    `
    SELECT stage_code, vector_json
    FROM ml_feature_vectors_v2
    WHERE feature_set='ma_physics_v4' AND ticker=? AND date=?
    LIMIT 1
    `,
    [ticker, date],
  )
  if (!base) return
  const vector = JSON.parse(base.vector_json) as number[]
  for (const stageDistance of [1, 2]) {
    const stages = stageNeighborCodes(base.stage_code, stageDistance)
    const stagePlaceholders = stages.map(() => '?').join(', ')
    for (const bucketRadius of [1, 2, 3]) {
      const centers = [11, 15, 25, 26].map((index) => Math.round(vector[index] * 5))
      const started = Date.now()
      const [row] = await execAll<{ count: number; target_count: number }>(
        `
        SELECT
          COUNT(*) AS count,
          SUM(CASE WHEN ticker='6496' AND date IN ('2026-07-03','2026-07-06') THEN 1 ELSE 0 END) AS target_count
        FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_analog_bucket_idx
        WHERE feature_set='ma_physics_v4'
          AND stage_code IN (${stagePlaceholders})
          AND CAST(ROUND(json_extract(vector_json, '$[11]') * 5) AS INTEGER) BETWEEN ? AND ?
          AND CAST(ROUND(json_extract(vector_json, '$[15]') * 5) AS INTEGER) BETWEEN ? AND ?
          AND CAST(ROUND(json_extract(vector_json, '$[25]') * 5) AS INTEGER) BETWEEN ? AND ?
          AND CAST(ROUND(json_extract(vector_json, '$[26]') * 5) AS INTEGER) BETWEEN ? AND ?
          AND date < ?
        `,
        [
          ...stages,
          ...centers.flatMap((center) => [center - bucketRadius, center + bucketRadius]),
          date,
        ],
      )
      console.log(
        `candidate recall stageDistance=${stageDistance} bucketRadius=${bucketRadius}`
        + ` rows=${Number(row?.count ?? 0).toLocaleString()} target=${row?.target_count ?? 0}`
        + ` elapsed=${Date.now() - started}ms`,
      )
    }
  }
}

async function main() {
  const baseTicker = process.env.BASE_TICKER?.trim() || '7003'
  const candidateTicker = process.env.CANDIDATE_TICKER?.trim() || '6496'
  const requestedDate = process.env.BASE_DATE?.trim() || null
  const rows = await loadRows([baseTicker, candidateTicker])
  const grouped = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const current = grouped.get(row.ticker) ?? []
    current.push(row)
    grouped.set(row.ticker, current)
  }
  const baseRows = grouped.get(baseTicker) ?? []
  const candidateRows = grouped.get(candidateTicker) ?? []
  const baseEndIndex = requestedDate
    ? baseRows.findIndex((row) => row.date === requestedDate)
    : baseRows.length - 1
  if (baseEndIndex < 239) throw new Error(`${baseTicker} の基準日履歴が不足しています。`)
  const basePoints = buildPoints(baseRows.slice(0, baseEndIndex + 1))
  const candidatePoints = buildPoints(candidateRows)
  const cutoffDate = baseRows[baseEndIndex].date
  await benchmarkCandidateRecall(baseTicker, cutoffDate)
  const preparedBase = prepareMaSequence(baseRows)
  const preparedCandidate = prepareMaSequence(candidateRows)
  const baseEmbedding = buildMaSequenceEmbedding(preparedBase, baseEndIndex)
  if (!baseEmbedding) throw new Error(`${baseTicker} の索引用埋め込みを生成できません。`)
  console.log('\nMULTISCALE SCORE BREAKDOWN')
  for (const inspectDate of ['2024-10-10', '2026-07-03', '2026-07-06', '2026-07-23']) {
    const index = candidateRows.findIndex((row) => row.date === inspectDate)
    if (index < 0) continue
    const score = scoreMaSequence(preparedBase, baseEndIndex, preparedCandidate, index)
    console.log(
      `${inspectDate} total=${(score.score * 100).toFixed(2)}% `
      + score.components.map((component) =>
        `${component.key}=${component.available ? `${(component.score * 100).toFixed(2)}%` : 'n/a'}`,
      ).join(' '),
    )
  }
  const approximate: Array<{
    date: string
    similarity: number
    bandMatches: number
    exact: number
  }> = []
  for (let endIndex = 240; endIndex < candidateRows.length; endIndex += 1) {
    if (candidateRows[endIndex].date >= cutoffDate) break
    const embedding = buildMaSequenceEmbedding(preparedCandidate, endIndex)
    if (!embedding) continue
    const bandMatches = embedding.bands.filter((band, index) => {
      const neighbors = new Set(maSequenceBandNeighbors(baseEmbedding.bands[index], 1))
      return neighbors.has(band)
    }).length
    approximate.push({
      date: candidateRows[endIndex].date,
      similarity: maSequenceEmbeddingSimilarityRanges(
        baseEmbedding.quantized,
        embedding.quantized,
        [[0, 68]],
      ),
      bandMatches,
      exact: scoreMaSequence(preparedBase, baseEndIndex, preparedCandidate, endIndex).score,
    })
  }
  console.log('\nCOMPACT EMBEDDING TOP 20')
  for (const [index, row] of [...approximate].sort((a, b) => b.similarity - a.similarity).slice(0, 20).entries()) {
    console.log(
      `${String(index + 1).padStart(2)} ${row.date}`
      + ` approximate=${(row.similarity * 100).toFixed(2)}%`
      + ` exact=${(row.exact * 100).toFixed(2)}% bands=${row.bandMatches}`,
    )
  }
  console.log('\nKNOWN ANALOG INDEX RECALL')
  for (const inspectDate of ['2024-10-10', '2026-07-03', '2026-07-06', '2026-07-23']) {
    const row = approximate.find((item) => item.date === inspectDate)
    if (!row) continue
    const rank = [...approximate].sort((a, b) => b.similarity - a.similarity)
      .findIndex((item) => item.date === inspectDate) + 1
    console.log(
      `${row.date} approximate=${(row.similarity * 100).toFixed(2)}%`
      + ` exact=${(row.exact * 100).toFixed(2)}% bands=${row.bandMatches} rank=${rank}`,
    )
  }
  const results: Array<{ date: string; aligned: number; dtw: number }> = []
  for (let endIndex = 239; endIndex < candidateRows.length; endIndex += 1) {
    if (candidateRows[endIndex].date >= cutoffDate) break
    const candidateWindow = candidatePoints.slice(0, endIndex + 1)
    const aligned = multiscaleDistance(basePoints, candidateWindow, 'aligned')
    const dtw = multiscaleDistance(basePoints, candidateWindow, 'dtw')
    results.push({
      date: candidateRows[endIndex].date,
      aligned: similarity(aligned),
      dtw: similarity(dtw),
    })
  }
  const printTop = (key: 'aligned' | 'dtw') => {
    console.log(`\n${key.toUpperCase()} TOP 20`)
    for (const [index, row] of [...results].sort((a, b) => b[key] - a[key]).slice(0, 20).entries()) {
      console.log(`${String(index + 1).padStart(2)} ${row.date} ${(row[key] * 100).toFixed(2)}%`)
    }
  }
  console.log(`base=${baseTicker}@${cutoffDate} candidate=${candidateTicker} rows=${results.length}`)
  printTop('aligned')
  printTop('dtw')
  for (const inspectDate of ['2024-10-10', '2026-07-03', '2026-07-06', '2026-07-23']) {
    const index = candidateRows.findIndex((row) => row.date === inspectDate)
    if (index < 0) continue
    const candidateWindow = candidatePoints.slice(0, index + 1)
    console.log(`\nBREAKDOWN ${inspectDate}`)
    console.log('aligned', distanceBreakdown(basePoints, candidateWindow, 'aligned').map((item) => `${item.window}d=${(item.similarity * 100).toFixed(2)}%`).join(' '))
    console.log('dtw    ', distanceBreakdown(basePoints, candidateWindow, 'dtw').map((item) => `${item.window}d=${(item.similarity * 100).toFixed(2)}%`).join(' '))
  }
  console.log('\nRECENT 2026 CANDIDATES')
  for (const row of results.filter((item) => item.date >= '2026-05-01').slice(-80)) {
    console.log(`${row.date} aligned=${(row.aligned * 100).toFixed(2)}% dtw=${(row.dtw * 100).toFixed(2)}%`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
