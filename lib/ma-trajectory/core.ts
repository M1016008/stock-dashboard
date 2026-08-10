export const MA_TRAJECTORY_PERIODS = [3, 5, 10, 25, 75, 100, 200] as const
export const MA_TRAJECTORY_DEFAULT_PERIODS = [25, 75, 100, 200] as const
export const MA_TRAJECTORY_HORIZONS = [20, 60, 90, 200] as const
export const MA_TRAJECTORY_DEFAULT_HORIZON = 60
export const MA_TRAJECTORY_FEATURE_VERSION = 'ma_space_v2_relational_25_75_100'
export const MA_TRAJECTORY_MODEL_VERSION = 'ma_trajectory_shadow_v6_relational_25_75_100_leakage_audited'

export type MaTrajectoryPeriod = typeof MA_TRAJECTORY_PERIODS[number]
export type MaTrajectoryHorizon = typeof MA_TRAJECTORY_HORIZONS[number]
export type MaTrajectoryMarket = 'JP' | 'US'
export type MaTrajectoryMethod = 'weighted_distance' | 'lightgbm_lambdarank' | 'deep_state_encoder'
export type MaTrajectoryEventType = 'approach' | 'touch' | 'cross' | 'bounce' | 'follow' | 'closest'
export type MaEscapeState =
  | 'open_path'
  | 'collision'
  | 'rebound'
  | 'following'
  | 'constrained'
  | 'convergence_break'

export type MaTrajectoryOhlcvRow = {
  date: string
  close: number
  high?: number | null
  low?: number | null
  volume?: number | null
  pms?: number | null
  pfs?: number | null
  pes?: number | null
}

export type MaTrajectoryChartPoint = {
  date: string
  value: number
}

export type MaTrajectoryForecastPoint = {
  date: string
  median: number
  p10: number
  p90: number
}

export type MaTrajectoryEvent = {
  type: MaTrajectoryEventType
  date: string
  shortPeriod: MaTrajectoryPeriod
  longPeriod: MaTrajectoryPeriod
  probabilityPct: number
  gapPct: number
  label: string
}

export type MaTrajectoryDriver = {
  key: string
  label: string
  contribution: number
  direction: 'supports' | 'opposes' | 'neutral'
}

export type MaEscapeStateProbability = {
  state: MaEscapeState
  label: string
  probabilityPct: number
}

export type MaTrajectoryScenario = {
  id: string
  rank: number
  label: string
  probabilityPct: number
  analogCount: number
  averageSimilarity: number
  lines: Record<string, MaTrajectoryForecastPoint[]>
  priceAuxiliary: MaTrajectoryForecastPoint[]
  events: MaTrajectoryEvent[]
  escapeStates: MaEscapeStateProbability[]
  drivers: MaTrajectoryDriver[]
}

export type MaTrajectoryProjectionAvailable = {
  ok: true
  available: true
  market: MaTrajectoryMarket
  ticker: string
  asOfDate: string
  sourceDate: string
  horizonSessions: MaTrajectoryHorizon
  modelVersion: string
  featureVersion: string
  selectedMethod: MaTrajectoryMethod
  generatedAt: string
  periods: readonly MaTrajectoryPeriod[]
  history: Record<string, MaTrajectoryChartPoint[]>
  scenarios: MaTrajectoryScenario[]
  calibration: {
    ece: number | null
    intervalCoverage80: number | null
    queryCount: number
  }
}

export type MaTrajectoryProjectionUnavailable = {
  ok: true
  available: false
  market: MaTrajectoryMarket
  ticker: string
  horizonSessions: MaTrajectoryHorizon
  reason: 'shadow_not_found' | 'shadow_not_promoted' | 'prediction_not_found' | 'unsupported_market'
}

export type MaTrajectoryProjectionResponse =
  | MaTrajectoryProjectionAvailable
  | MaTrajectoryProjectionUnavailable

export type MaSpaceFeatureVector = {
  names: string[]
  values: number[]
  groups: Record<string, number[]>
  asOfDate: string
  atr: number
  mas: Record<string, number>
}

