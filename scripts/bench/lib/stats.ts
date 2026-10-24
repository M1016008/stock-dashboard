/**
 * Order statistics for benchmark samples.
 *
 * Percentiles use the nearest-rank definition: p(q) = sorted[ceil(q/100 * n) - 1].
 * With n < 100 samples p99 therefore equals the maximum; reports always carry n
 * so a reader can tell how much a tail percentile is worth.
 */
export interface Summary {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

export function percentile(sortedAscending: readonly number[], q: number): number {
  if (sortedAscending.length === 0) return Number.NaN
  const rank = Math.ceil((q / 100) * sortedAscending.length)
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))]
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right)
  const n = sorted.length
  const mean = n === 0 ? Number.NaN : sorted.reduce((sum, value) => sum + value, 0) / n
  return {
    n,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1] ?? Number.NaN,
    mean,
  }
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function roundSummary(summary: Summary, digits = 2): Summary {
  return {
    n: summary.n,
    min: round(summary.min, digits),
    p50: round(summary.p50, digits),
    p95: round(summary.p95, digits),
    p99: round(summary.p99, digits),
    max: round(summary.max, digits),
    mean: round(summary.mean, digits),
  }
}
