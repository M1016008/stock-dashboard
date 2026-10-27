import { createHash } from 'node:crypto'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { usUniverseActivityCutoff } from '@/lib/us-universe-activity'
import {
  assessWeeklySourceReadiness,
  weeklySourceGenerationSha256,
  type WeeklyPromotionAssessment,
  type WeeklySourceObservation,
} from '@/lib/weekly-optimization-run-contract'
import { readWeeklySourceObservation } from '@/lib/weekly-source-observation'

export const US_WEEKLY_SOURCE_BOUNDARY_ENV = 'US_WEEKLY_SOURCE_BOUNDARY'

export type WeeklyUsSourceBoundary = {
  version: 1
  referenceAt: string
  capturedAt: string
  expectedTradingDate: string
  universeActivityCutoff: string
  priceBasis: string
  source: WeeklySourceObservation & { generationSha256: string }
  boundarySha256: string
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function unsignedBoundary(input: Omit<WeeklyUsSourceBoundary, 'boundarySha256'>) {
  return input
}

export function assessWeeklyUsSourceBoundary(
  boundary: WeeklyUsSourceBoundary,
  currentSource: WeeklySourceObservation,
): WeeklyPromotionAssessment {
  return assessWeeklySourceReadiness({
    expectedTradingDate: boundary.expectedTradingDate,
    universeActivityCutoff: boundary.universeActivityCutoff,
    priceBasis: boundary.priceBasis,
    source: boundary.source,
  }, currentSource)
}

export function createWeeklyUsSourceBoundary(input: {
  referenceAt: string
  capturedAt: string
  priceBasis: string
  source: WeeklySourceObservation
}): WeeklyUsSourceBoundary {
  const reference = new Date(input.referenceAt)
  const captured = new Date(input.capturedAt)
  if (Number.isNaN(reference.getTime()) || reference.toISOString() !== input.referenceAt) {
    throw new Error(`US weekly source reference must be canonical ISO; actual=${input.referenceAt}`)
  }
  if (Number.isNaN(captured.getTime()) || captured.toISOString() !== input.capturedAt) {
    throw new Error(`US weekly source capture must be canonical ISO; actual=${input.capturedAt}`)
  }
  if (captured.getTime() < reference.getTime()) {
    throw new Error('US weekly source capture precedes its reference time')
  }
  const expectedTradingDate = expectedLatestUsTradingDate(reference)
  const { generationSha256: _generationSha256, ...sourceObservation } = input.source as (
    WeeklySourceObservation & { generationSha256?: string }
  )
  const source = {
    ...sourceObservation,
    generationSha256: weeklySourceGenerationSha256(sourceObservation),
  }
  const boundaryWithoutChecksum = unsignedBoundary({
    version: 1,
    referenceAt: input.referenceAt,
    capturedAt: input.capturedAt,
    expectedTradingDate,
    universeActivityCutoff: usUniverseActivityCutoff(reference),
    priceBasis: input.priceBasis,
    source,
  })
  const boundary = {
    ...boundaryWithoutChecksum,
    boundarySha256: sha256(boundaryWithoutChecksum),
  }
  const assessment = assessWeeklyUsSourceBoundary(boundary, sourceObservation)
  if (!assessment.ok) {
    throw new Error(`US weekly source boundary is not publishable: ${assessment.issues.join(', ')}`)
  }
  const capturedAtSeconds = Math.floor(captured.getTime() / 1000)
  const timestamps = [
    sourceObservation.startedAt,
    sourceObservation.finishedAt,
    sourceObservation.maxImportedAt,
    sourceObservation.universeGeneration?.finishedAt,
    sourceObservation.universeGeneration?.maxUpdatedAt,
  ].filter((value): value is number => value != null)
  if (timestamps.some((value) => !Number.isFinite(value) || value > capturedAtSeconds)) {
    throw new Error('US weekly source boundary contains an observation newer than capturedAt')
  }
  return boundary
}

export function parseWeeklyUsSourceBoundary(raw: string): WeeklyUsSourceBoundary {
  let parsed: WeeklyUsSourceBoundary
  try {
    parsed = JSON.parse(raw) as WeeklyUsSourceBoundary
  } catch {
    throw new Error('US weekly source boundary is not valid JSON')
  }
  if (parsed.version !== 1 || typeof parsed.boundarySha256 !== 'string') {
    throw new Error('US weekly source boundary has an unsupported version')
  }
  const { boundarySha256, ...unsigned } = parsed
  const { generationSha256, ...sourceObservation } = parsed.source
  if (
    sha256(unsigned) !== boundarySha256
    || weeklySourceGenerationSha256(sourceObservation) !== generationSha256
  ) {
    throw new Error('US weekly source boundary failed its checksum')
  }
  const recreated = createWeeklyUsSourceBoundary({
    referenceAt: parsed.referenceAt,
    capturedAt: parsed.capturedAt,
    priceBasis: parsed.priceBasis,
    source: parsed.source,
  })
  if (recreated.boundarySha256 !== parsed.boundarySha256) {
    throw new Error('US weekly source boundary is inconsistent')
  }
  return recreated
}

export function captureWeeklyUsSourceBoundary(args: {
  sourceDbPath: string
  priceBasis: string
  referenceAt?: string
}): WeeklyUsSourceBoundary {
  const referenceAt = args.referenceAt ?? new Date().toISOString()
  const first = readWeeklySourceObservation('US', args.sourceDbPath, args.priceBasis)
  const second = readWeeklySourceObservation('US', args.sourceDbPath, args.priceBasis)
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('US source generation changed while its weekly boundary was captured')
  }
  return createWeeklyUsSourceBoundary({
    referenceAt,
    capturedAt: new Date().toISOString(),
    priceBasis: args.priceBasis,
    source: second,
  })
}
