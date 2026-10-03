export type SupplementalSourceHealth = {
  fresh: boolean
  configured?: boolean
  optional?: boolean
}

export function supplementalSourceNeedsAttention(source: SupplementalSourceHealth): boolean {
  return source.configured !== false && !source.fresh
}

export function supplementalSourcesAreFresh(
  sources: Record<string, SupplementalSourceHealth>,
): boolean {
  return Object.values(sources).every((source) => !supplementalSourceNeedsAttention(source))
}

export function marketPriceCoverageNeedsAttention(coverage: {
  pricePct?: number | null
  priceProcessingComplete?: boolean
} | null | undefined): boolean {
  return coverage?.pricePct != null
    && coverage.pricePct < 99.95
    && coverage.priceProcessingComplete !== true
}
