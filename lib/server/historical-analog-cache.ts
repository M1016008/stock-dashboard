import fs from 'node:fs'
import { stableCacheKey } from '@/lib/api/serving-cache'
import { localDbPath } from '@/lib/db/client'
import { resolveAnalogSequenceIndexPath, type AnalogSequenceMarket } from '@/lib/db/analog-sequence-index'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import { MA_SEQUENCE_SCORE_VERSION, MA_SEQUENCE_VERSION } from '@/lib/ml/ma-sequence'

export const HISTORICAL_ANALOG_ML_RERANK_WEIGHT = 0.1

export function historicalAnalogResponseCacheKey(input: {
  market: AnalogSequenceMarket
  ticker: string
  requestedStartDate: string
  requestedEndDate: string
  latestMarketDate: string
  indexSourceDate: string | null
  indexUpdatedAt: string | null
  sourceGeneration: string
  profile: string
  recency: string
  sort: string
  minScore: number
  limit: number
  offset: number
}): string {
  return stableCacheKey({
    ...input,
    version: MA_SEQUENCE_VERSION,
    scoreVersion: MA_SEQUENCE_SCORE_VERSION,
    mlRerankWeight: HISTORICAL_ANALOG_ML_RERANK_WEIGHT,
  })
}

export function historicalAnalogFileGeneration(paths: readonly string[]): string {
  return stableCacheKey(paths.flatMap((filePath) => [filePath, `${filePath}-wal`].map((candidate) => {
    try {
      const stat = fs.statSync(candidate, { bigint: true })
      return {
        path: candidate,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: candidate, missing: true }
      throw error
    }
  })))
}

export function historicalAnalogSourceGeneration(market: AnalogSequenceMarket): string {
  return historicalAnalogFileGeneration([
    market === 'US' ? resolveUsAnalyticsDbPath() : localDbPath,
    resolveAnalogSequenceIndexPath(market),
  ])
}