const FEATURE_PAIRS: ReadonlyArray<readonly [MaTrajectoryPeriod, MaTrajectoryPeriod]> = [
  [3, 5],
  [3, 10],
  [3, 25],
  [3, 75],
  [3, 100],
  [3, 200],
  [5, 10],
  [5, 25],
  [5, 75],
  [5, 100],
  [5, 200],
  [10, 25],
  [10, 75],
  [10, 100],
  [10, 200],
  [25, 75],
  [25, 100],
  [25, 200],
  [75, 100],
  [75, 200],
  [100, 200],
]

const FOCUSED_EVENT_PAIRS: ReadonlyArray<readonly [MaTrajectoryPeriod, MaTrajectoryPeriod]> = [
  [3, 5],
  [3, 25],
  [5, 10],
  [5, 25],
  [5, 75],
  [10, 25],
  [10, 75],
  [25, 75],
  [25, 100],
  [25, 200],
  [75, 100],
  [75, 200],
  [100, 200],
]

const RELATIONSHIP_EVENT_PAIRS: ReadonlyArray<readonly [MaTrajectoryPeriod, MaTrajectoryPeriod]> = [
  [25, 75],
  [25, 100],
  [75, 100],
]

function isRelationshipEventPair(shortPeriod: MaTrajectoryPeriod, longPeriod: MaTrajectoryPeriod): boolean {
  return RELATIONSHIP_EVENT_PAIRS.some(([short, long]) => short === shortPeriod && long === longPeriod)
}

