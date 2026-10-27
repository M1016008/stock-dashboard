import { createHash } from 'node:crypto'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { usUniverseActivityCutoff } from '@/lib/us-universe-activity'

export type WeeklyOptimizationMarket = 'JP' | 'US'

export type WeeklySourceObservation = {
  latestRunId: number
  latestPublishableRunId: number
  latestRunStatus: string
  runningCount: number
  startedAt: number | null
  finishedAt: number | null
  priceDate: string
  maxImportedAt: number | null
  priceBasis: string
  activeWriterLocks: string[]
  universeGeneration: WeeklyUniverseObservation | null
}

export type WeeklyUniverseObservation = {
  latestRunId: number
  latestPublishableRunId: number
  latestRunStatus: string
  runningCount: number
  finishedAt: number | null
  maxUpdatedAt: number | null
  activeCount: number
}

export type WeeklyServingObservation = {
  generationVersion: string
  status: string
  baselineSourceDate: string
  lastDeltaSourceDate: string
  priceBasis: string
  updatedAt: number
}

export type WeeklyMarketRunContract = {
  expectedTradingDate: string
  universeActivityCutoff: string | null
  priceBasis: string
  source: WeeklySourceObservation & { generationSha256: string }
  serving: WeeklyServingObservation & { generationSha256: string }
}

export type WeeklyOptimizationRunContract = {
  version: 3
  referenceAt: string
  capturedAt: string
  markets: Record<WeeklyOptimizationMarket, WeeklyMarketRunContract>
  lineageSha256: string
  contractSha256: string
}

export type WeeklyOptimizationContractInput = {
  referenceAt: string
  capturedAt: string
  markets: Record<WeeklyOptimizationMarket, {
    expectedTradingDate: string
    universeActivityCutoff: string | null
    priceBasis: string
    source: WeeklySourceObservation
    serving: WeeklyServingObservation
  }>
}

export type WeeklyPromotionObservation = {
  source: WeeklySourceObservation
  serving: WeeklyServingObservation
}

export type WeeklyPromotionAssessment = {
  ok: boolean
  issues: string[]
}

export type WeeklySourceContract = Pick<
  WeeklyMarketRunContract,
  'expectedTradingDate' | 'universeActivityCutoff' | 'priceBasis' | 'source'
