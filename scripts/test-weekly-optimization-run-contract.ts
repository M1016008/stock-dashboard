import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  processGroupExists,
  signalProcessGroup,
  waitForProcessGroupExit,
} from '@/lib/child-process-group'
import {
  assertTruncateCheckpointComplete,
  promoteSqliteGeneration,
  rollbackSqliteGeneration,
} from '@/lib/sqlite-generation-promotion'
import {
  quarantineSqliteGeneration,
  recoverInterruptedSqliteQuarantine,
  sqliteQuarantineJournalPath,
} from '@/lib/sqlite-generation-quarantine'
import {
  assertNoIncompleteSqlitePromotion,
  removeSqlitePromotionJournal,
  resolveSqlitePromotionJournalPath,
  resolveWeeklyMlPromotionJournalPath,
  writeSqlitePromotionJournal,
} from '@/lib/sqlite-promotion-journal'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { acquireUsMlProcessLock } from '@/lib/us-ml-process-lock'
import {
  acquirePidProcessLock,
  quarantineObservedStalePidProcessLock,
} from '@/lib/pid-process-lock'
import { spawnLockedProcessGroup } from '@/lib/locked-process-spawn'
import {
  DEFERRED_EXECUTION_EXIT_CODE,
  OPERATOR_ACTION_REQUIRED_EXIT_CODE,
  DeferredExecutionError,
  OperatorActionRequiredError,
  operationalExitCode,
} from '@/lib/operational-exit'
import { analogGenerationMetadataIsCurrent } from '@/lib/analog-generation-lineage'
import {
  analogSequenceGenerationIdentity,
  assertAnalogSequenceGenerationReadable,
  readAnalogSequenceIndexMeta,
} from '@/lib/db/analog-sequence-index'
import { isUsUniverseActive, usUniverseActivityCutoff } from '@/lib/us-universe-activity'
import {
  assessWeeklyPromotionReadiness,
  assessWeeklyServingOutput,
  createWeeklyOptimizationRunContract,
  foundationGenerationChanged,
  parseWeeklyOptimizationRunContract,
  resolvePinnedUsUniverseActivityCutoff,
  weeklyOptimizationContractEnv,
  weeklyRunIdentitySha256,
  type WeeklyOptimizationContractInput,
  type WeeklyPromotionObservation,
} from '@/lib/weekly-optimization-run-contract'
import {
  assessWeeklyUsSourceBoundary,
  createWeeklyUsSourceBoundary,
  parseWeeklyUsSourceBoundary,
} from '@/lib/weekly-us-source-boundary'

