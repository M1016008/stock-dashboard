export type UsClassificationFilters = {
  assetType: string
  sector: string
  industryGroup: string
  industry: string
}

export function supportsUsSicClassification(assetType: string): boolean {
  return assetType === '' || assetType === 'Stock'
}

export function normalizeUsClassificationFilters(
  filters: UsClassificationFilters,
): UsClassificationFilters {
  if (supportsUsSicClassification(filters.assetType)) return filters
  return {
    ...filters,
    sector: '',
    industryGroup: '',
    industry: '',
  }
}
