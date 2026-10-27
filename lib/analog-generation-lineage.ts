export type AnalogGenerationMetadata = {
  version: string | null
  completed: string | null
  sourceDate: string | null
  priceCompleted: string | null
  priceSourceDate: string | null
  priceChunksCompleted: string | null
  priceChunksSourceDate: string | null
  priceBasis: string | null
  sourceLineageSha256: string | null
}

export function analogGenerationMetadataIsCurrent(
  metadata: AnalogGenerationMetadata,
  expected: { version: number; sourceDate: string; priceBasis: string; sourceLineageSha256: string },
): boolean {
  return Number(metadata.version) === expected.version
    && metadata.completed === '1'
    && metadata.sourceDate === expected.sourceDate
    && metadata.priceCompleted === '1'
    && metadata.priceSourceDate === expected.sourceDate
    && metadata.priceChunksCompleted === '1'
    && metadata.priceChunksSourceDate === expected.sourceDate
    && metadata.priceBasis === expected.priceBasis
    && metadata.sourceLineageSha256 === expected.sourceLineageSha256
}
