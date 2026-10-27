import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  processGroupExists,
  signalProcessGroup,
  waitForProcessGroupExit,
} from '@/lib/child-process-group'
import { promoteSqliteGeneration, rollbackSqliteGeneration } from '@/lib/sqlite-generation-promotion'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { acquireUsMlProcessLock } from '@/lib/us-ml-process-lock'
import { acquirePidProcessLock } from '@/lib/pid-process-lock'
import { analogGenerationMetadataIsCurrent } from '@/lib/analog-generation-lineage'
import { isUsUniverseActive, usUniverseActivityCutoff } from '@/lib/us-universe-activity'
import {
  assessWeeklyPromotionReadiness,
  createWeeklyOptimizationRunContract,
  foundationGenerationChanged,
  parseWeeklyOptimizationRunContract,
  resolvePinnedUsUniverseActivityCutoff,
  weeklyOptimizationContractEnv,
  type WeeklyOptimizationContractInput,
  type WeeklyPromotionObservation,
} from '@/lib/weekly-optimization-run-contract'

async function main(): Promise<void> {
const referenceAt = '2026-10-26T00:53:00.000Z'
const capturedAt = '2026-10-26T00:53:01.000Z'
const initialExpectedUsDate = expectedLatestUsTradingDate(new Date(referenceAt))
const postRolloverExpectedUsDate = expectedLatestUsTradingDate(new Date('2026-10-27T01:45:00.000Z'))
assert.equal(initialExpectedUsDate, '2026-10-23')
assert.equal(postRolloverExpectedUsDate, '2026-10-26')

function input(): WeeklyOptimizationContractInput {
  return {
    referenceAt,
    capturedAt,
    markets: {
      JP: {
        expectedTradingDate: '2026-10-23',
        universeActivityCutoff: null,
        priceBasis: 'jp-split-normalized-v1',
        source: {
          latestRunId: 100,
          latestPublishableRunId: 100,
          latestRunStatus: 'success',
          runningCount: 0,
          startedAt: 1_760_000_000,
          finishedAt: 1_760_000_100,
          priceDate: '2026-10-23',
          maxImportedAt: 1_760_000_100,
          priceBasis: 'jp-split-normalized-v1',
          activeWriterLocks: [],
          universeGeneration: null,
        },
        serving: {
          generationVersion: 'full_history_then_delta_v2_calendar_stages',
          status: 'complete',
          baselineSourceDate: '2026-01-02',
          lastDeltaSourceDate: '2026-10-23',
          priceBasis: 'jp-split-normalized-v1',
          updatedAt: 1_760_000_200,
        },
      },
      US: {
        expectedTradingDate: initialExpectedUsDate,
        universeActivityCutoff: usUniverseActivityCutoff(new Date(referenceAt)),
        priceBasis: 'tiingo_adj_ohlc_ratio_v1',
        source: {
          latestRunId: 200,
          latestPublishableRunId: 200,
          latestRunStatus: 'success',
          runningCount: 0,
          startedAt: 1_760_000_300,
          finishedAt: 1_760_000_400,
          priceDate: initialExpectedUsDate,
          maxImportedAt: 1_760_000_400,
          priceBasis: 'tiingo_adj_ohlc_ratio_v1',
          activeWriterLocks: [],
          universeGeneration: {
            latestRunId: 190,
            latestPublishableRunId: 190,
            latestRunStatus: 'success',
            runningCount: 0,
            finishedAt: 1_760_000_350,
            maxUpdatedAt: 1_760_000_350,
            activeCount: 18_820,
          },
        },
        serving: {
          generationVersion: 'full_history_then_delta_v2_calendar_stages',
          status: 'complete',
          baselineSourceDate: '2026-01-02',
          lastDeltaSourceDate: initialExpectedUsDate,
          priceBasis: 'tiingo_adj_ohlc_ratio_v1',
          updatedAt: 1_760_000_500,
        },
      },
    },
  }
}

const contract = createWeeklyOptimizationRunContract(input())
const parsed = parseWeeklyOptimizationRunContract(JSON.stringify(contract))
assert.deepEqual(parsed, contract)
assert.equal(weeklyOptimizationContractEnv(contract).US_ANALYTICS_EXPECTED_DATE, '2026-10-23')
assert.equal(weeklyOptimizationContractEnv(contract).US_ML_HEALTH_REFERENCE_AT, referenceAt)
assert.equal(weeklyOptimizationContractEnv(contract).US_ML_HEALTH_ACTIVITY_CUTOFF, '2026-10-13')

const unchanged: WeeklyPromotionObservation = {
  source: input().markets.US.source,
  serving: input().markets.US.serving,
}
assert.deepEqual(assessWeeklyPromotionReadiness(contract.markets.US, unchanged), {
  ok: true,
  issues: [],
})
assert.equal(foundationGenerationChanged('lineage-a', 'lineage-a'), false)
assert.equal(foundationGenerationChanged('lineage-a', 'lineage-b'), true)
assert.equal(foundationGenerationChanged(null, 'lineage-a'), true)

const completedPartialInput = input()
completedPartialInput.markets.US.source.latestRunStatus = 'partial'
assert.doesNotThrow(() => createWeeklyOptimizationRunContract(completedPartialInput))

// A wall-clock market rollover must not silently change the pinned gate.
assert.deepEqual(assessWeeklyPromotionReadiness(contract.markets.US, unchanged), {
  ok: true,
  issues: [],
})

const sourceGenerationChanged = assessWeeklyPromotionReadiness(contract.markets.US, {
  source: {
    ...unchanged.source,
    latestRunId: 201,
    latestPublishableRunId: 201,
    priceDate: postRolloverExpectedUsDate,
    finishedAt: 1_760_100_400,
    maxImportedAt: 1_760_100_400,
  },
  serving: unchanged.serving,
})
assert.equal(sourceGenerationChanged.ok, false)
assert.ok(sourceGenerationChanged.issues.includes('source_generation_changed'))

const universeGenerationChanged = assessWeeklyPromotionReadiness(contract.markets.US, {
  ...unchanged,
  source: {
    ...unchanged.source,
    universeGeneration: {
      ...unchanged.source.universeGeneration!,
      latestRunId: 191,
      latestPublishableRunId: 191,
      finishedAt: 1_760_100_350,
      maxUpdatedAt: 1_760_100_350,
    },
  },
})
assert.equal(universeGenerationChanged.ok, false)
assert.ok(universeGenerationChanged.issues.includes('source_generation_changed'))

const servingGenerationChanged = assessWeeklyPromotionReadiness(contract.markets.US, {
  ...unchanged,
  serving: { ...unchanged.serving, updatedAt: unchanged.serving.updatedAt + 1 },
})
assert.deepEqual(servingGenerationChanged, {
  ok: false,
  issues: ['serving_generation_changed'],
})

const incompleteSource = assessWeeklyPromotionReadiness(contract.markets.US, {
  ...unchanged,
  source: {
    ...unchanged.source,
    latestRunId: 201,
    latestRunStatus: 'running',
    runningCount: 1,
    finishedAt: null,
  },
})
assert.equal(incompleteSource.ok, false)
assert.ok(incompleteSource.issues.includes('source_generation_incomplete'))
assert.ok(incompleteSource.issues.includes('source_generation_changed'))

const activeWriter = assessWeeklyPromotionReadiness(contract.markets.US, {
  ...unchanged,
  source: { ...unchanged.source, activeWriterLocks: ['us_update_latest:fixture'] },
})
assert.equal(activeWriter.ok, false)
assert.ok(activeWriter.issues.includes('source_generation_incomplete'))
assert.ok(activeWriter.issues.includes('source_generation_changed'))

const futureInput = input()
futureInput.markets.US.source.priceDate = '2026-10-26'
assert.throws(
  () => createWeeklyOptimizationRunContract(futureInput),
  /source date is not the expected completed session/,
)

const tampered = structuredClone(contract)
tampered.markets.US.source.priceDate = '2026-10-22'
assert.throws(
  () => parseWeeklyOptimizationRunContract(JSON.stringify(tampered)),
  /source date is not the expected completed session|lineage checksum/,
)

const pinnedCutoff = usUniverseActivityCutoff(new Date(referenceAt))
const laterCutoff = usUniverseActivityCutoff(new Date('2026-10-27T01:45:00.000Z'))
assert.equal(pinnedCutoff, '2026-10-13')
assert.equal(laterCutoff, '2026-10-14')
assert.equal(isUsUniverseActive('2026-10-13', pinnedCutoff), true)
assert.equal(isUsUniverseActive('2026-10-13', laterCutoff), false)
assert.equal(isUsUniverseActive(null, pinnedCutoff), false)
assert.equal(resolvePinnedUsUniverseActivityCutoff(referenceAt, pinnedCutoff), pinnedCutoff)
assert.throws(
  () => resolvePinnedUsUniverseActivityCutoff(referenceAt, laterCutoff),
  /activity cutoff is inconsistent/,
)

const analogMetadata = {
  version: '5',
  completed: '1',
  sourceDate: initialExpectedUsDate,
  priceCompleted: '1',
  priceSourceDate: initialExpectedUsDate,
  priceChunksCompleted: '1',
  priceChunksSourceDate: initialExpectedUsDate,
  priceBasis: null,
  sourceLineageSha256: 'source-a',
}
assert.equal(analogGenerationMetadataIsCurrent(analogMetadata, {
  version: 5,
  sourceDate: initialExpectedUsDate,
  priceBasis: 'tiingo_adj_ohlc_ratio_v1',
  sourceLineageSha256: 'source-a',
}), false, 'a date-current analog generation without price-basis lineage is not reusable')
assert.equal(analogGenerationMetadataIsCurrent({
  ...analogMetadata,
  priceBasis: 'tiingo_adj_ohlc_ratio_v1',
}, {
  version: 5,
  sourceDate: initialExpectedUsDate,
  priceBasis: 'tiingo_adj_ohlc_ratio_v1',
  sourceLineageSha256: 'source-a',
}), true)
assert.equal(analogGenerationMetadataIsCurrent({
  ...analogMetadata,
  priceBasis: 'tiingo_adj_ohlc_ratio_v1',
}, {
  version: 5,
  sourceDate: initialExpectedUsDate,
  priceBasis: 'tiingo_adj_ohlc_ratio_v1',
  sourceLineageSha256: 'source-b',
}), false, 'same-date analog generations from another source lineage are not reusable')

const futureObservation = input()
futureObservation.markets.US.source.finishedAt = Math.floor(new Date(capturedAt).getTime() / 1000) + 1
assert.throws(
  () => createWeeklyOptimizationRunContract(futureObservation),
  /lineage observation is newer than capturedAt/,
)

const weekendReference = '2026-10-24T00:53:00.000Z'
const weekendNextReference = '2026-10-25T00:53:00.000Z'
assert.equal(
  expectedLatestUsTradingDate(new Date(weekendReference)),
  expectedLatestUsTradingDate(new Date(weekendNextReference)),
)
assert.notEqual(
  usUniverseActivityCutoff(new Date(weekendReference)),
  usUniverseActivityCutoff(new Date(weekendNextReference)),
  'the activity cutoff can advance even while the expected trading date is unchanged',
)
const contractAt = (at: string) => {
  const value = input()
  const reference = new Date(at)
  value.referenceAt = at
  value.capturedAt = new Date(reference.getTime() + 1_000).toISOString()
  value.markets.JP.expectedTradingDate = expectedLatestTradingDate(reference)
  value.markets.JP.source.priceDate = value.markets.JP.expectedTradingDate
  value.markets.JP.serving.lastDeltaSourceDate = value.markets.JP.expectedTradingDate
  value.markets.US.expectedTradingDate = expectedLatestUsTradingDate(reference)
  value.markets.US.universeActivityCutoff = usUniverseActivityCutoff(reference)
  value.markets.US.source.priceDate = value.markets.US.expectedTradingDate
  value.markets.US.serving.lastDeltaSourceDate = value.markets.US.expectedTradingDate
  return createWeeklyOptimizationRunContract(value)
}
assert.notEqual(
  contractAt(weekendReference).lineageSha256,
  contractAt(weekendNextReference).lineageSha256,
  'an activity-cutoff rollover must invalidate resumable step state',
)

const incompleteGeneration = input()
incompleteGeneration.markets.US.source.latestRunStatus = 'running'
incompleteGeneration.markets.US.source.runningCount = 1
incompleteGeneration.markets.US.source.finishedAt = null
assert.throws(
  () => createWeeklyOptimizationRunContract(incompleteGeneration),
  /source generation is not a completed immutable publication/,
)

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-contract-'))
try {
  const primary = path.join(fixtureRoot, 'analog.db')
  const shadow = `${primary}.building`
  const backup = `${primary}.pre-fixture`
  fs.writeFileSync(primary, 'old-generation')
  fs.writeFileSync(shadow, 'new-generation')
  const promoted = await promoteSqliteGeneration({
    primaryPath: primary,
    shadowPath: shadow,
    backupPath: backup,
    checkpoint: async () => undefined,
    clone: (source, target) => fs.copyFileSync(source, target),
  })
  assert.equal(fs.readFileSync(primary, 'utf8'), 'new-generation')
  assert.equal(fs.readFileSync(backup, 'utf8'), 'old-generation')
  await rollbackSqliteGeneration(promoted, async () => undefined)
  assert.equal(fs.readFileSync(primary, 'utf8'), 'old-generation')
  assert.equal(fs.readFileSync(shadow, 'utf8'), 'new-generation')

  const lockPath = path.join(fixtureRoot, 'us-ml.lock')
  const firstLock = acquireUsMlProcessLock('fixture-first', lockPath)
  assert.ok(firstLock)
  assert.equal(acquireUsMlProcessLock('fixture-second', lockPath), null)
  firstLock.release()
  const replacementLock = acquireUsMlProcessLock('fixture-replacement', lockPath)
  assert.ok(replacementLock)
  replacementLock.release()

  const publishingMlLockPath = path.join(fixtureRoot, 'us-ml-publishing.lock')
  fs.writeFileSync(publishingMlLockPath, '')
  assert.equal(acquireUsMlProcessLock('fixture-publishing', publishingMlLockPath), null)
  assert.equal(fs.existsSync(publishingMlLockPath), true, 'a newly-created owner record is never reclaimed')
  const staleTime = new Date(Date.now() - 120_000)
  fs.utimesSync(publishingMlLockPath, staleTime, staleTime)
  const reclaimedMlLock = acquireUsMlProcessLock('fixture-stale', publishingMlLockPath)
  assert.ok(reclaimedMlLock)
  reclaimedMlLock.release()

  const builderLockPath = path.join(fixtureRoot, 'analog.db.process.lock')
  const builderLock = acquirePidProcessLock(builderLockPath, 'fixture analog builder')
  assert.ok(builderLock)
  assert.equal(
    acquirePidProcessLock(builderLockPath, 'fixture promotion'),
    null,
    'promotion must not overlap the builder that owns the renamed DB',
  )
  builderLock.release()
  const promotionLock = acquirePidProcessLock(builderLockPath, 'fixture promotion retry')
  assert.ok(promotionLock)
  promotionLock.release()

  const publishingBuilderLockPath = path.join(fixtureRoot, 'builder-publishing.lock')
  fs.writeFileSync(publishingBuilderLockPath, '')
  assert.equal(acquirePidProcessLock(publishingBuilderLockPath, 'fixture publishing builder'), null)
  assert.equal(fs.existsSync(publishingBuilderLockPath), true)
  fs.utimesSync(publishingBuilderLockPath, staleTime, staleTime)
  const reclaimedBuilderLock = acquirePidProcessLock(publishingBuilderLockPath, 'fixture stale builder')
  assert.ok(reclaimedBuilderLock)
  reclaimedBuilderLock.release()
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}

const groupLeader = spawn(
  process.execPath,
  [
    '-e',
    `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      setTimeout(() => process.exit(0), 100);
    `,
  ],
  { detached: true, stdio: 'ignore' },
)
const processGroupId = groupLeader.pid
assert.ok(processGroupId)
await new Promise<void>((resolve, reject) => {
  groupLeader.once('close', () => resolve())
  groupLeader.once('error', reject)
})
assert.equal(processGroupExists(processGroupId), true)
try {
  signalProcessGroup(processGroupId, 'SIGTERM')
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      waitForProcessGroupExit(processGroupId, 10),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('fixture process group did not exit')), 5_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  assert.equal(processGroupExists(processGroupId), false)
} finally {
  if (processGroupExists(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL')
}

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')
const runner = read('scripts/run-weekly-optimization.ts')
const foundation = read('scripts/ensure-us-adjusted-foundation.ts')
const health = read('scripts/check-us-ml-health.ts')
assert.match(runner, /contract = captureRunContract\(paths\)/)
assert.match(runner, /weeklyOptimizationContractEnv\(contract\)/)
assert.match(runner, /restoreValidatedModels/)
assert.match(runner, /downstream publication was not started/)
assert.match(health, /US_ML_HEALTH_REFERENCE_AT/)
assert.match(health, /US_ML_HEALTH_ACTIVITY_CUTOFF/)
assert.match(health, /resolvePinnedUsUniverseActivityCutoff/)
assert.match(runner, /assertStepLineageUnchanged\(step, contract, paths\)/)
assert.match(runner, /JSON\.stringify\(first\) !== JSON\.stringify\(second\)/)
assert.match(foundation, /acquireUsMlProcessLock\('adjusted-foundation-promotion'\)/)
assert.match(foundation, /rollbackSqliteGeneration\(analogPromotion, checkpointDb\)/)
assert.match(foundation, /writeAnalogMetadata\(adjustedAnalogShadowDbPath, 'price_basis'/)
assert.match(foundation, /FOUNDATION_SOURCE_LINEAGE_KEY/)
assert.match(foundation, /resumableAdjustedShadowExists\(expectedSourceLineageSha256\)/)
assert.match(foundation, /quarantineStaleAdjustedShadowLineage\(\)/)
assert.match(foundation, /seedAdjustedAnalyticsShadow\(expectedSourceLineageSha256\)/)
assert.match(foundation, /quarantineStaleSqliteGeneration\(adjustedAnalogShadowDbPath, 'analog shadow'\)/)
assert.match(foundation, /seedAdjustedAnalogShadow\(priceDate, expectedSourceLineageSha256\)/)
assert.match(foundation, /US adjusted foundation promotion deferred: the analog builder is active/)
const primaryGuard = foundation.indexOf(
  "assertWritableTargetPath(usAnalyticsDbPath, 'us-adjusted-primary')",
)
const foundationLock = foundation.indexOf('const processLock = acquireFoundationProcessLock()')
assert.ok(
  primaryGuard >= 0 && foundationLock >= 0 && primaryGuard < foundationLock,
  'primary Storage Guard checks must precede foundation lock creation',
)
assert.match(foundation, /detached: true/)
assert.match(foundation, /signalProcessGroup\(activeNpmProcessGroupId, 'SIGTERM'\)/)
assert.match(foundation, /waitForProcessGroupExit\(processGroupId\)/)
assert.match(runner, /acquirePidProcessLock\(lockPath, 'Weekly optimization'\)/)
assert.match(runner, /activeChildProcessGroupId = child\.pid \?\? null/)
assert.match(runner, /signalProcessGroup\(activeChildProcessGroupId, 'SIGTERM'\)/)
assert.match(runner, /waitForProcessGroupExit\(processGroupId\)/)
assert.match(runner, /\['-readonly', '-json'/)
const analogPromotionCall = foundation.lastIndexOf(
  'analogPromotion = await promoteAdjustedAnalogShadow(() => {',
)
const analogAdoptionMetadata = foundation.lastIndexOf("'analog_index_price_basis'")
assert.ok(
  analogPromotionCall >= 0
    && analogAdoptionMetadata >= 0
    && analogPromotionCall < analogAdoptionMetadata,
  'analytics metadata must not claim adoption before analog promotion succeeds',
)
assert.match(runner, /contract-capture-failed-/)
assert.match(foundation, /deferring exit until child work and the atomic boundary are safe/)
assert.match(foundation, /the atomic boundary completed before shutdown/)
assert.ok(
  foundation.lastIndexOf("assertWeeklyUsLineageUnchanged('promotion')")
    < foundation.lastIndexOf('promoteAdjustedShadow(() =>'),
  'lineage must be rechecked immediately before analytics promotion',
)
assert.ok(
  foundation.lastIndexOf('acquireUpdateLock(')
    < foundation.lastIndexOf("assertWeeklyUsLineageUnchanged('promotion')"),
  'source lock must be acquired before the final lineage check',
)

  console.log('Weekly optimization run-contract regression: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