async function main(): Promise<void> {
const referenceAt = '2026-10-26T00:53:00.000Z'
const capturedAt = '2026-10-26T00:53:01.000Z'
const initialExpectedUsDate = expectedLatestUsTradingDate(new Date(referenceAt))
const postRolloverExpectedUsDate = expectedLatestUsTradingDate(new Date('2026-10-27T01:45:00.000Z'))
assert.equal(initialExpectedUsDate, '2026-10-23')
assert.equal(postRolloverExpectedUsDate, '2026-10-26')
assert.equal(operationalExitCode(new DeferredExecutionError('fixture')), DEFERRED_EXECUTION_EXIT_CODE)
assert.equal(
  operationalExitCode(new OperatorActionRequiredError('fixture')),
  OPERATOR_ACTION_REQUIRED_EXIT_CODE,
)

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

const sourceBoundary = createWeeklyUsSourceBoundary({
  referenceAt,
  capturedAt,
  priceBasis: input().markets.US.priceBasis,
  source: input().markets.US.source,
})
assert.deepEqual(parseWeeklyUsSourceBoundary(JSON.stringify(sourceBoundary)), sourceBoundary)
assert.deepEqual(
  assessWeeklyUsSourceBoundary(sourceBoundary, input().markets.US.source),
  { ok: true, issues: [] },
)
const changedBoundarySource = {
  ...input().markets.US.source,
  latestRunId: input().markets.US.source.latestRunId + 1,
}
const changedBoundaryAssessment = assessWeeklyUsSourceBoundary(sourceBoundary, changedBoundarySource)
assert.equal(changedBoundaryAssessment.ok, false)
assert.ok(changedBoundaryAssessment.issues.includes('source_generation_changed'))
const tamperedBoundary = structuredClone(sourceBoundary)
tamperedBoundary.expectedTradingDate = '2026-10-26'
assert.throws(
  () => parseWeeklyUsSourceBoundary(JSON.stringify(tamperedBoundary)),
  /failed its checksum/,
)

const servingAdvanced = structuredClone(contract)
servingAdvanced.markets.US.serving.updatedAt += 1
servingAdvanced.markets.US.serving.generationSha256 = 'changed-by-a-valid-weekly-step'
assert.equal(
  weeklyRunIdentitySha256(servingAdvanced),
  weeklyRunIdentitySha256(contract),
  'resume identity is stable when a completed step advances only its serving generation',
)
const sourceAdvanced = structuredClone(contract)
sourceAdvanced.markets.US.source.latestRunId += 1
sourceAdvanced.markets.US.source.generationSha256 = 'new-source'
assert.notEqual(weeklyRunIdentitySha256(sourceAdvanced), weeklyRunIdentitySha256(contract))

const unchanged: WeeklyPromotionObservation = {
  source: input().markets.US.source,
  serving: input().markets.US.serving,
}
assert.deepEqual(assessWeeklyPromotionReadiness(contract.markets.US, unchanged), {
  ok: true,
  issues: [],
})
assert.deepEqual(assessWeeklyServingOutput(contract.markets.US, unchanged.serving), {
  ok: true,
  issues: [],
})
assert.equal(assessWeeklyServingOutput(contract.markets.US, {
  ...unchanged.serving,
  lastDeltaSourceDate: '2026-10-22',
}).ok, false)
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
  let beforeReplaceCompleted = false
  const promoted = await promoteSqliteGeneration({
    primaryPath: primary,
    shadowPath: shadow,
    backupPath: backup,
    checkpoint: async () => undefined,
    clone: (source, target) => fs.copyFileSync(source, target),
    beforeReplace: async () => {
      await Promise.resolve()
      beforeReplaceCompleted = true
    },
  })
  assert.equal(beforeReplaceCompleted, true, 'the ownership callback must complete before rename')
  assert.equal(fs.readFileSync(primary, 'utf8'), 'new-generation')
  assert.equal(fs.readFileSync(backup, 'utf8'), 'old-generation')
  await rollbackSqliteGeneration(promoted, async () => undefined)
  assert.equal(fs.readFileSync(primary, 'utf8'), 'old-generation')
  assert.equal(fs.readFileSync(shadow, 'utf8'), 'new-generation')

  fs.rmSync(shadow)
  const missingBackup = path.join(fixtureRoot, 'missing-backup.db')
  await assert.rejects(
    () => rollbackSqliteGeneration({
      primaryPath: primary,
      shadowPath: shadow,
      backupPath: missingBackup,
    }, async () => undefined),
    /ENOENT/,
  )
  assert.equal(
    fs.readFileSync(primary, 'utf8'),
    'old-generation',
    'a failed rollback must restore the promoted primary instead of leaving no serving DB',
  )
  assert.equal(fs.existsSync(shadow), false)

  const stale = path.join(fixtureRoot, 'analytics.db.building')
  const quarantine = `${stale}.stale-lineage-fixture`
  fs.writeFileSync(stale, 'stale-db')
  fs.writeFileSync(`${stale}-wal`, 'stale-wal')
  fs.writeFileSync(`${stale}-shm`, 'stale-shm')
  assert.equal(quarantineSqliteGeneration(stale, quarantine), quarantine)
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${stale}${suffix}`), false)
    assert.equal(fs.readFileSync(`${quarantine}${suffix}`, 'utf8'), `stale-${suffix ? suffix.slice(1) : 'db'}`)
  }
  assert.equal(quarantineSqliteGeneration(stale, `${quarantine}-unused`), null)

  const interrupted = path.join(fixtureRoot, 'interrupted.db.building')
  const interruptedQuarantine = `${interrupted}.stale-lineage-fixture`
  for (const suffix of ['', '-wal', '-shm']) {
    fs.writeFileSync(`${interrupted}${suffix}`, `interrupted-${suffix || 'db'}`)
  }
  const interruptedMembers = ['', '-wal', '-shm'].map((suffix) => ({
    source: `${interrupted}${suffix}`,
    destination: `${interruptedQuarantine}${suffix}`,
  }))
  fs.renameSync(interrupted, interruptedQuarantine)
  fs.writeFileSync(sqliteQuarantineJournalPath(interrupted), `${JSON.stringify({
    version: 1,
    dbPath: interrupted,
    quarantinePath: interruptedQuarantine,
    createdAt: new Date().toISOString(),
    members: interruptedMembers,
  })}\n`)
  recoverInterruptedSqliteQuarantine(interrupted)
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${interrupted}${suffix}`), true)
    assert.equal(fs.existsSync(`${interruptedQuarantine}${suffix}`), false)
  }
  assert.equal(fs.existsSync(sqliteQuarantineJournalPath(interrupted)), false)

  const promotionJournalPath = path.join(fixtureRoot, 'promotion-journal.json')
  const customShadowPath = path.join(fixtureRoot, 'custom-shadow.db')
  assert.equal(
    resolveSqlitePromotionJournalPath(primary, 'fixture-basis', {
      US_ADJUSTED_FOUNDATION_SHADOW_PATH: customShadowPath,
    }),
    `${customShadowPath}.promotion-journal.json`,
  )
  writeSqlitePromotionJournal(promotionJournalPath, {
    version: 1,
    transactionId: 'fixture-transaction',
    phase: 'analog-promoted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    analog: { primaryPath: primary, shadowPath: shadow, backupPath: backup },
    analytics: { primaryPath: primary, shadowPath: shadow, backupPath: backup },
    error: null,
  })
  assert.throws(
    () => assertNoIncompleteSqlitePromotion(promotionJournalPath),
    /requires operator review.*phase=analog-promoted/,
  )
  const previousPromotionJournal = process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH
  process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH = promotionJournalPath
  assert.throws(
    () => assertAnalogSequenceGenerationReadable('US'),
    /requires operator review.*phase=analog-promoted/,
    'US public analog reads must fail closed while a promotion journal exists',
  )
  assert.doesNotThrow(() => assertAnalogSequenceGenerationReadable('JP'))
  if (previousPromotionJournal == null) {
    delete process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH
  } else {
    process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH = previousPromotionJournal
  }
  removeSqlitePromotionJournal(promotionJournalPath)
  assert.doesNotThrow(() => assertNoIncompleteSqlitePromotion(promotionJournalPath))
  fs.writeFileSync(promotionJournalPath, '{"version":1,"phase":"prepared"}\n')
  assert.throws(
    () => assertNoIncompleteSqlitePromotion(promotionJournalPath),
    (error: unknown) => error instanceof OperatorActionRequiredError,
    'a wrong-shape promotion journal must fail with exit-74 semantics',
  )
  fs.unlinkSync(promotionJournalPath)

  const analogReadPath = path.join(fixtureRoot, 'analog-read.db')
  const analogReadBackup = `${analogReadPath}.old`
  const createAnalogReadFixture = (sourceDate: string) => execFileSync('sqlite3', [
    analogReadPath,
    `CREATE TABLE analog_sequence_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
      + `INSERT INTO analog_sequence_meta VALUES ('version', '3');`
      + `INSERT INTO analog_sequence_meta VALUES ('source_date', '${sourceDate}');`
      + `INSERT INTO analog_sequence_meta VALUES ('completed', '1');`,
  ])
  const previousAnalogPath = process.env.ANALOG_US_DB_PATH
  const previousAnalyticsPath = process.env.US_ANALYTICS_DB_PATH
  const previousReadJournal = process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH
  process.env.ANALOG_US_DB_PATH = analogReadPath
  process.env.US_ANALYTICS_DB_PATH = path.join(fixtureRoot, 'analytics-read.db')
  process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH = path.join(fixtureRoot, 'read-journal.json')
  try {
    createAnalogReadFixture('2026-10-23')
    assert.equal((await readAnalogSequenceIndexMeta('US'))?.sourceDate, '2026-10-23')
    const weeklyJournalPath = resolveWeeklyMlPromotionJournalPath(process.env.US_ANALYTICS_DB_PATH)
    writeSqlitePromotionJournal(weeklyJournalPath, {
      version: 1,
      transactionId: 'weekly-fixture-transaction',
      phase: 'prepared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analog: null,
      analytics: {
        primaryPath: process.env.US_ANALYTICS_DB_PATH,
        shadowPath: `${process.env.US_ANALYTICS_DB_PATH}.weekly-ml.building`,
        backupPath: `${process.env.US_ANALYTICS_DB_PATH}.pre-weekly-fixture`,
      },
      error: 'fixture interrupted promotion',
    })
    assert.throws(
      () => assertAnalogSequenceGenerationReadable('US'),
      /requires operator review.*phase=prepared/,
      'US public analog reads must fail closed while a weekly promotion journal exists',
    )
    removeSqlitePromotionJournal(weeklyJournalPath)
    const firstAnalogGeneration = analogSequenceGenerationIdentity('US')
    fs.renameSync(analogReadPath, analogReadBackup)
    createAnalogReadFixture('2026-10-26')
    await assert.rejects(
      () => readAnalogSequenceIndexMeta('US', firstAnalogGeneration),
      /analog_sequence_generation_changed/,
      'a response must not mix Analog generations across multiple reads',
    )
    assert.equal(
      (await readAnalogSequenceIndexMeta('US'))?.sourceDate,
      '2026-10-26',
      'a renamed Analog generation must reopen the path instead of reusing the old inode',
    )
  } finally {
    if (previousAnalogPath == null) delete process.env.ANALOG_US_DB_PATH
    else process.env.ANALOG_US_DB_PATH = previousAnalogPath
    if (previousAnalyticsPath == null) delete process.env.US_ANALYTICS_DB_PATH
    else process.env.US_ANALYTICS_DB_PATH = previousAnalyticsPath
    if (previousReadJournal == null) delete process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH
    else process.env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH = previousReadJournal
  }

  const malformedQuarantineDb = path.join(fixtureRoot, 'malformed-quarantine.db')
  fs.writeFileSync(sqliteQuarantineJournalPath(malformedQuarantineDb), '{"version":1}\n')
  assert.throws(
    () => recoverInterruptedSqliteQuarantine(malformedQuarantineDb),
    (error: unknown) => error instanceof OperatorActionRequiredError,
    'a wrong-shape quarantine journal must fail with exit-74 semantics',
  )
  fs.unlinkSync(sqliteQuarantineJournalPath(malformedQuarantineDb))

  const busyDbPath = path.join(fixtureRoot, 'busy.db')
  const busyWriter = spawn('sqlite3', [busyDbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const ready = new Promise<void>((resolve, reject) => {
      busyWriter.once('error', reject)
      busyWriter.stdout?.on('data', (chunk) => {
        if (String(chunk).includes('READY')) resolve()
      })
    })
    busyWriter.stdin?.write(
      'CREATE TABLE fixture (value INTEGER); BEGIN EXCLUSIVE; INSERT INTO fixture VALUES (1);\n.print READY\n',
    )
    await ready
    assert.throws(() => execFileSync(
      'sqlite3',
      ['-cmd', '.timeout 1', busyDbPath, 'INSERT INTO fixture VALUES (2)'],
      { encoding: 'utf8', stdio: 'pipe' },
    ), /database is locked|SQLITE_BUSY/i)
    busyWriter.stdin?.end('ROLLBACK;\n.quit\n')
    await new Promise<void>((resolve, reject) => {
      busyWriter.once('close', () => resolve())
      busyWriter.once('error', reject)
    })
    execFileSync('sqlite3', [busyDbPath, 'INSERT INTO fixture VALUES (2)'])
  } finally {
    if (busyWriter.exitCode == null) busyWriter.kill('SIGTERM')
  }

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

  const replacementRaceLockPath = path.join(fixtureRoot, 'replacement-race.lock')
  const staleOwnerRaw = '{"pid":999999,"owner":"stale"}\n'
  const replacementOwnerRaw = `${JSON.stringify({
    version: 2,
    pid: process.pid,
    pidStartedAt: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(),
    processGroupId: null,
    processGroupMarkerPath: null,
    owner: 'replacement',
    label: 'fixture replacement',
    acquiredAt: new Date().toISOString(),
  })}\n`
  fs.writeFileSync(replacementRaceLockPath, staleOwnerRaw)
  const staleEvidencePath = `${replacementRaceLockPath}.stale-evidence`
  assert.equal(
    quarantineObservedStalePidProcessLock(
      replacementRaceLockPath,
      staleEvidencePath,
      staleOwnerRaw,
      () => {
        fs.unlinkSync(replacementRaceLockPath)
        fs.writeFileSync(replacementRaceLockPath, replacementOwnerRaw)
      },
    ),
    false,
    'stale recovery must not unlink a replacement owner',
  )
  assert.equal(fs.readFileSync(replacementRaceLockPath, 'utf8'), replacementOwnerRaw)
  assert.equal(fs.readFileSync(staleEvidencePath, 'utf8'), staleOwnerRaw)
  fs.unlinkSync(replacementRaceLockPath)
  fs.unlinkSync(staleEvidencePath)

  assert.doesNotThrow(() => assertTruncateCheckpointComplete({
    rows: [{ busy: 0, log: 0, checkpointed: 0 }],
  }, 'fixture.db'))
  assert.throws(
    () => assertTruncateCheckpointComplete({
      rows: [{ busy: 1, log: 12, checkpointed: 4 }],
    }, 'fixture.db'),
    (error: unknown) => error instanceof DeferredExecutionError
      && /checkpoint incomplete.*busy=1, log=12, checkpointed=4/.test(error.message),
  )

  const legacyLiveLockPath = path.join(fixtureRoot, 'legacy-live.lock')
  fs.writeFileSync(legacyLiveLockPath, `${process.pid}\n`)
  fs.utimesSync(legacyLiveLockPath, staleTime, staleTime)
  assert.equal(
    acquirePidProcessLock(legacyLiveLockPath, 'fixture legacy live owner'),
    null,
    'a live legacy PID lock must remain active during the format upgrade',
  )
  fs.unlinkSync(legacyLiveLockPath)

  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  assert.ok(orphan.pid)
  const orphanLockPath = path.join(fixtureRoot, 'orphan-child.lock')
  fs.writeFileSync(orphanLockPath, `${JSON.stringify({
    version: 2,
    pid: 999_999,
    pidStartedAt: 'dead-parent',
    processGroupId: orphan.pid,
    owner: 'dead-parent-with-live-child',
    label: 'fixture orphan child',
    acquiredAt: new Date().toISOString(),
  })}\n`)
  assert.equal(
    acquirePidProcessLock(orphanLockPath, 'fixture replacement while child lives'),
    null,
    'a live descendant process group keeps the parent lock fail-closed',
  )
  signalProcessGroup(orphan.pid, 'SIGTERM')
  await waitForProcessGroupExit(orphan.pid, 10)
  fs.utimesSync(orphanLockPath, staleTime, staleTime)
  const afterOrphan = acquirePidProcessLock(orphanLockPath, 'fixture after child exit')
  assert.ok(afterOrphan)
  afterOrphan.release()

  const markerLockPath = path.join(fixtureRoot, 'child-marker.lock')
  const markerLock = acquirePidProcessLock(markerLockPath, 'fixture child marker')
  assert.ok(markerLock)
  const markerChild = spawnLockedProcessGroup(
    markerLock,
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' },
  )
  assert.ok(markerChild.pid)
  const markerOwner = JSON.parse(fs.readFileSync(markerLockPath, 'utf8')) as {
    processGroupMarkerPath: string
  }
  for (let attempt = 0; attempt < 100 && !fs.existsSync(markerOwner.processGroupMarkerPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(
    Number(fs.readFileSync(markerOwner.processGroupMarkerPath, 'utf8').trim()),
    markerChild.pid,
    'the child group publishes its own PGID before exec',
  )
  markerLock.setProcessGroup(markerChild.pid)
  signalProcessGroup(markerChild.pid, 'SIGTERM')
  await waitForProcessGroupExit(markerChild.pid, 10)
  markerLock.setProcessGroup(null)
  markerLock.release()
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
const generationManager = read('scripts/manage-ml-pipeline-generation.ts')
const analogReader = read('lib/db/analog-sequence-index.ts')
const historicalAnalogRoute = read('app/api/ml/historical-analogs/route.ts')
const historicalAnalogCache = read('lib/server/historical-analog-cache.ts')
const weeklyWrapper = read('scripts/run-us-ml-weekly-efficient.ts')
const usMlJob = read('scripts/run-us-ml-job.ts')
const health = read('scripts/check-us-ml-health.ts')
assert.match(runner, /contract = captureRunContract\(paths\)/)
assert.match(runner, /weeklyOptimizationContractEnv\(contract\)/)
assert.match(runner, /restoreValidatedModels/)
assert.match(runner, /downstream publication was not started/)
assert.match(health, /US_ML_HEALTH_REFERENCE_AT/)
assert.match(health, /US_ML_HEALTH_ACTIVITY_CUTOFF/)
assert.match(health, /resolvePinnedUsUniverseActivityCutoff/)
assert.match(runner, /assertStepLineageUnchanged\(step, contract, paths\)/)
assert.match(runner, /assertAllSourceLineageUnchanged\(contract, paths\)/)
assert.match(runner, /assertServingOutputsCompatible\(contract, paths\)/)
assert.match(runner, /JSON\.stringify\(first\) !== JSON\.stringify\(second\)/)
assert.match(foundation, /acquireUsMlProcessLock\('adjusted-foundation-promotion'\)/)
assert.match(foundation, /rollbackSqliteGeneration\(analogPromotion, checkpointDb\)/)
assert.match(foundation, /writeAnalogMetadata\(adjustedAnalogShadowDbPath, 'price_basis'/)
assert.match(foundation, /FOUNDATION_SOURCE_LINEAGE_KEY/)
assert.match(foundation, /resumableAdjustedShadowExists\(expectedSourceLineageSha256\)/)
assert.match(foundation, /quarantineStaleAdjustedShadowLineage\(\)/)
assert.match(foundation, /seedAdjustedAnalyticsShadow\(expectedSourceLineageSha256\)/)
assert.match(foundation, /quarantineStaleSqliteGeneration\(adjustedAnalogShadowDbPath, 'analog shadow'\)/)
assert.match(foundation, /quarantineSqliteGeneration\(dbPath, quarantinePath\)/)
assert.match(foundation, /assertNoIncompleteSqlitePromotion\(promotionJournalPath\)/)
assert.match(foundation, /writeSqlitePromotionJournal\(promotionJournalPath, promotionJournal\)/)
assert.match(foundation, /removeSqlitePromotionJournal\(promotionJournalPath\)/)
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
assert.match(foundation, /spawnLockedProcessGroup/)
assert.match(foundation, /signalProcessGroup\(activeNpmProcessGroupId, 'SIGTERM'\)/)
assert.match(foundation, /waitForProcessGroupExit\(processGroupId\)/)
assert.match(foundation, /code === 75[\s\S]*DeferredExecutionError/)
assert.match(foundation, /code === 74[\s\S]*OperatorActionRequiredError/)
assert.match(foundation, /US_ANALYTICS_EXPECTED_DATE:[\s\S]*standaloneExpectedTradingDate/)
assert.match(generationManager, /acquireUsStockboardUpdateLock\('us_model_generation_promotion'/)
assert.match(generationManager, /assessWeeklySourceReadiness\(contract\.markets\.US, source\)/)
assert.match(generationManager, /assessWeeklyUsSourceBoundary\(boundary!, source\)/)
assert.match(generationManager, /parseWeeklyOptimizationRunContract[\s\S]*expectedTradingDate/)
assert.match(weeklyWrapper, /captureWeeklyUsSourceBoundary/)
assert.match(usMlJob, /captureWeeklyUsSourceBoundary/)
assert.match(generationManager, /US generation promotion requires a weekly run contract or pinned source boundary/)
assert.match(analogReader, /analogSequenceIdentities/)
assert.match(analogReader, /assertAnalogClientGenerationCurrent\(market, client, identity\)/)
assert.match(analogReader, /\['', '-wal', '-shm'\]/)
assert.match(historicalAnalogCache, /\[filePath, `\$\{filePath\}-wal`, `\$\{filePath\}-shm`\]/)
assert.match(historicalAnalogRoute, /assertHistoricalAnalogGeneration\(market, sourceGeneration\)/)
assert.match(historicalAnalogRoute, /ANALOG_GENERATION_CHANGED/)
assert.match(historicalAnalogRoute, /analog_sequence_generation_changed/)
assert.match(historicalAnalogRoute, /ANALOG_GENERATION_PROMOTION_PENDING/)
assert.match(historicalAnalogRoute, /const retryable = generationChanged/)
assert.doesNotMatch(historicalAnalogRoute, /const retryable = generationChanged \|\| promotionPending/)
assert.doesNotMatch(historicalAnalogRoute, /\n\s+message,\n/)
assert.match(runner, /acquirePidProcessLock\(lockPath, 'Weekly optimization'\)/)
assert.match(runner, /spawnLockedProcessGroup/)
assert.match(runner, /activeChildProcessGroupId = child\.pid \?\? null/)
assert.match(runner, /signalProcessGroup\(activeChildProcessGroupId, 'SIGTERM'\)/)
assert.match(runner, /waitForProcessGroupExit\(processGroupId\)/)
assert.match(runner, /weeklyProcessLock\?\.setProcessGroup\(child\.pid\)/)
assert.doesNotMatch(runner, /process\.once\('exit', releaseProcessLock\)/)
assert.match(runner, /DEFERRED_EXECUTION_EXIT_CODE/)
assert.match(runner, /operationalExitCode\(error\)/)
assert.match(runner, /\['-readonly', '-json'/)
const analogPromotionCall = foundation.lastIndexOf(
  'analogPromotion = await promoteAdjustedAnalogShadow(analogPlan.backupPath, async () => {',
)
const analogAdoptionMetadata = foundation.lastIndexOf("'analog_index_price_basis'")
assert.ok(
  analogPromotionCall >= 0
    && analogAdoptionMetadata >= 0
    && analogPromotionCall < analogAdoptionMetadata,
  'analytics metadata must not claim adoption before analog promotion succeeds',
)
assert.match(runner, /contract-capture-failed-/)
assert.match(runner, /previousState[\s\S]*run-contract capture failed before any step started/)
assert.match(runner, /resume contract is stale; no generation was modified/)
assert.match(runner, /completed steps remain resumable/)
assert.match(foundation, /deferring exit until child work and the atomic boundary are safe/)
assert.match(foundation, /the atomic boundary and journal removal completed/)
assert.ok(
  foundation.lastIndexOf("assertWeeklyUsLineageUnchanged('promotion')")
    < foundation.lastIndexOf('promoteAdjustedShadow(analyticsPlan.backupPath, async () =>'),
  'lineage must be rechecked immediately before analytics promotion',
)
assert.ok(
  foundation.lastIndexOf('acquireUpdateLock(')
    < foundation.lastIndexOf("assertWeeklyUsLineageUnchanged('promotion')"),
  'source lock must be acquired before the final lineage check',
)
assert.match(foundation, /promotionHeartbeatError = error/)
assert.match(foundation, /await assertPromotionLockOwned\(\)/)
assert.match(foundation, /promoteAdjustedShadow\(analyticsPlan\.backupPath, async \(\) => \{[\s\S]*await assertPromotionLockOwned\(\)/)
assert.match(usMlJob, /weekly-ml\.building/)
assert.match(usMlJob, /seedWeeklyShadow\(usAnalyticsDbPath, weeklyShadowPath\)/)
assert.match(usMlJob, /promoteWeeklyShadow\(/)
assert.match(usMlJob, /assertPinnedSourceCurrent\(sourcePin!\)/)
assert.match(usMlJob, /acquireUsStockboardUpdateLock\('us_model_generation_promotion'/)
assert.match(usMlJob, /beforeReplace: assertLockOwned/)
assert.ok(
  usMlJob.indexOf('await runFullHistory(env') < usMlJob.indexOf('await promoteWeeklyShadow({'),
  'full-history work must finish in the shadow before promotion',
)

  console.log('Weekly optimization run-contract regression: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
