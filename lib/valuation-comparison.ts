export type MedianComparisonKind = 'ratio_percent' | 'percentage_point' | 'absolute_difference' | 'unavailable'

export interface MedianComparison {
  kind: MedianComparisonKind
  value: number | null
}

export type ComparableUnit = 'PERCENT' | 'MULTIPLE' | string

/**
 * Ratios across zero or negative values are misleading. Percentage metrics use
 * point differences; other metrics use an absolute difference in their unit.
 */
export function compareWithMedian(
  current: number | null,
  median: number | null,
  unit: ComparableUnit,
): MedianComparison {
  if (current == null || median == null || !Number.isFinite(current) || !Number.isFinite(median)) {
    return { kind: 'unavailable', value: null }
  }
  if (current > 0 && median > 0 && Math.abs(median) > 1e-9) {
    return { kind: 'ratio_percent', value: ((current / median) - 1) * 100 }
  }
  return {
    kind: unit === 'PERCENT' ? 'percentage_point' : 'absolute_difference',
    value: current - median,
  }
}

export function quantile(values: number[], probability: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function validValuationPeerValue(metric: string, value: number | null | undefined): value is number {
  if (value == null || !Number.isFinite(value)) return false
  return metric === 'fcf_yield' || metric === 'fcfYield' ||
    metric === 'roe' || metric === 'revenue_growth' || metric === 'revenueGrowth'
    ? true
    : value > 0
}
