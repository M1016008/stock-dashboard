export const JP_OHLCV_PUBLISHABLE_SOURCE_STATUS = 'success' as const

export function isJpOhlcvSourceGenerationPublishable(status: string | null): boolean {
  return status === JP_OHLCV_PUBLISHABLE_SOURCE_STATUS
}
