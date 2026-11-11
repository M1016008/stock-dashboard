export interface TransitionComparisonRecord {
  cohort: 'H001' | 'C2'
  ticker: string
  signalDate: string
  netReturn: number
}

// signalMonth (YYYY-MM of signalDate) is the time cluster fixed by PREREG_TRANSITIONS_20261111.
export type ClusterAxis = 'ticker' | 'signalDate' | 'signalMonth'

function clusterKey(row: Pick<TransitionComparisonRecord, 'ticker' | 'signalDate'>, axis: ClusterAxis): string {
  return axis === 'signalMonth' ? row.signalDate.slice(0, 7) : row[axis]
}

export interface ClusterBootstrapResult {
  axis: ClusterAxis
  iterationsRequested: number
  iterationsCompleted: number
  lower95: number
  upper95: number
}

export interface TransitionComparison {
  samples: { h001: number; c2: number }
  clusters: {
    tickers: number
    signalDates: number
  }
  h001Median: number
  c2Median: number
  medianDifference: number
  tickerClusterBootstrap: ClusterBootstrapResult
  signalDateClusterBootstrap: ClusterBootstrapResult
  conservative95: { lower: number; upper: number }
  matchedSignalDate: {
    datesWithBothCohorts: number
    h001Samples: number
    c2Samples: number
    medianDailyDifference: number
    positiveDateRate: number
    bootstrap95: { lower: number; upper: number; iterations: number }
  }
  interpretation: 'POSITIVE_INTERVAL' | 'NEGATIVE_INTERVAL' | 'INCLUDES_ZERO'
  method: string
}

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error('quantile requires at least one value')
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5)
}

function matchedSignalDateComparison(
  records: readonly TransitionComparisonRecord[],
  iterations: number,
  seed: number,
): TransitionComparison['matchedSignalDate'] {
  const byDate = new Map<string, { h001: number[]; c2: number[] }>()
  for (const row of records) {
    const bucket = byDate.get(row.signalDate) ?? { h001: [], c2: [] }
    bucket[row.cohort === 'H001' ? 'h001' : 'c2'].push(row.netReturn)
    byDate.set(row.signalDate, bucket)
  }
  const matched = [...byDate.entries()]
    .filter(([, bucket]) => bucket.h001.length > 0 && bucket.c2.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bucket]) => ({
      h001Samples: bucket.h001.length,
      c2Samples: bucket.c2.length,
      difference: median(bucket.h001) - median(bucket.c2),
    }))
  if (matched.length === 0) throw new Error('at least one signal date with both H001 and C2 is required')

  const random = mulberry32(seed)
  const bootstrap: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled: number[] = []
    for (let draw = 0; draw < matched.length; draw += 1) {
      sampled.push(matched[Math.floor(random() * matched.length)].difference)
    }
    bootstrap.push(median(sampled))
  }
  return {
    datesWithBothCohorts: matched.length,
    h001Samples: matched.reduce((sum, row) => sum + row.h001Samples, 0),
    c2Samples: matched.reduce((sum, row) => sum + row.c2Samples, 0),
    medianDailyDifference: median(matched.map((row) => row.difference)),
    positiveDateRate: matched.filter((row) => row.difference > 0).length / matched.length,
    bootstrap95: {
      lower: quantile(bootstrap, 0.025),
      upper: quantile(bootstrap, 0.975),
      iterations,
    },
  }
}

export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = state + 0x6D2B79F5 | 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function weightedMedian(rows: readonly { value: number; cluster: number }[], weights: Int32Array): number | null {
  let total = 0
  for (const row of rows) total += weights[row.cluster]
  if (total === 0) return null
  const midpoint = total / 2
  let cumulative = 0
  for (const row of rows) {
    cumulative += weights[row.cluster]
    if (cumulative >= midpoint) return row.value
  }
  return rows.at(-1)?.value ?? null
}

export function bootstrapMedianDistribution(args: {
  records: readonly Pick<TransitionComparisonRecord, 'ticker' | 'signalDate' | 'netReturn'>[]
  axis: ClusterAxis
  iterations?: number
  seed?: number
}): number[] {
  const iterations = args.iterations ?? 2_000
  const seed = args.seed ?? 20261015
  if (!Number.isInteger(iterations) || iterations < 100) throw new Error('iterations must be an integer of at least 100')
  const records = args.records.filter((row) => Number.isFinite(row.netReturn))
  if (records.length === 0) throw new Error('bootstrap records are required')
  const clusterNames = [...new Set(records.map((row) => clusterKey(row, args.axis)))].sort()
  const clusterIds = new Map(clusterNames.map((name, index) => [name, index]))
  const prepared = records.map((row) => ({ value: row.netReturn, cluster: clusterIds.get(clusterKey(row, args.axis))! }))
    .sort((a, b) => a.value - b.value)
  const random = mulberry32(seed)
  const weights = new Int32Array(clusterNames.length)
  const medians: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    weights.fill(0)
    for (let draw = 0; draw < clusterNames.length; draw += 1) {
      weights[Math.floor(random() * clusterNames.length)] += 1
    }
    const value = weightedMedian(prepared, weights)
    if (value != null) medians.push(value)
  }
  if (medians.length !== iterations) throw new Error(`bootstrap produced ${medians.length}/${iterations} medians`)
  return medians
}

