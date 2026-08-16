export type ForwardExtremaBar = {
  date: string
  high: number
  low: number
  close: number
}

export type ForwardExtremaRow = {
  ticker: string
  date: string
  horizon_days: number
  return_pct: number
  end_date: string
  max_return_pct: number
  max_return_date: string
  days_to_max: number
  min_return_pct: number
  min_return_date: string
  days_to_min: number
  hit_10: number
  hit_20: number
  hit_40: number
  days_to_10: number | null
  days_to_20: number | null
  days_to_40: number | null
}

export function exactForwardExtremaRecomputeBars(horizons: readonly number[]): number {
  const validHorizons = horizons.filter((horizon) => Number.isInteger(horizon) && horizon > 0)
  if (validHorizons.length === 0) return 0
  return Math.max(...validHorizons) + 1
}

export function recentForwardExtremaLoadBars(recentDays: number, horizons: readonly number[]): number {
  if (!Number.isFinite(recentDays) || recentDays <= 0) return 0
  const validHorizons = horizons.filter((horizon) => Number.isInteger(horizon) && horizon > 0)
  if (validHorizons.length === 0) return 0
  return Math.floor(recentDays) + Math.max(...validHorizons)
}

class RangeMaxTree {
  private readonly size: number
  private readonly tree: number[]

  constructor(values: number[]) {
    let size = 1
    while (size < values.length) size *= 2
    this.size = size
    this.tree = Array.from({ length: size * 2 }, () => Number.NEGATIVE_INFINITY)
    for (let index = 0; index < values.length; index += 1) {
      this.tree[size + index] = Number.isFinite(values[index]) ? values[index] : Number.NEGATIVE_INFINITY
    }
    for (let index = size - 1; index > 0; index -= 1) {
      this.tree[index] = Math.max(this.tree[index * 2], this.tree[index * 2 + 1])
    }
  }

  firstAtOrAbove(left: number, right: number, threshold: number): number | null {
    if (left > right || this.tree[1] < threshold) return null
    return this.find(1, 0, this.size - 1, left, right, threshold)
  }

  private find(node: number, nodeLeft: number, nodeRight: number, queryLeft: number, queryRight: number, threshold: number): number | null {
    if (nodeRight < queryLeft || nodeLeft > queryRight || this.tree[node] < threshold) return null
    if (nodeLeft === nodeRight) return nodeLeft
    const middle = Math.floor((nodeLeft + nodeRight) / 2)
    return this.find(node * 2, nodeLeft, middle, queryLeft, queryRight, threshold)
      ?? this.find(node * 2 + 1, middle + 1, nodeRight, queryLeft, queryRight, threshold)
  }
}

type TargetDays = Record<10 | 20 | 40, number | null>

function futureTargetDays(bars: ForwardExtremaBar[], startIndex: number, maxHorizon: number): Map<number, TargetDays> {
  const tree = new RangeMaxTree(bars.map((bar) => bar.high))
  const result = new Map<number, TargetDays>()
  for (let index = startIndex; index < bars.length - 1; index += 1) {
    const close = bars[index]?.close
    if (!Number.isFinite(close) || close <= 0) continue
    const right = Math.min(bars.length - 1, index + maxHorizon)
    const targetDays: TargetDays = { 10: null, 20: null, 40: null }
    for (const target of [10, 20, 40] as const) {
      const hitIndex = tree.firstAtOrAbove(index + 1, right, close * (1 + target / 100))
      targetDays[target] = hitIndex == null ? null : hitIndex - index
    }
    result.set(index, targetDays)
  }
  return result
}

export function computeForwardExtremaRows(input: {
  ticker: string
  bars: ForwardExtremaBar[]
  horizons: readonly number[]
  startIndex?: number
  endDate?: string | null
}): ForwardExtremaRow[] {
  const { ticker, bars, endDate = null } = input
  const horizons = [...new Set(input.horizons.filter((horizon) => Number.isInteger(horizon) && horizon > 0))]
    .sort((a, b) => a - b)
  if (bars.length < 2 || horizons.length === 0) return []
  const startIndex = Math.max(0, input.startIndex ?? 0)
  const targetDaysByIndex = futureTargetDays(bars, startIndex, horizons[horizons.length - 1])
  const rows: ForwardExtremaRow[] = []

  for (const horizon of horizons) {
    if (bars.length <= horizon) continue
    const maxDeque: number[] = []
    const minDeque: number[] = []
    let maxHead = 0
    let minHead = 0

    const addIndex = (index: number) => {
      while (maxDeque.length > maxHead && bars[maxDeque[maxDeque.length - 1]].high < bars[index].high) maxDeque.pop()
      maxDeque.push(index)
      while (minDeque.length > minHead && bars[minDeque[minDeque.length - 1]].low > bars[index].low) minDeque.pop()
      minDeque.push(index)
    }

    for (let index = 1; index <= horizon; index += 1) addIndex(index)

    for (let index = 0; index + horizon < bars.length; index += 1) {
      const base = bars[index]
      const end = bars[index + horizon]
      if (index >= startIndex && (!endDate || base.date <= endDate) && Number.isFinite(base.close) && base.close > 0) {
        const maxIndex = maxDeque[maxHead]
        const minIndex = minDeque[minHead]
        const targetDays = targetDaysByIndex.get(index) ?? { 10: null, 20: null, 40: null }
        rows.push({
          ticker,
          date: base.date,
          horizon_days: horizon,
          return_pct: ((end.close - base.close) / base.close) * 100,
          end_date: end.date,
          max_return_pct: ((bars[maxIndex].high - base.close) / base.close) * 100,
          max_return_date: bars[maxIndex].date,
          days_to_max: maxIndex - index,
          min_return_pct: ((bars[minIndex].low - base.close) / base.close) * 100,
          min_return_date: bars[minIndex].date,
          days_to_min: minIndex - index,
          hit_10: targetDays[10] != null && targetDays[10] <= horizon ? 1 : 0,
          hit_20: targetDays[20] != null && targetDays[20] <= horizon ? 1 : 0,
          hit_40: targetDays[40] != null && targetDays[40] <= horizon ? 1 : 0,
          days_to_10: targetDays[10] != null && targetDays[10] <= horizon ? targetDays[10] : null,
          days_to_20: targetDays[20] != null && targetDays[20] <= horizon ? targetDays[20] : null,
          days_to_40: targetDays[40] != null && targetDays[40] <= horizon ? targetDays[40] : null,
        })
      }

      const expiredIndex = index + 1
      if (maxDeque[maxHead] === expiredIndex) maxHead += 1
      if (minDeque[minHead] === expiredIndex) minHead += 1
      const nextIndex = index + horizon + 1
      if (nextIndex < bars.length) addIndex(nextIndex)
    }
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.horizon_days - b.horizon_days)
}

export function computeRecentForwardExtremaRows(input: {
  ticker: string
  bars: ForwardExtremaBar[]
  horizons: readonly number[]
  recentDays: number
  startDate?: string | null
  endDate?: string | null
}): ForwardExtremaRow[] {
  const recentDays = Math.max(0, Math.floor(input.recentDays))
  if (recentDays === 0) return []
  const indexByDate = new Map(input.bars.map((bar, index) => [bar.date, index]))
  return computeForwardExtremaRows({
    ticker: input.ticker,
    bars: input.bars,
    horizons: input.horizons,
    endDate: input.endDate,
  }).filter((row) => {
    const index = indexByDate.get(row.date)
    if (index == null) return false
    const horizonStart = Math.max(0, input.bars.length - recentDays - row.horizon_days)
    return index >= horizonStart && (!input.startDate || row.date >= input.startDate)
  })
}