const ESCAPE_LABELS: Record<MaEscapeState, string> = {
  open_path: '進路が開いている',
  collision: '長期線へ衝突',
  rebound: '衝突後に反発',
  following: '長期線に沿う',
  constrained: '逃げ道が限定',
  convergence_break: '収束後に方向決定',
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const ordered = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

export function normalizeMaTrajectoryHorizon(value: unknown): MaTrajectoryHorizon {
  const parsed = Number(value)
  return MA_TRAJECTORY_HORIZONS.includes(parsed as MaTrajectoryHorizon)
    ? parsed as MaTrajectoryHorizon
    : MA_TRAJECTORY_DEFAULT_HORIZON
}

export function simpleMovingAverageSeries(
  rows: MaTrajectoryOhlcvRow[],
  period: number,
): Array<number | null> {
  const output: Array<number | null> = Array(rows.length).fill(null)
  let sum = 0
  for (let index = 0; index < rows.length; index += 1) {
    const close = rows[index]?.close
    if (!finite(close)) continue
    sum += close
    if (index >= period) sum -= rows[index - period].close
    if (index >= period - 1) output[index] = sum / period
  }
  return output
}

export function averageTrueRange(rows: MaTrajectoryOhlcvRow[], endIndex: number, period = 20): number {
  const start = Math.max(1, endIndex - period + 1)
  const values: number[] = []
  for (let index = start; index <= endIndex; index += 1) {
    const row = rows[index]
    const previous = rows[index - 1]
    if (!row || !previous) continue
    const high = finite(row.high) ? row.high : row.close
    const low = finite(row.low) ? row.low : row.close
    values.push(Math.max(high - low, Math.abs(high - previous.close), Math.abs(low - previous.close)))
  }
  const fallback = rows[endIndex]?.close ? rows[endIndex].close * 0.02 : 1
  return Math.max(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback, 1e-8)
}

function seriesValue(series: Array<number | null>, index: number): number | null {
  const value = series[index]
  return finite(value) ? value : null
}

function normalizedDelta(
  series: Array<number | null>,
  currentIndex: number,
  lag: number,
  scale: number,
): number {
  const current = seriesValue(series, currentIndex)
  const previous = seriesValue(series, currentIndex - lag)
  if (!finite(current) || !finite(previous)) return 0
  return clamp((current - previous) / scale, -8, 8)
}

function addFeature(
  names: string[],
  values: number[],
  groups: Record<string, number[]>,
  group: string,
  name: string,
  value: number,
): void {
  const index = values.length
  names.push(name)
  values.push(round(clamp(value, -12, 12)))
  ;(groups[group] ??= []).push(index)
}

export function buildMaSpaceFeatureVector(
  inputRows: MaTrajectoryOhlcvRow[],
  requestedIndex = inputRows.length - 1,
): MaSpaceFeatureVector | null {
  const rows = inputRows
    .filter((row) => row.date && finite(row.close) && row.close > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  const index = Math.min(requestedIndex, rows.length - 1)
  if (index < 239) return null

  const series = Object.fromEntries(
    MA_TRAJECTORY_PERIODS.map((period) => [String(period), simpleMovingAverageSeries(rows, period)]),
  ) as Record<string, Array<number | null>>
  const atr = averageTrueRange(rows, index)
  const close = rows[index].close
  const names: string[] = []
  const values: number[] = []
  const groups: Record<string, number[]> = {}
  const mas: Record<string, number> = {}

  for (const period of MA_TRAJECTORY_PERIODS) {
    const maSeries = series[String(period)]
    const current = seriesValue(maSeries, index)
    if (!finite(current)) return null
    mas[String(period)] = current
    addFeature(names, values, groups, 'ma_structure', `ma${period}_level_atr`, (current - close) / atr)
    for (const lag of [1, 3, 5, 10]) {
      addFeature(
        names,
        values,
        groups,
        'ma_motion',
        `ma${period}_slope_${lag}`,
        normalizedDelta(maSeries, index, lag, atr),
      )
    }
    const currentSlope = normalizedDelta(maSeries, index, 3, atr)
    const priorSlope = normalizedDelta(maSeries, index - 3, 3, atr)
    const priorPriorSlope = normalizedDelta(maSeries, index - 6, 3, atr)
    addFeature(names, values, groups, 'ma_curvature', `ma${period}_acceleration`, currentSlope - priorSlope)
    addFeature(
      names,
      values,
      groups,
      'ma_curvature',
      `ma${period}_curvature_change`,
      (currentSlope - priorSlope) - (priorSlope - priorPriorSlope),
    )
  }

  for (const period of MA_TRAJECTORY_PERIODS) {
    const maSeries = series[String(period)]
    for (let lag = 0; lag < 40; lag += 1) {
      const value = seriesValue(maSeries, index - lag)
      if (!finite(value)) return null
      addFeature(
        names,
        values,
        groups,
        'ma_history',
        `ma${period}_history_${lag}`,
        (value - close) / atr,
      )
    }
  }

  for (const [shortPeriod, longPeriod] of FEATURE_PAIRS) {
    const shortSeries = series[String(shortPeriod)]
    const longSeries = series[String(longPeriod)]
    const short = seriesValue(shortSeries, index) ?? 0
    const long = seriesValue(longSeries, index) ?? 0
    const gap = (short - long) / atr
    const priorGap = ((seriesValue(shortSeries, index - 5) ?? short) - (seriesValue(longSeries, index - 5) ?? long)) / atr
    const shortSlope = normalizedDelta(shortSeries, index, 3, atr)
    const longSlope = normalizedDelta(longSeries, index, 3, atr)
    const relativeSlope = shortSlope - longSlope
    const timeToContact = Math.abs(relativeSlope) > 1e-6 && gap * relativeSlope < 0
      ? clamp(Math.abs(gap / relativeSlope) * 3, 0, 200)
      : 200
    addFeature(names, values, groups, 'ma_gaps', `gap_${shortPeriod}_${longPeriod}`, gap)
    addFeature(names, values, groups, 'ma_gaps', `gap_velocity_${shortPeriod}_${longPeriod}`, gap - priorGap)
    addFeature(names, values, groups, 'ma_angles', `relative_angle_${shortPeriod}_${longPeriod}`, relativeSlope)
    addFeature(names, values, groups, 'ma_angles', `parallel_${shortPeriod}_${longPeriod}`, 1 / (1 + Math.abs(relativeSlope)))
    addFeature(names, values, groups, 'ma_corridor', `contact_time_${shortPeriod}_${longPeriod}`, timeToContact / 20)
  }

  const maValues = Object.values(mas)
  const bundleWidth = (Math.max(...maValues) - Math.min(...maValues)) / atr
  const longPeriods: MaTrajectoryPeriod[] = [25, 75, 100, 200]
  const aboveShort = longPeriods.filter((period) => mas[String(period)] > mas['5']).length
  const belowShort = longPeriods.filter((period) => mas[String(period)] < mas['5']).length
  addFeature(names, values, groups, 'ma_corridor', 'bundle_width_atr', bundleWidth)
  addFeature(names, values, groups, 'ma_corridor', 'long_lines_above_ma5', aboveShort / longPeriods.length)
  addFeature(names, values, groups, 'ma_corridor', 'long_lines_below_ma5', belowShort / longPeriods.length)
  addFeature(names, values, groups, 'ma_structure', 'ma_order_entropy', orderEntropy(maValues))

  const return5 = rows[index - 5]?.close ? (close / rows[index - 5].close) - 1 : 0
  const return20 = rows[index - 20]?.close ? (close / rows[index - 20].close) - 1 : 0
  const recentReturns: number[] = []
  for (let cursor = index - 20; cursor < index; cursor += 1) {
    if (rows[cursor]?.close && rows[cursor + 1]?.close) {
      recentReturns.push(Math.log(rows[cursor + 1].close / rows[cursor].close))
    }
  }
  const returnMean = recentReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, recentReturns.length)
  const volatility = Math.sqrt(
    recentReturns.reduce((sum, value) => sum + (value - returnMean) ** 2, 0) / Math.max(1, recentReturns.length),
  )
  const recentVolumes = rows.slice(Math.max(0, index - 20), index + 1)
    .map((row) => row.volume)
    .filter((value): value is number => finite(value) && value > 0)
  const volumeMedian = median(recentVolumes)
  const currentVolume = finite(rows[index].volume) ? rows[index].volume : volumeMedian
  addFeature(names, values, groups, 'price_auxiliary', 'price_return_5', return5 * 10)
  addFeature(names, values, groups, 'price_auxiliary', 'price_return_20', return20 * 10)
  addFeature(names, values, groups, 'price_auxiliary', 'price_volatility_20', volatility * 50)
  addFeature(
    names,
    values,
    groups,
    'volume_auxiliary',
    'volume_to_median_20',
    volumeMedian > 0 ? Math.log(Math.max(currentVolume, 1) / volumeMedian) : 0,
  )
  const physicsValues = [rows[index].pms, rows[index].pfs, rows[index].pes]
  for (const [physicsIndex, key] of ['pms', 'pfs', 'pes'].entries()) {
    addFeature(
      names,
      values,
      groups,
      'context_auxiliary',
      `context_${key}`,
      finite(physicsValues[physicsIndex]) ? physicsValues[physicsIndex] : 0,
    )
  }
  addFeature(
    names,
    values,
    groups,
    'context_auxiliary',
    'context_physics_available',
    physicsValues.every(finite) ? 1 : 0,
  )

  return { names, values, groups, asOfDate: rows[index].date, atr, mas }
}

function orderEntropy(values: number[]): number {
  if (values.length < 2) return 0
  const ranked = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map((item) => item.index)
  let inversions = 0
  for (let left = 0; left < ranked.length; left += 1) {
    for (let right = left + 1; right < ranked.length; right += 1) {
      if (ranked[left] > ranked[right]) inversions += 1
    }
  }
  const maximum = values.length * (values.length - 1) / 2
  return maximum ? inversions / maximum : 0
}

function pointMap(points: MaTrajectoryForecastPoint[]): Map<string, MaTrajectoryForecastPoint> {
  return new Map(points.map((point) => [point.date, point]))
}

function eventLabel(type: MaTrajectoryEventType, shortPeriod: number, longPeriod: number): string {
  const relation = `${shortPeriod}日線 / ${longPeriod}日線`
  const labels: Record<MaTrajectoryEventType, string> = {
    approach: `${relation} 接近`,
    touch: `${relation} 衝突`,
    cross: `${relation} クロス`,
    bounce: `${relation} 反発`,
    follow: `${relation} 追随`,
    closest: `${relation} 最接近`,
  }
  return labels[type]
}

export function deriveMaTrajectoryEvents(
  lines: Record<string, MaTrajectoryForecastPoint[]>,
  scenarioProbabilityPct: number,
): MaTrajectoryEvent[] {
  const events: MaTrajectoryEvent[] = []
  for (const [shortPeriod, longPeriod] of FOCUSED_EVENT_PAIRS) {
    const shortPoints = lines[String(shortPeriod)] ?? []
    const longByDate = pointMap(lines[String(longPeriod)] ?? [])
    const aligned = shortPoints
      .map((shortPoint) => {
        const longPoint = longByDate.get(shortPoint.date)
        if (!longPoint || longPoint.median === 0) return null
        return {
          date: shortPoint.date,
          gapPct: ((shortPoint.median - longPoint.median) / longPoint.median) * 100,
          short: shortPoint.median,
          long: longPoint.median,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
    if (aligned.length < 3) continue

    let closestIndex = 0
    for (let index = 1; index < aligned.length; index += 1) {
      if (Math.abs(aligned[index].gapPct) < Math.abs(aligned[closestIndex].gapPct)) closestIndex = index
    }
    const firstGap = aligned[0].gapPct
    const closest = aligned[closestIndex]
    const crossedIndex = aligned.findIndex((row, index) => (
      index > 0 && Math.sign(row.gapPct) !== Math.sign(aligned[index - 1].gapPct)
    ))
    const narrowed = Math.abs(closest.gapPct) <= Math.abs(firstGap) * 0.8
    if (narrowed) {
      events.push({
        type: 'approach',
        date: closest.date,
        shortPeriod,
        longPeriod,
        probabilityPct: round(scenarioProbabilityPct, 1),
        gapPct: round(closest.gapPct, 3),
        label: eventLabel('approach', shortPeriod, longPeriod),
      })
    }
    if (Math.abs(closest.gapPct) <= 0.35) {
      events.push({
        type: 'touch',
        date: closest.date,
        shortPeriod,
        longPeriod,
        probabilityPct: round(scenarioProbabilityPct, 1),
        gapPct: round(closest.gapPct, 3),
        label: eventLabel('touch', shortPeriod, longPeriod),
      })
    }
    if (crossedIndex > 0) {
      const crossed = aligned[crossedIndex]
      events.push({
        type: 'cross',
        date: crossed.date,
        shortPeriod,
        longPeriod,
        probabilityPct: round(scenarioProbabilityPct, 1),
        gapPct: round(crossed.gapPct, 3),
        label: eventLabel('cross', shortPeriod, longPeriod),
      })
    } else if (closestIndex < aligned.length - 2) {
      const finalGap = aligned.at(-1)?.gapPct ?? closest.gapPct
      if (Math.abs(finalGap) >= Math.max(0.45, Math.abs(closest.gapPct) * 1.8)) {
        events.push({
          type: 'bounce',
          date: closest.date,
          shortPeriod,
          longPeriod,
          probabilityPct: round(scenarioProbabilityPct, 1),
          gapPct: round(closest.gapPct, 3),
          label: eventLabel('bounce', shortPeriod, longPeriod),
        })
      }
    }

    const followWindow = aligned.slice(closestIndex, closestIndex + 8)
    const follows = followWindow.length >= 5
      && followWindow.every((row) => Math.abs(row.gapPct) <= 0.9)
      && Math.max(...followWindow.map((row) => Math.abs(row.gapPct)))
        - Math.min(...followWindow.map((row) => Math.abs(row.gapPct))) <= 0.55
    if (follows) {
      events.push({
        type: 'follow',
        date: closest.date,
        shortPeriod,
        longPeriod,
        probabilityPct: round(scenarioProbabilityPct, 1),
        gapPct: round(closest.gapPct, 3),
        label: eventLabel('follow', shortPeriod, longPeriod),
      })
    }
    events.push({
      type: 'closest',
      date: closest.date,
      shortPeriod,
      longPeriod,
      probabilityPct: round(scenarioProbabilityPct, 1),
      gapPct: round(closest.gapPct, 3),
      label: eventLabel('closest', shortPeriod, longPeriod),
    })
  }
  return events
    .sort((a, b) => (
      Number(isRelationshipEventPair(b.shortPeriod, b.longPeriod))
      - Number(isRelationshipEventPair(a.shortPeriod, a.longPeriod))
      || a.date.localeCompare(b.date)
      || Math.abs(a.gapPct) - Math.abs(b.gapPct)
    ))
    .filter((event, index, all) => all.findIndex((candidate) => (
      candidate.type === event.type
      && candidate.shortPeriod === event.shortPeriod
      && candidate.longPeriod === event.longPeriod
    )) === index)
}

export function summarizeMaEscapeStates(
  lines: Record<string, MaTrajectoryForecastPoint[]>,
  events: MaTrajectoryEvent[],
): MaEscapeStateProbability[] {
  const scores: Record<MaEscapeState, number> = {
    open_path: 1,
    collision: 0,
    rebound: 0,
    following: 0,
    constrained: 0,
    convergence_break: 0,
  }
  for (const event of events) {
    const relationshipPair = isRelationshipEventPair(event.shortPeriod, event.longPeriod)
    if (event.shortPeriod > 5 && !relationshipPair) continue
    const relationshipWeight = event.shortPeriod === 25 ? 2 : 1.4
    const weight = relationshipPair ? relationshipWeight : 1
    const confidence = Math.max(0.25, event.probabilityPct / 100)
    if (event.type === 'approach' || event.type === 'touch' || event.type === 'cross') {
      scores.collision += 1.4 * weight * confidence
    }
    if (event.type === 'bounce') {
      scores.rebound += 2.2 * weight * confidence
      if (relationshipPair) scores.convergence_break += 1.5 * weight * confidence
    }
    if (event.type === 'follow') {
      scores.following += 1.8 * weight * confidence
      scores.constrained += 0.8 * weight * confidence
    }
    if (event.type === 'closest' && relationshipPair && Math.abs(event.gapPct) <= 0.9) {
      scores.convergence_break += 0.8 * weight * confidence
    }
  }
  const short = lines['5'] ?? []
  const longPeriods: MaTrajectoryPeriod[] = [25, 75, 100, 200]
  if (short.length > 1) {
    const first = short[0].median
    const last = short.at(-1)?.median ?? first
    const direction = Math.sign(last - first)
    const targetDate = short[Math.min(short.length - 1, 10)]?.date
    const shortAtTarget = short[Math.min(short.length - 1, 10)]?.median
    if (targetDate && finite(shortAtTarget)) {
      let blockers = 0
      for (const period of longPeriods) {
        const point = lines[String(period)]?.find((candidate) => candidate.date === targetDate)
        if (!point) continue
        if (direction > 0 && point.median > shortAtTarget) blockers += 1
        if (direction < 0 && point.median < shortAtTarget) blockers += 1
      }
      scores.constrained += blockers * 0.9
      scores.open_path += Math.max(0, 3 - blockers) * 0.6
    }
  }
  const widths: number[] = []
  const dates = lines['5']?.map((point) => point.date) ?? []
  for (const date of dates) {
    const values = MA_TRAJECTORY_PERIODS
      .map((period) => lines[String(period)]?.find((point) => point.date === date)?.median)
      .filter((value): value is number => finite(value))
    if (values.length >= 4) widths.push((Math.max(...values) - Math.min(...values)) / Math.max(1e-8, median(values)))
  }
  if (widths.length >= 5) {
    const narrowest = Math.min(...widths)
    const narrowestIndex = widths.indexOf(narrowest)
    if (narrowestIndex > 0 && narrowestIndex < widths.length - 2 && widths.at(-1)! > narrowest * 1.25) {
      scores.convergence_break += 2
    }
  }

  const logits = Object.entries(scores) as Array<[MaEscapeState, number]>
  const maximum = Math.max(...logits.map(([, value]) => value))
  const exponentials = logits.map(([state, value]) => ({ state, value: Math.exp(value - maximum) }))
  const total = exponentials.reduce((sum, item) => sum + item.value, 0)
  const probabilities = exponentials.map((item) => ({
    state: item.state,
    label: ESCAPE_LABELS[item.state],
    probabilityPct: round(item.value / total * 100, 1),
  }))
  const difference = round(100 - probabilities.reduce((sum, item) => sum + item.probabilityPct, 0), 1)
  if (probabilities.length) probabilities[0].probabilityPct = round(probabilities[0].probabilityPct + difference, 1)
  return probabilities.sort((a, b) => b.probabilityPct - a.probabilityPct)
}

export function normalizeScenarioProbabilities<T extends { probabilityPct: number }>(scenarios: T[]): T[] {
  if (scenarios.length === 0) return []
  const total = scenarios.reduce((sum, scenario) => sum + Math.max(0, scenario.probabilityPct), 0)
  const normalized = scenarios.map((scenario) => ({
    ...scenario,
    probabilityPct: round((total > 0 ? Math.max(0, scenario.probabilityPct) / total : 1 / scenarios.length) * 100, 1),
  }))
  const difference = round(100 - normalized.reduce((sum, scenario) => sum + scenario.probabilityPct, 0), 1)
  normalized[0].probabilityPct = round(normalized[0].probabilityPct + difference, 1)
  return normalized
}