>

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertDate(label: string, value: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO trading date; actual=${value || '-'}`)
  }
}

export function resolvePinnedUsUniverseActivityCutoff(
  referenceAt: string,
  pinnedCutoff?: string | null,
): string {
  const reference = new Date(referenceAt)
  if (Number.isNaN(reference.getTime()) || reference.toISOString() !== referenceAt) {
    throw new Error(`US activity reference must be a canonical ISO timestamp; actual=${referenceAt}`)
  }
  const derived = usUniverseActivityCutoff(reference)
  if (pinnedCutoff && pinnedCutoff !== derived) {
    throw new Error(
      `US activity cutoff is inconsistent with the pinned reference: `
      + `expected=${derived}, actual=${pinnedCutoff}`,
    )
  }
  return pinnedCutoff || derived
}

export function weeklySourceGenerationSha256(source: WeeklySourceObservation): string {
  return sha256(source)
}

export function foundationGenerationChanged(
  lineageBefore: string | null,
  lineageAfter: string | null,
): boolean {
  return lineageBefore == null || lineageAfter !== lineageBefore
}

export function weeklyRunIdentitySha256(contract: WeeklyOptimizationRunContract): string {
  return sha256({
    version: contract.version,
    referenceDates: {
      JP: contract.markets.JP.expectedTradingDate,
      US: contract.markets.US.expectedTradingDate,
      usUniverseActivityCutoff: contract.markets.US.universeActivityCutoff,
    },
    priceBasis: {
      JP: contract.markets.JP.priceBasis,
      US: contract.markets.US.priceBasis,
    },
    source: {
      JP: contract.markets.JP.source.generationSha256,
      US: contract.markets.US.source.generationSha256,
    },
  })
}

export function weeklyServingGenerationSha256(serving: WeeklyServingObservation): string {
  return sha256(serving)
}

function sourceWithoutChecksum(
  source: WeeklyMarketRunContract['source'],
): WeeklySourceObservation {
  const { generationSha256: _generationSha256, ...observation } = source
  return observation
}

function servingWithoutChecksum(
  serving: WeeklyMarketRunContract['serving'],
): WeeklyServingObservation {
  const { generationSha256: _generationSha256, ...observation } = serving
  return observation
}

function assertMarketInput(
  market: WeeklyOptimizationMarket,
  input: WeeklyOptimizationContractInput['markets'][WeeklyOptimizationMarket],
  referenceAt: Date,
  capturedAtSeconds: number,
): void {
  assertDate(`${market} expectedTradingDate`, input.expectedTradingDate)
  const derivedExpectedDate = market === 'JP'
    ? expectedLatestTradingDate(referenceAt)
    : expectedLatestUsTradingDate(referenceAt)
  if (input.expectedTradingDate !== derivedExpectedDate) {
    throw new Error(
      `${market} expectedTradingDate is inconsistent with referenceAt: `
      + `expected=${derivedExpectedDate}, actual=${input.expectedTradingDate}`,
    )
  }
  if (market === 'US') {
    if (!input.universeActivityCutoff) {
      throw new Error('US universe activity cutoff is required')
    }
    assertDate('US universeActivityCutoff', input.universeActivityCutoff)
    const derivedCutoff = usUniverseActivityCutoff(referenceAt)
    if (input.universeActivityCutoff !== derivedCutoff) {
      throw new Error(
        `US universeActivityCutoff is inconsistent with referenceAt: `
        + `expected=${derivedCutoff}, actual=${input.universeActivityCutoff}`,
      )
    }
  } else if (input.universeActivityCutoff !== null) {
    throw new Error('JP universe activity cutoff must be null')
  }
  assertDate(`${market} source priceDate`, input.source.priceDate)
  assertDate(`${market} serving baselineSourceDate`, input.serving.baselineSourceDate)
  assertDate(`${market} serving lastDeltaSourceDate`, input.serving.lastDeltaSourceDate)
  if (!input.priceBasis || input.source.priceBasis !== input.priceBasis) {
    throw new Error(`${market} source price basis is incompatible`)
  }
  if (input.serving.priceBasis !== input.priceBasis) {
    throw new Error(`${market} serving price basis is incompatible`)
  }
  if (
    input.source.latestRunId <= 0
    || input.source.latestPublishableRunId !== input.source.latestRunId
    || !['success', 'partial'].includes(input.source.latestRunStatus)
    || input.source.runningCount !== 0
    || input.source.activeWriterLocks.length !== 0
    || input.source.finishedAt == null
  ) {
    throw new Error(`${market} source generation is not a completed immutable publication`)
  }
  if (market === 'US') {
    const universe = input.source.universeGeneration
    if (
      !universe
      || universe.latestRunId <= 0
      || universe.latestPublishableRunId !== universe.latestRunId
      || !['success', 'partial'].includes(universe.latestRunStatus)
      || universe.runningCount !== 0
      || universe.finishedAt == null
      || universe.activeCount <= 0
    ) {
      throw new Error('US universe generation is not a completed immutable publication')
    }
  }
  if (input.source.priceDate !== input.expectedTradingDate) {
    throw new Error(
      `${market} source date is not the expected completed session: expected=${input.expectedTradingDate}, actual=${input.source.priceDate}`,
    )
  }
  if (input.serving.status !== 'complete' || !input.serving.generationVersion) {
    throw new Error(`${market} serving generation is incomplete`)
  }
  if (input.serving.baselineSourceDate > input.serving.lastDeltaSourceDate) {
    throw new Error(`${market} serving generation has non-monotonic lineage`)
  }
  if (input.serving.lastDeltaSourceDate > input.expectedTradingDate) {
    throw new Error(`${market} serving generation contains future data`)
  }
  const observedTimestamps = [
    input.source.startedAt,
    input.source.finishedAt,
    input.source.maxImportedAt,
    input.serving.updatedAt,
    input.source.universeGeneration?.finishedAt,
    input.source.universeGeneration?.maxUpdatedAt,
  ].filter((value): value is number => value != null)
  if (observedTimestamps.some((value) => !Number.isFinite(value) || value > capturedAtSeconds)) {
    throw new Error(`${market} lineage observation is newer than capturedAt`)
  }
}

export function createWeeklyOptimizationRunContract(
  input: WeeklyOptimizationContractInput,
): WeeklyOptimizationRunContract {
  const referenceAt = new Date(input.referenceAt)
  const capturedAt = new Date(input.capturedAt)
  if (Number.isNaN(referenceAt.getTime()) || referenceAt.toISOString() !== input.referenceAt) {
    throw new Error(`weekly optimization referenceAt must be a canonical ISO timestamp; actual=${input.referenceAt}`)
  }
  if (Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== input.capturedAt) {
    throw new Error(`weekly optimization capturedAt must be a canonical ISO timestamp; actual=${input.capturedAt}`)
  }
  if (capturedAt.getTime() < referenceAt.getTime()) {
    throw new Error('weekly optimization capturedAt precedes referenceAt')
  }

  const capturedAtSeconds = Math.floor(capturedAt.getTime() / 1000)
  assertMarketInput('JP', input.markets.JP, referenceAt, capturedAtSeconds)
  assertMarketInput('US', input.markets.US, referenceAt, capturedAtSeconds)
  const markets = {
    JP: {
      ...input.markets.JP,
      source: {
        ...input.markets.JP.source,
        generationSha256: weeklySourceGenerationSha256(input.markets.JP.source),
      },
      serving: {
        ...input.markets.JP.serving,
        generationSha256: weeklyServingGenerationSha256(input.markets.JP.serving),
      },
    },
    US: {
      ...input.markets.US,
      source: {
        ...input.markets.US.source,
        generationSha256: weeklySourceGenerationSha256(input.markets.US.source),
      },
      serving: {
        ...input.markets.US.serving,
        generationSha256: weeklyServingGenerationSha256(input.markets.US.serving),
      },
    },
  } satisfies WeeklyOptimizationRunContract['markets']
  const lineageSha256 = sha256({ version: 3, markets })
  const unsigned = {
    version: 3 as const,
    referenceAt: input.referenceAt,
    capturedAt: input.capturedAt,
    markets,
    lineageSha256,
  }
  return { ...unsigned, contractSha256: sha256(unsigned) }
}

export function parseWeeklyOptimizationRunContract(raw: string): WeeklyOptimizationRunContract {
  let parsed: WeeklyOptimizationRunContract
  try {
    parsed = JSON.parse(raw) as WeeklyOptimizationRunContract
  } catch {
    throw new Error('weekly optimization run contract is not valid JSON')
  }
  if (parsed.version !== 3 || typeof parsed.contractSha256 !== 'string') {
    throw new Error('weekly optimization run contract has an unsupported version')
  }
  const recreated = createWeeklyOptimizationRunContract({
    referenceAt: parsed.referenceAt,
    capturedAt: parsed.capturedAt,
    markets: {
      JP: {
        expectedTradingDate: parsed.markets?.JP?.expectedTradingDate,
        universeActivityCutoff: parsed.markets?.JP?.universeActivityCutoff,
        priceBasis: parsed.markets?.JP?.priceBasis,
        source: sourceWithoutChecksum(parsed.markets.JP.source),
        serving: servingWithoutChecksum(parsed.markets.JP.serving),
      },
      US: {
        expectedTradingDate: parsed.markets?.US?.expectedTradingDate,
        universeActivityCutoff: parsed.markets?.US?.universeActivityCutoff,
        priceBasis: parsed.markets?.US?.priceBasis,
        source: sourceWithoutChecksum(parsed.markets.US.source),
        serving: servingWithoutChecksum(parsed.markets.US.serving),
      },
    },
  })
  if (
    parsed.contractSha256 !== recreated.contractSha256
    || parsed.lineageSha256 !== recreated.lineageSha256
    || parsed.markets.JP.source.generationSha256 !== recreated.markets.JP.source.generationSha256
    || parsed.markets.US.source.generationSha256 !== recreated.markets.US.source.generationSha256
    || parsed.markets.JP.serving.generationSha256 !== recreated.markets.JP.serving.generationSha256
    || parsed.markets.US.serving.generationSha256 !== recreated.markets.US.serving.generationSha256
  ) {
    throw new Error('weekly optimization run contract failed its lineage checksum')
  }
  return recreated
}

export function weeklyOptimizationContractEnv(
  contract: WeeklyOptimizationRunContract,
): Record<string, string> {
  return {
    WEEKLY_OPTIMIZATION_CONTRACT: JSON.stringify(contract),
    WEEKLY_OPTIMIZATION_REFERENCE_AT: contract.referenceAt,
    WEEKLY_OPTIMIZATION_CAPTURED_AT: contract.capturedAt,
    WEEKLY_OPTIMIZATION_LINEAGE_SHA256: contract.lineageSha256,
    US_ANALYTICS_EXPECTED_DATE: contract.markets.US.expectedTradingDate,
    US_ML_HEALTH_REFERENCE_AT: contract.referenceAt,
    US_ML_HEALTH_ACTIVITY_CUTOFF: contract.markets.US.universeActivityCutoff ?? '',
  }
}

export function assessWeeklyPromotionReadiness(
  marketContract: WeeklyMarketRunContract,
  current: WeeklyPromotionObservation,
): WeeklyPromotionAssessment {
  const sourceAssessment = assessWeeklySourceReadiness(marketContract, current.source)
  const issues = [...sourceAssessment.issues]
  if (
    current.serving.status !== 'complete'
    || current.serving.priceBasis !== marketContract.priceBasis
    || current.serving.lastDeltaSourceDate > marketContract.expectedTradingDate
  ) {
    issues.push('serving_generation_incompatible')
  }
  if (weeklyServingGenerationSha256(current.serving) !== marketContract.serving.generationSha256) {
    issues.push('serving_generation_changed')
  }
  return { ok: issues.length === 0, issues }
}

export function assessWeeklyServingOutput(
  marketContract: WeeklyMarketRunContract,
  currentServing: WeeklyServingObservation,
): WeeklyPromotionAssessment {
  const issues: string[] = []
  if (
    currentServing.status !== 'complete'
    || !currentServing.generationVersion
    || currentServing.priceBasis !== marketContract.priceBasis
    || currentServing.baselineSourceDate > currentServing.lastDeltaSourceDate
  ) {
    issues.push('serving_generation_incompatible')
  }
  if (currentServing.lastDeltaSourceDate !== marketContract.expectedTradingDate) {
    issues.push(
      `serving_not_fresh:${currentServing.lastDeltaSourceDate}->${marketContract.expectedTradingDate}`,
    )
  }
  return { ok: issues.length === 0, issues }
}

export function assessWeeklySourceReadiness(
  marketContract: WeeklySourceContract,
  currentSource: WeeklySourceObservation,
): WeeklyPromotionAssessment {
  const issues: string[] = []
  if (
    currentSource.latestRunId <= 0
    || currentSource.latestPublishableRunId !== currentSource.latestRunId
    || !['success', 'partial'].includes(currentSource.latestRunStatus)
    || currentSource.runningCount !== 0
    || currentSource.activeWriterLocks.length !== 0
    || currentSource.finishedAt == null
  ) {
    issues.push('source_generation_incomplete')
  }
  const universe = currentSource.universeGeneration
  if (
    marketContract.universeActivityCutoff
    && (
      !universe
      || universe.latestRunId <= 0
      || universe.latestPublishableRunId !== universe.latestRunId
      || !['success', 'partial'].includes(universe.latestRunStatus)
      || universe.runningCount !== 0
      || universe.finishedAt == null
      || universe.activeCount <= 0
    )
  ) {
    issues.push('source_universe_generation_incomplete')
  }
  if (currentSource.priceDate !== marketContract.expectedTradingDate) {
    issues.push(`source_not_fresh:${currentSource.priceDate}->${marketContract.expectedTradingDate}`)
  }
  if (currentSource.priceBasis !== marketContract.priceBasis) {
    issues.push('source_price_basis_changed')
  }
  if (weeklySourceGenerationSha256(currentSource) !== marketContract.source.generationSha256) {
    issues.push('source_generation_changed')
  }
  return { ok: issues.length === 0, issues }
}
