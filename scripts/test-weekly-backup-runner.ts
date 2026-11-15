import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MINIMUM_DESTINATION_RESERVE_BYTES,
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_SCHEMA_VERSION,
  WEEKLY_BACKUP_WRITER_LABELS,
  weeklyBackupPlanSha256,
  type Market,
  type WeeklyBackupObservation,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'
import { fileSha256, publishVerifiedGeneration } from '@/lib/storage/sqlite-rsync-generation'
import { runWeeklyBackupGeneration, type WeeklyBackupRunnerArguments,
  type WeeklyBackupRunnerPhase } from '@/lib/storage/weekly-backup-runner'
import type { ApprovedWriterIdentity, WriterHoldDriver,
  WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-weekly-runner-'))

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function main(): Promise<void> {
  try {
    const sourceMount = path.join(root, 'source-volume')
    const destinationMount = path.join(root, 'destination-volume')
    const destinationRoot = path.join(destinationMount, 'weekly')
    const priorRoot = path.join(destinationMount, 'prior')
    const toolsRoot = path.join(root, 'tools')
    fs.mkdirSync(sourceMount, { recursive: true })
    fs.mkdirSync(priorRoot, { recursive: true })
    fs.mkdirSync(toolsRoot, { recursive: true })
    const sqliteBinaryPath = path.join(toolsRoot, 'sqlite3')
    const sqliteRsyncBinaryPath = path.join(toolsRoot, 'sqlite3_rsync')
    fs.writeFileSync(sqliteBinaryPath, 'fixture sqlite3\n')
    fs.writeFileSync(sqliteRsyncBinaryPath, 'fixture sqlite3_rsync\n')
    const cloneBinaryPath = path.join(toolsRoot, 'apfs-clone-file')
    fs.writeFileSync(cloneBinaryPath, 'fixture clone\n')

    const sourceDatabasePaths = {} as Record<Market, string>
    const priorDatabasePaths = {} as Record<Market, string>
    for (const market of ['JP', 'US'] as const) {
      const source = path.join(sourceMount, `${market.toLowerCase()}.db`)
      const prior = path.join(priorRoot, `${market.toLowerCase()}.db`)
      fs.writeFileSync(source, 'prior\n')
      fs.copyFileSync(source, prior)
      fs.writeFileSync(source, `prior\n${market}-current\n`)
      sourceDatabasePaths[market] = source
      priorDatabasePaths[market] = prior
    }

    const priorManifestPath = path.join(priorRoot, 'BACKUP_ACQUIRED_WITH_LIMITATIONS.manifest.json')
    fs.writeFileSync(priorManifestPath, '{"status":"ACQUIRED_WITH_LIMITATIONS"}\n')
    const runbookPath = path.join(root, 'runbook.md')
    fs.writeFileSync(runbookPath, '# fixture runbook\n')
    const now = Date.now()
    const plan: WeeklyBackupPlan = {
      schemaVersion: WEEKLY_BACKUP_SCHEMA_VERSION,
      runId: 'weekly-runner-fixture-v1',
      oneShot: true,
      startsAt: new Date(now - 60_000).toISOString(),
      mustStartBefore: new Date(now + 60 * 60_000).toISOString(),
      mustFinishBefore: new Date(now + 49 * 60 * 60_000).toISOString(),
      destinationReserveBytes: MINIMUM_DESTINATION_RESERVE_BYTES,
      maximumCandidateGrowthBytes: 1_000_000_000,
      maximumCombinedWalBytes: 1_000_000_000,
      maximumWalGrowthBytes: 0,
      maximumWriterHoldMs: 8 * 60 * 60_000,
      maximumVerificationMs: 40 * 60 * 60_000,
      sourceMount,
      destinationMount,
      sourcePhysicalSerial: 'fixture-source-serial',
      destinationPhysicalSerial: 'fixture-destination-serial',
      sourceVolumeUuid: 'fixture-source-uuid',
      destinationVolumeUuid: 'fixture-destination-uuid',
      sourceDatabasePaths,
      priorDatabasePaths,
      destinationRoot,
      priorGenerationId: 'fixture-prior-limited',
      priorGenerationStatus: 'ACQUIRED_WITH_LIMITATIONS',
      writerLabels: [...WEEKLY_BACKUP_WRITER_LABELS],
      readerLabelsKeptOnline: [...WEEKLY_BACKUP_READER_LABELS],
      runbookSha256: fileSha256(runbookPath),
      priorManifestPath,
      priorManifestSha256: fileSha256(priorManifestPath),
      sqliteVersion: '3.54.1',
      sqliteBinaryPath,
      sqliteBinarySha256: fileSha256(sqliteBinaryPath),
      sqliteRsyncBinaryPath,
      sqliteRsyncBinarySha256: fileSha256(sqliteRsyncBinaryPath),
      sqliteToolsArchiveSha3: sha256('fixture-tools-archive'),
      stagingRoot: path.join(sourceMount, 'staging'),
      cloneBinaryPath,
      cloneBinarySha256: fileSha256(cloneBinaryPath),
      sourceReserveBytes: 300_000_000_000,
      maximumSnapshotLockMs: 60_000,
    }
    fs.mkdirSync(plan.stagingRoot)
    const approvedWriters: ApprovedWriterIdentity[] = plan.writerLabels.map((label) => ({
      label,
      definitionSha256: sha256(label),
      program: `/fixture/${label}`,
    }))
    const writerState = new Map<string, WriterRuntimeIdentity>(approvedWriters.map((writer, index) => [
      writer.label,
      {
        ...writer,
        loaded: index === 0,
        disabled: index !== 0,
        instances: index === 0 ? 1 : 0,
      },
    ]))
    let clock = now
    const lifecycle: string[] = []
    const writerDriver: WriterHoldDriver = {
      observe: async (label) => structuredClone(writerState.get(label)!),
      bootout: async (label) => {
        lifecycle.push(`bootout:${label}`)
        const state = writerState.get(label)!
        writerState.set(label, { ...state, loaded: false, instances: 0 })
      },
      bootstrap: async (label) => {
        lifecycle.push(`bootstrap:${label}`)
        const state = writerState.get(label)!
        writerState.set(label, { ...state, loaded: true, instances: 1 })
      },
      processGroupAlive: async () => false,
      sleep: async (milliseconds) => { clock += milliseconds },
      now: () => ++clock,
    }
    const observation: WeeklyBackupObservation = {
      now: new Date(now).toISOString(),
      sourceMount,
      destinationMount,
      sourcePhysicalSerial: plan.sourcePhysicalSerial,
      destinationPhysicalSerial: plan.destinationPhysicalSerial,
      sourceVolumeUuid: plan.sourceVolumeUuid,
      destinationVolumeUuid: plan.destinationVolumeUuid,
      destinationFreeBytes: 900_000_000_000,
      sourceFreeBytes: 2_000_000_000_000,
      combinedWalBytes: 0,
      activeWriterLabels: [plan.writerLabels[0]],
      unknownWriterLabels: [],
      writerLockOwners: [],
      updateWindowConflict: false,
      webHealthy: true,
      analogHealthy: true,
      existingCandidatePath: false,
      existingCompleteManifest: false,
      priorManifestSha256: plan.priorManifestSha256,
      sqliteVersion: plan.sqliteVersion,
      sqliteBinarySha256: plan.sqliteBinarySha256,
      sqliteRsyncBinarySha256: plan.sqliteRsyncBinarySha256,
      sqliteToolsArchiveSha3: plan.sqliteToolsArchiveSha3,
    }
    const phases: WeeklyBackupRunnerPhase[] = []
    const progressMarkets = new Set<Market>()
    let dynamicChecks = 0
    const dynamicObservation = () => {
      dynamicChecks += 1
      const { existingCandidatePath: _candidate, existingCompleteManifest: _manifest,
        ...dynamic } = observation
      return { ...dynamic, now: new Date().toISOString() }
    }
    const events: string[] = []
    const operations: NonNullable<WeeklyBackupRunnerArguments['operations']> = {
      cloneReplicaSeed: ({ priorDatabasePath, candidateDatabasePath }) => {
        fs.mkdirSync(path.dirname(candidateDatabasePath), { recursive: true })
        fs.copyFileSync(priorDatabasePath, candidateDatabasePath)
      },
      // Copies stand in for APFS clones: what matters here is when they are taken and what is read later.
      createLockedSqliteSnapshot: async ({ sources, stagingDirectory }) => {
        events.push(`snapshot:held=${writerState.get(plan.writerLabels[0])!.loaded === false}`)
        fs.mkdirSync(stagingDirectory)
        const files = sources.map(({ label, databasePath }) => {
          const clonePath = path.join(stagingDirectory, label, path.basename(databasePath))
          fs.mkdirSync(path.dirname(clonePath))
          fs.copyFileSync(databasePath, clonePath)
          return { label, kind: 'db' as const, sourcePath: databasePath, clonePath, bytes: fs.statSync(clonePath).size }
        })
        return { stagingDirectory, files, lockHeldMs: 250 }
      },
      checkpointSnapshotClone: async ({ databasePath }) => { events.push(`checkpoint:${path.basename(databasePath)}`) },
      runMonitoredSqliteRsync: async (syncArgs) => {
        events.push(`sync:${path.relative(sourceMount, syncArgs.sourceDatabasePath)}:held=${writerState.get(plan.writerLabels[0])!.loaded === false}`)
        assert.equal(syncArgs.monitorSourceWal, false)
        syncArgs.extraCheck?.()
        syncArgs.assertRuntimeIdentity()
        fs.copyFileSync(syncArgs.sourceDatabasePath, syncArgs.candidateDatabasePath)
        syncArgs.onProgress?.({
          at: new Date().toISOString(),
          elapsedMs: 1,
          destinationFreeBytes: 900_000_000_000,
          sourceWalBytes: 0,
          sourceWalGrowthBytes: 0,
          candidatePhysicalGrowthBytes: 0,
        })
        return { elapsedMs: 1, sourceWalGrowthBytes: 0, stderr: '' }
      },
      verifyReplica: async ({ candidateDatabasePath, restoreDatabasePath, snapshotDatabasePath, check }) => {
        events.push(`verify:${path.relative(sourceMount, snapshotDatabasePath)}`)
        check?.()
        fs.mkdirSync(path.dirname(restoreDatabasePath), { recursive: true })
        fs.copyFileSync(candidateDatabasePath, restoreDatabasePath)
        return {
          databaseSha256: fileSha256(candidateDatabasePath),
          contentSha256: fileSha256(candidateDatabasePath),
          snapshotContentSha256: fileSha256(snapshotDatabasePath),
          quickCheck: 'ok',
          integrityCheck: 'ok',
          readOnlyReopen: true,
          restoreSha256: fileSha256(restoreDatabasePath),
          restoreReadOnlyReopen: true,
        }
      },
      publishVerifiedGeneration,
    }
    const result = await runWeeklyBackupGeneration({
      plan,
      expectedPlanSha256: weeklyBackupPlanSha256(plan),
      observation,
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => undefined,
      observeDynamicGate: async () => dynamicObservation(),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => ({
        dailySchedulesUnchanged: true,
        webHealthy: true,
        analogHealthy: true,
      }),
      onPhase: (phase) => phases.push(phase),
      onProgress: (market) => progressMarkets.add(market),
      operations,
    })

    assert.deepEqual(phases, [
      'PREFLIGHT_PASSED',
      'SEEDS_CLONED',
      'SOURCE_SNAPSHOT_CREATED',
      'WRITERS_RESTORED',
      'VERIFICATION_STARTED',
      'VERIFICATION_PASSED',
      'GENERATION_PUBLISHED',
    ])
    assert.ok(lifecycle[0].startsWith('bootout:'))
    assert.ok(lifecycle.at(-1)?.startsWith('bootstrap:'))
    assert.deepEqual([...progressMarkets].sort(), ['JP', 'US'])
    // The snapshot is taken while writers are held; every later step reads only the staging clones,
    // after writers are back, and the clones are removed at the end.
    assert.deepEqual(events, [
      'snapshot:held=true',
      'checkpoint:jp.db', 'sync:staging/weekly-runner-fixture-v1/JP/jp.db:held=false',
      'checkpoint:us.db', 'sync:staging/weekly-runner-fixture-v1/US/us.db:held=false',
      'verify:staging/weekly-runner-fixture-v1/JP/jp.db', 'verify:staging/weekly-runner-fixture-v1/US/us.db',
    ])
    assert.deepEqual(fs.readdirSync(plan.stagingRoot), [])
    assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).snapshotLockHeldMs, 250)
    assert.ok(dynamicChecks >= 2, 'Dynamic state must be recollected before and after Writer Hold')
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.status, 'VERIFIED')
    assert.equal(manifest.priorGeneration.status, 'ACQUIRED_WITH_LIMITATIONS')
    assert.equal(manifest.priorGeneration.promotedAsVerified, false)
    for (const market of ['JP', 'US'] as const) {
      const databaseName = market === 'JP' ? 'stockboard.db' : 'stockboard-us.db'
      assert.match(fs.readFileSync(path.join(result.generationRoot, market, databaseName), 'utf8'),
        new RegExp(`${market}-current`))
    }

    const mismatchPlan = structuredClone(plan)
    mismatchPlan.runId = 'weekly-runner-fixture-tampered'
    await assert.rejects(() => runWeeklyBackupGeneration({
      plan: mismatchPlan,
      expectedPlanSha256: weeklyBackupPlanSha256(plan),
      observation,
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => undefined,
      observeDynamicGate: async () => dynamicObservation(),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => ({ dailySchedulesUnchanged: true,
        webHealthy: true, analogHealthy: true }),
      operations,
    }), /WEEKLY_BACKUP_PLAN_SHA256_MISMATCH/)
    assert.equal(fs.existsSync(path.join(destinationRoot, mismatchPlan.runId)), false)

    const stalePlan = structuredClone(plan)
    stalePlan.runId = 'weekly-runner-fixture-stale-gate'
    const lifecycleCountBeforeStaleGate = lifecycle.length
    await assert.rejects(() => runWeeklyBackupGeneration({
      plan: stalePlan,
      expectedPlanSha256: weeklyBackupPlanSha256(stalePlan),
      observation: { ...observation, now: new Date().toISOString() },
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => undefined,
      observeDynamicGate: async () => ({ ...dynamicObservation(), updateWindowConflict: true }),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => ({ dailySchedulesUnchanged: true,
        webHealthy: true, analogHealthy: true }),
      operations,
    }), /DAILY_UPDATE_WINDOW_CONFLICT/)
    assert.equal(lifecycle.length, lifecycleCountBeforeStaleGate,
      'A stale dynamic gate must fail before Writer Hold')
    assert.equal(fs.existsSync(path.join(destinationRoot, stalePlan.runId, 'COMPLETE.manifest.json')), false)

    // An abort signal handled after verification (during postflight) must block publication.
    const abortPlan = structuredClone(plan)
    abortPlan.runId = 'weekly-runner-fixture-abort-before-publish'
    let abortRequested = false
    await assert.rejects(() => runWeeklyBackupGeneration({
      plan: abortPlan,
      expectedPlanSha256: weeklyBackupPlanSha256(abortPlan),
      observation: { ...observation, now: new Date().toISOString() },
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => { if (abortRequested) throw new Error('OPERATOR_ABORT_REQUESTED:SIGINT') },
      observeDynamicGate: async () => dynamicObservation(),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => {
        abortRequested = true
        return { dailySchedulesUnchanged: true, webHealthy: true, analogHealthy: true }
      },
      operations,
    }), /OPERATOR_ABORT_REQUESTED/)
    assert.equal(fs.existsSync(path.join(destinationRoot, abortPlan.runId, 'COMPLETE.manifest.json')), false)

    const baseRun = (runPlan: WeeklyBackupPlan, extra: Partial<WeeklyBackupRunnerArguments> = {}) => runWeeklyBackupGeneration({
      plan: runPlan,
      expectedPlanSha256: weeklyBackupPlanSha256(runPlan),
      observation: { ...observation, now: new Date().toISOString() },
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => undefined,
      observeDynamicGate: async () => dynamicObservation(),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => ({ dailySchedulesUnchanged: true, webHealthy: true, analogHealthy: true }),
      operations,
      ...extra,
    })

    // Production writes after the snapshot (writers back, Web caches) neither fail the run nor reach the copy.
    const latePlan = structuredClone(plan)
    latePlan.runId = 'weekly-runner-fixture-write-after-snapshot'
    const late = await baseRun(latePlan, { operations: { ...operations,
      runMonitoredSqliteRsync: async (syncArgs) => {
        fs.appendFileSync(latePlan.sourceDatabasePaths.JP, 'written-after-snapshot\n')
        return operations.runMonitoredSqliteRsync(syncArgs)
      } } })
    assert.doesNotMatch(fs.readFileSync(path.join(late.generationRoot, 'JP', 'stockboard.db'), 'utf8'), /written-after-snapshot/)

    // The source-volume reserve is watched until the clones are gone: a breach stops the run and removes them.
    const reservePlan = structuredClone(plan)
    reservePlan.runId = 'weekly-runner-fixture-source-reserve'
    let sourceFree = 2_000_000_000_000
    await assert.rejects(() => baseRun(reservePlan, {
      readSourceFreeBytes: () => sourceFree,
      operations: { ...operations, checkpointSnapshotClone: async () => { sourceFree = 299_999_999_999 } },
    }), /SOURCE_RESERVE_BREACHED/)
    assert.equal(fs.existsSync(path.join(reservePlan.stagingRoot, reservePlan.runId)), false)
    assert.equal(fs.existsSync(path.join(destinationRoot, reservePlan.runId, 'COMPLETE.manifest.json')), false)

    // A snapshot failure (for example a lock that cannot be taken) restores writers and leaves no clones.
    const lockPlan = structuredClone(plan)
    lockPlan.runId = 'weekly-runner-fixture-lock-failed'
    const bootstrapsBefore = lifecycle.filter((event) => event.startsWith('bootstrap:')).length
    await assert.rejects(() => baseRun(lockPlan, { operations: { ...operations,
      createLockedSqliteSnapshot: async () => { throw new Error('SNAPSHOT_LOCK_FAILED:JP:database is locked') } } }),
    /SNAPSHOT_LOCK_FAILED:JP/)
    assert.equal(lifecycle.filter((event) => event.startsWith('bootstrap:')).length - bootstrapsBefore, 1)
    assert.equal(fs.existsSync(path.join(lockPlan.stagingRoot, lockPlan.runId)), false)

    // Not enough room on the source volume, or an existing staging directory, stops before writers are held.
    const lifecycleBeforeGates = lifecycle.length
    const headroomPlan = structuredClone(plan)
    headroomPlan.runId = 'weekly-runner-fixture-source-headroom'
    await assert.rejects(() => baseRun(headroomPlan, {
      observeDynamicGate: async () => ({ ...dynamicObservation(), sourceFreeBytes: 299_999_999_999 }) }),
    /INSUFFICIENT_SOURCE_HEADROOM/)
    const collisionPlan = structuredClone(plan)
    collisionPlan.runId = 'weekly-runner-fixture-staging-collision'
    fs.mkdirSync(path.join(collisionPlan.stagingRoot, collisionPlan.runId))
    fs.writeFileSync(path.join(collisionPlan.stagingRoot, collisionPlan.runId, 'keep'), 'x')
    await assert.rejects(() => baseRun(collisionPlan), /STAGING_DIRECTORY_COLLISION/)
    assert.equal(fs.readFileSync(path.join(collisionPlan.stagingRoot, collisionPlan.runId, 'keep'), 'utf8'), 'x')
    assert.equal(lifecycle.length, lifecycleBeforeGates)

    // A start window that closed after observation must fail before any write.
    const closedPlan = structuredClone(plan)
    closedPlan.runId = 'weekly-runner-fixture-start-window-closed'
    closedPlan.startsAt = new Date(Date.now() - 120_000).toISOString()
    closedPlan.mustStartBefore = new Date(Date.now() - 1).toISOString()
    await assert.rejects(() => runWeeklyBackupGeneration({
      plan: closedPlan,
      expectedPlanSha256: weeklyBackupPlanSha256(closedPlan),
      observation: { ...observation, now: new Date(Date.now() - 60_000).toISOString() },
      runbookPath,
      approvedWriters,
      writerDriver,
      assertRuntimeIdentity: () => undefined,
      observeDynamicGate: async () => dynamicObservation(),
      readDestinationFreeBytes: () => 900_000_000_000,
      readSourceFreeBytes: () => 2_000_000_000_000,
      observePostflight: async () => ({ dailySchedulesUnchanged: true,
        webHealthy: true, analogHealthy: true }),
      operations,
    }), /START_WINDOW_CLOSED/)
    assert.equal(fs.existsSync(path.join(destinationRoot, closedPlan.runId)), false)

    console.log(JSON.stringify({
      verdict: 'PASS',
      productionDatabaseOpened: false,
      sandiskWritten: false,
      writerRestoredBeforeVerification: phases.indexOf('WRITERS_RESTORED')
        < phases.indexOf('VERIFICATION_STARTED'),
      approvedPlanHashRequired: true,
      dynamicGateRecollected: dynamicChecks >= 2,
      markets: [...progressMarkets].sort(),
    }, null, 2))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