function bootstrapByAxis(
  records: readonly TransitionComparisonRecord[],
  axis: ClusterAxis,
  iterations: number,
  seed: number,
): ClusterBootstrapResult {
  const clusterNames = [...new Set(records.map((row) => clusterKey(row, axis)))].sort()
  const clusterIds = new Map(clusterNames.map((name, index) => [name, index]))
  const prepared = (cohort: TransitionComparisonRecord['cohort']) => records
    .filter((row) => row.cohort === cohort)
    .map((row) => ({ value: row.netReturn, cluster: clusterIds.get(clusterKey(row, axis))! }))
    .sort((a, b) => a.value - b.value)
  const h001 = prepared('H001')
  const c2 = prepared('C2')
  const random = mulberry32(seed)
  const weights = new Int32Array(clusterNames.length)
  const differences: number[] = []
  const maximumAttempts = iterations * 5
  for (let attempt = 0; attempt < maximumAttempts && differences.length < iterations; attempt += 1) {
    weights.fill(0)
    for (let draw = 0; draw < clusterNames.length; draw += 1) {
      weights[Math.floor(random() * clusterNames.length)] += 1
    }
    const h001Median = weightedMedian(h001, weights)
    const c2Median = weightedMedian(c2, weights)
    if (h001Median != null && c2Median != null) differences.push(h001Median - c2Median)
  }
  if (differences.length < Math.max(100, Math.floor(iterations * 0.9))) {
    throw new Error(`insufficient ${axis} bootstrap replicates: ${differences.length}/${iterations}`)
  }
  return {
    axis,
    iterationsRequested: iterations,
    iterationsCompleted: differences.length,
    lower95: quantile(differences, 0.025),
    upper95: quantile(differences, 0.975),
  }
}

export function compareTransitionCohorts(args: {
  records: readonly TransitionComparisonRecord[]
  iterations?: number
  seed?: number
  timeAxis?: 'signalDate' | 'signalMonth'
}): TransitionComparison {
  const iterations = args.iterations ?? 1_000
  const seed = args.seed ?? 20261015
  if (!Number.isInteger(iterations) || iterations < 100) throw new Error('iterations must be an integer of at least 100')
  const records = args.records.filter((row) => Number.isFinite(row.netReturn))
  const h001Values = records.filter((row) => row.cohort === 'H001').map((row) => row.netReturn)
  const c2Values = records.filter((row) => row.cohort === 'C2').map((row) => row.netReturn)
  if (h001Values.length === 0 || c2Values.length === 0) throw new Error('both H001 and C2 records are required')
  const h001Median = median(h001Values)
  const c2Median = median(c2Values)
  const tickerClusterBootstrap = bootstrapByAxis(records, 'ticker', iterations, seed ^ 0x5449434b)
  const signalDateClusterBootstrap = bootstrapByAxis(records, args.timeAxis ?? 'signalDate', iterations, seed ^ 0x44415445)
  const matchedSignalDate = matchedSignalDateComparison(records, iterations, seed ^ 0x50414952)
  const conservative95 = {
    lower: Math.min(tickerClusterBootstrap.lower95, signalDateClusterBootstrap.lower95),
    upper: Math.max(tickerClusterBootstrap.upper95, signalDateClusterBootstrap.upper95),
  }
  return {
    samples: { h001: h001Values.length, c2: c2Values.length },
    clusters: {
      tickers: new Set(records.map((row) => row.ticker)).size,
      signalDates: new Set(records.map((row) => row.signalDate)).size,
    },
    h001Median,
    c2Median,
    medianDifference: h001Median - c2Median,
    tickerClusterBootstrap,
    signalDateClusterBootstrap,
    conservative95,
    matchedSignalDate,
    interpretation: conservative95.lower > 0
      ? 'POSITIVE_INTERVAL'
      : conservative95.upper < 0
        ? 'NEGATIVE_INTERVAL'
        : 'INCLUDES_ZERO',
    method: 'Separate one-way nonparametric cluster bootstraps over ticker and signal date; conservative interval is the envelope of both 95% intervals. Same-date sensitivity pairs daily cohort medians only on dates containing both cohorts and bootstraps those date-level differences.',
  }
}
