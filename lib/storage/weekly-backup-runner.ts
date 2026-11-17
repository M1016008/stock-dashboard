import fs from 'node:fs'
import path from 'node:path'
import {
  assertWeeklyBackupDynamicGate,
  assertWeeklyBackupPlanSha256,
  assertWeeklyBackupPreflight,
  buildWeeklyBackupCompleteManifest,
  type Market,
  type MarketVerification,
  type WeeklyBackupDynamicObservation,
  type WeeklyBackupObservation,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'
import {
  checkpointSnapshotClone,
  cloneReplicaSeed,
  fileSha256,
  publishVerifiedGeneration,
  runMonitoredSqliteRsync,
  verifyReplica,
  type RsyncProgress,
  type ReplicaVerification,
} from '@/lib/storage/sqlite-rsync-generation'
import { createLockedSqliteSnapshot, removeLockedSnapshot } from '@/lib/storage/locked-sqlite-snapshot'
import {
  withWeeklyWriterHold,
  type ApprovedWriterIdentity,
  type WriterHoldDriver,
} from '@/lib/storage/weekly-writer-hold'

export type WeeklyBackupRunnerPhase =
  | 'PREFLIGHT_PASSED'
  | 'SEEDS_CLONED'
  | 'SOURCE_SNAPSHOT_CREATED'
  | 'WRITERS_RESTORED'
  | 'VERIFICATION_STARTED'
  | 'VERIFICATION_PASSED'
  | 'GENERATION_PUBLISHED'

export type WeeklyBackupPostflight = {
  dailySchedulesUnchanged: boolean
  webHealthy: boolean
  analogHealthy: boolean
}

export type WeeklyBackupRunnerArguments = {
  plan: WeeklyBackupPlan
  expectedPlanSha256: string
  observation: WeeklyBackupObservation
  runbookPath: string
  approvedWriters: ApprovedWriterIdentity[]
  writerDriver: WriterHoldDriver
  assertRuntimeIdentity: () => void
  observeDynamicGate: () => Promise<WeeklyBackupDynamicObservation>
  observePostflight: () => Promise<WeeklyBackupPostflight>
  readDestinationFreeBytes?: () => number
  readSourceFreeBytes?: () => number
  onPhase?: (phase: WeeklyBackupRunnerPhase) => void
  onProgress?: (market: Market, progress: RsyncProgress) => void
  /** Check results and failure diagnostics, one JSON line each in the run log. */
  onEvent?: (event: Record<string, unknown>) => void
  operations?: {
    cloneReplicaSeed: typeof cloneReplicaSeed
    createLockedSqliteSnapshot: typeof createLockedSqliteSnapshot
    checkpointSnapshotClone: typeof checkpointSnapshotClone
    runMonitoredSqliteRsync: typeof runMonitoredSqliteRsync
    verifyReplica: (args: Parameters<typeof verifyReplica>[0]) => Promise<ReplicaVerification>
    publishVerifiedGeneration: typeof publishVerifiedGeneration
  }
}

type Acquisition = {
  sourceWalGrowthBytes: number
  candidatePhysicalGrowthBytes: number
}

type ImmutableFileSnapshot = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>

function assertRegularFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`REGULAR_FILE_REQUIRED:${filePath}`)
  return stat
}

function immutableFileSnapshot(filePath: string): ImmutableFileSnapshot {
  const { dev, ino, size, mtimeMs, ctimeMs } = assertRegularFile(filePath)
  return { dev, ino, size, mtimeMs, ctimeMs }
}

function assertImmutableFileSnapshot(filePath: string, expected: ImmutableFileSnapshot): void {
  if (JSON.stringify(immutableFileSnapshot(filePath)) !== JSON.stringify(expected)) {
    throw new Error(`PRIOR_GENERATION_FILE_CHANGED:${filePath}`)
  }
}

function optionalRegularFileSize(filePath: string): number {
  try {
    return assertRegularFile(filePath).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function freeBytes(mountPath: string): number {
  const stat = fs.statfsSync(mountPath, { bigint: true })
  const bytes = stat.bsize * stat.bavail
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DESTINATION_FREE_BYTES_UNSAFE')
  return Number(bytes)
}

function combinedWalBytes(plan: WeeklyBackupPlan): number {
  return (['JP', 'US'] as const)
    .reduce((total, market) => total + optionalRegularFileSize(`${plan.sourceDatabasePaths[market]}-wal`), 0)
}

function assertCombinedWalLimit(plan: WeeklyBackupPlan): void {
  if (combinedWalBytes(plan) > plan.maximumCombinedWalBytes) throw new Error('SOURCE_WAL_LIMIT_EXCEEDED')
}

function assertApprovedWriterSet(plan: WeeklyBackupPlan, approved: ApprovedWriterIdentity[]): void {
  const actual = [...new Set(approved.map((item) => item.label))].sort()
  const expected = [...plan.writerLabels].sort()
  if (actual.length !== approved.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('APPROVED_WRITER_IDENTITY_SET_MISMATCH')
  }
}

function assertStaticEvidence(args: WeeklyBackupRunnerArguments): void {
  args.assertRuntimeIdentity()
  if (fileSha256(args.runbookPath) !== args.plan.runbookSha256) throw new Error('RUNBOOK_SHA256_MISMATCH')
  if (fileSha256(args.plan.priorManifestPath) !== args.plan.priorManifestSha256) {
    throw new Error('PRIOR_GENERATION_MANIFEST_MISMATCH')
  }
  if (fileSha256(args.plan.sqliteBinaryPath) !== args.plan.sqliteBinarySha256
    || fileSha256(args.plan.sqliteRsyncBinaryPath) !== args.plan.sqliteRsyncBinarySha256) {
    throw new Error('SQLITE_TOOL_BINARY_SHA256_MISMATCH')
  }
  if (fileSha256(args.plan.cloneBinaryPath) !== args.plan.cloneBinarySha256) throw new Error('CLONE_BINARY_SHA256_MISMATCH')
}

export async function runWeeklyBackupGeneration(args: WeeklyBackupRunnerArguments): Promise<{
  generationRoot: string
  manifestPath: string
  manifestSha256: string
}> {
  const operations = args.operations ?? {
    cloneReplicaSeed,
    createLockedSqliteSnapshot,
    checkpointSnapshotClone,
    runMonitoredSqliteRsync,
    verifyReplica,
    publishVerifiedGeneration,
  }
  assertWeeklyBackupPlanSha256(args.plan, args.expectedPlanSha256)
  assertApprovedWriterSet(args.plan, args.approvedWriters)
  assertStaticEvidence(args)
  assertWeeklyBackupPreflight(args.plan, args.observation)

  const generationRoot = path.join(args.plan.destinationRoot, args.plan.runId)
  if (fs.existsSync(generationRoot)) throw new Error('RUN_ID_COLLISION')
  // The observation may predate this call by several slow probes; recheck the
  // approved start window against the current time before the first write.
  if (Date.now() >= Date.parse(args.plan.mustStartBefore)) throw new Error('START_WINDOW_CLOSED')
  args.onPhase?.('PREFLIGHT_PASSED')

  const markets = ['JP', 'US'] as const
  const candidatePaths = {
    JP: path.join(generationRoot, 'JP', 'stockboard.db'),
    US: path.join(generationRoot, 'US', 'stockboard-us.db'),
  }
  const restorePaths = {
    JP: path.join(generationRoot, 'restore-smoke', 'JP', 'stockboard.db'),
    US: path.join(generationRoot, 'restore-smoke', 'US', 'stockboard-us.db'),
  }
  const seedGrowth = { JP: 0, US: 0 }
  const priorSnapshots = Object.fromEntries(markets.map((market) => [
    market,
    immutableFileSnapshot(args.plan.priorDatabasePaths[market]),
  ])) as Record<Market, ImmutableFileSnapshot>
  const readDestinationFreeBytes = args.readDestinationFreeBytes
    ?? (() => freeBytes(args.plan.destinationMount))
  const initialDestinationFreeBytes = readDestinationFreeBytes()
  let priorFreeBytes = initialDestinationFreeBytes
  for (const market of markets) {
    args.assertRuntimeIdentity()
    operations.cloneReplicaSeed({
      priorGenerationRoot: path.dirname(args.plan.priorDatabasePaths[market]),
      priorDatabasePath: args.plan.priorDatabasePaths[market],
      candidateRoot: generationRoot,
      candidateDatabasePath: candidatePaths[market],
    })
    const afterClone = readDestinationFreeBytes()
    seedGrowth[market] = Math.max(0, priorFreeBytes - afterClone)
    priorFreeBytes = afterClone
    if (afterClone < args.plan.destinationReserveBytes) throw new Error('DESTINATION_RESERVE_BREACHED')
    if (Math.max(0, initialDestinationFreeBytes - afterClone) > args.plan.maximumCandidateGrowthBytes) {
      throw new Error('CANDIDATE_GROWTH_LIMIT_EXCEEDED')
    }
  }
  args.onPhase?.('SEEDS_CLONED')

  const verified = {} as Record<Market, MarketVerification>
  let holdDurationMs = -1
  let writerStatesRestored = false
  let verificationStarted = 0
  const verifiedFiles = markets.flatMap((market) => [candidatePaths[market], restorePaths[market]])
  const verifiedFileSnapshots: ImmutableFileSnapshot[] = []
  let verifiedFileState = ''
  const refreshedBeforeHold = await args.observeDynamicGate()
  assertWeeklyBackupDynamicGate(args.plan, refreshedBeforeHold)
  assertCombinedWalLimit(args.plan)

  const mustFinishBeforeMs = Date.parse(args.plan.mustFinishBefore)
  if (Date.now() + args.plan.maximumWriterHoldMs + args.plan.maximumVerificationMs
    > mustFinishBeforeMs) throw new Error('REMAINING_EXECUTION_WINDOW_TOO_SHORT')
  const stagingDirectory = path.join(args.plan.stagingRoot, args.plan.runId)
  if (fs.existsSync(stagingDirectory)) throw new Error('STAGING_DIRECTORY_COLLISION')
  const snapshotPaths = Object.fromEntries(markets.map((market) => [market,
    path.join(stagingDirectory, market, path.basename(args.plan.sourceDatabasePaths[market]))])) as Record<Market, string>
  // The clones share blocks with production until production rewrites them, and that volume
  // holds production, so its free space is watched until the clones are removed.
  const readSourceFreeBytes = args.readSourceFreeBytes ?? (() => freeBytes(args.plan.sourceMount))
  const assertSourceReserve = () => {
    if (readSourceFreeBytes() < args.plan.sourceReserveBytes) throw new Error('SOURCE_RESERVE_BREACHED')
  }
  const snapshotSources = markets.map((market) => ({ label: market, databasePath: args.plan.sourceDatabasePaths[market] }))
  let snapshotLockHeldMs = -1
  let keepSnapshotForDiagnosis = false
  try {
    const held = await withWeeklyWriterHold({
      approved: args.approvedWriters,
      maximumHoldMs: args.plan.maximumWriterHoldMs,
      driver: args.writerDriver,
      operation: async (assertHoldValid) => {
        const stoppedObservation = await args.observeDynamicGate()
        assertWeeklyBackupDynamicGate(args.plan, stoppedObservation)
        assertCombinedWalLimit(args.plan)
        assertSourceReserve()
        await assertHoldValid()
        args.assertRuntimeIdentity()
        // Recheck the helper right before it runs against production paths.
        if (fileSha256(args.plan.cloneBinaryPath) !== args.plan.cloneBinarySha256) throw new Error('CLONE_BINARY_SHA256_MISMATCH')
        const snapshot = await operations.createLockedSqliteSnapshot({
          sqliteBinary: args.plan.sqliteBinaryPath,
          cloneBinary: args.plan.cloneBinaryPath,
          sources: snapshotSources,
          stagingDirectory,
          lockWaitMs: Math.min(30_000, args.plan.maximumSnapshotLockMs),
          maximumLockMs: args.plan.maximumSnapshotLockMs,
        })
        snapshotLockHeldMs = snapshot.lockHeldMs
        // The WAL cap and the reserve were last checked before the lock; apply them to what was captured.
        const capturedWalBytes = snapshot.files.filter((file) => file.kind === 'wal').reduce((total, file) => total + file.bytes, 0)
        if (capturedWalBytes > args.plan.maximumCombinedWalBytes) throw new Error('SOURCE_WAL_LIMIT_EXCEEDED')
        assertSourceReserve()
        args.onPhase?.('SOURCE_SNAPSHOT_CREATED')
        await assertHoldValid()
      },
    })
    args.onPhase?.('WRITERS_RESTORED')
    // A hold that overran while writers were stopping or restarting can never publish.
    if (held.receipt.holdDurationMs > args.plan.maximumWriterHoldMs) throw new Error('WRITER_HOLD_LIMIT_EXCEEDED')

    // From here only the private clones are read; production is not touched again.
    const verificationStartedAt = Date.now()
    const verificationDeadlineMs = Math.min(verificationStartedAt + args.plan.maximumVerificationMs, mustFinishBeforeMs)
    const acquired = {} as Record<Market, Acquisition>
    for (const market of markets) {
      args.assertRuntimeIdentity()
      assertSourceReserve()
      await operations.checkpointSnapshotClone({
        sqliteBinary: args.plan.sqliteBinaryPath,
        snapshotRoot: stagingDirectory,
        databasePath: snapshotPaths[market],
        deadlineMs: verificationDeadlineMs,
        check: assertSourceReserve,
      })
      const snapshotStat = assertRegularFile(snapshotPaths[market])
      const destinationFreeBytesAtStart = readDestinationFreeBytes()
      const result = await operations.runMonitoredSqliteRsync({
        sqliteRsyncBinary: args.plan.sqliteRsyncBinaryPath,
        sourceDatabasePath: snapshotPaths[market],
        candidateDatabasePath: candidatePaths[market],
        assertRuntimeIdentity: args.assertRuntimeIdentity,
        readDestinationFreeBytes,
        monitorSourceWal: false,
        extraCheck: assertSourceReserve,
        limits: {
          deadlineMs: verificationDeadlineMs,
          destinationMount: args.plan.destinationMount,
          destinationReserveBytes: args.plan.destinationReserveBytes,
          destinationFreeBytesAtStart: initialDestinationFreeBytes,
          maximumCandidateGrowthBytes: args.plan.maximumCandidateGrowthBytes,
          sourceWalPath: `${snapshotPaths[market]}-wal`,
          sourceWalBytesAtStart: 0,
          maximumWalGrowthBytes: args.plan.maximumWalGrowthBytes,
          sourceDatabaseSizeAtStart: snapshotStat.size,
          sourceDatabaseMtimeMsAtStart: snapshotStat.mtimeMs,
        },
        onProgress: (progress) => args.onProgress?.(market, progress),
      })
      acquired[market] = {
        sourceWalGrowthBytes: result.sourceWalGrowthBytes,
        candidatePhysicalGrowthBytes: seedGrowth[market]
          + Math.max(0, destinationFreeBytesAtStart - readDestinationFreeBytes()),
      }
    }

    args.onPhase?.('VERIFICATION_STARTED')
    for (const market of markets) {
      args.assertRuntimeIdentity()
      const result = await operations.verifyReplica({
        sqliteBinary: args.plan.sqliteBinaryPath,
        candidateRoot: generationRoot,
        candidateDatabasePath: candidatePaths[market],
        restoreDatabasePath: restorePaths[market],
        snapshotDatabasePath: snapshotPaths[market],
        deadlineMs: verificationDeadlineMs,
        check: assertSourceReserve,
        report: (event) => args.onEvent?.({ market, ...event }),
      })
      // Taken right after this market's hashes, so a change during the other market's checks is caught.
      verifiedFileSnapshots.push(immutableFileSnapshot(candidatePaths[market]), immutableFileSnapshot(restorePaths[market]))
      verified[market] = { market, generationId: args.plan.runId, syncStatus: 'PASS', ...result, ...acquired[market] }
    }
    verifiedFileState = JSON.stringify(verifiedFileSnapshots)
    holdDurationMs = held.receipt.holdDurationMs
    writerStatesRestored = held.receipt.restored
    verificationStarted = verificationStartedAt
  } catch (error) {
    // A replica that differs from its snapshot needs both files to find out why, so this one failure
    // keeps the snapshot clones. They share blocks with production, which uses OWC space as production
    // rewrites them; the runbook's "Leftover snapshot" step removes them after the diagnosis.
    keepSnapshotForDiagnosis = error instanceof Error && error.message === 'REPLICA_DIFFERS_FROM_SNAPSHOT'
    throw error
  } finally {
    if (keepSnapshotForDiagnosis) args.onEvent?.({ snapshotKeptForDiagnosis: stagingDirectory })
    else removeLockedSnapshot(stagingDirectory, snapshotSources)
  }
  args.onPhase?.('VERIFICATION_PASSED')

  const postflight = await args.observePostflight()
  // Signals that arrived during synchronous verification are delivered while
  // postflight awaits; recheck the abort flag before publishing.
  args.assertRuntimeIdentity()
  if (Date.now() >= mustFinishBeforeMs) throw new Error('EXECUTION_DEADLINE_EXCEEDED')
  // Last checks before publishing (after every await): the prior generation, and the candidate and
  // restore files exactly as they were when their hashes were taken, with no WAL or journal beside them.
  for (const market of markets) {
    assertImmutableFileSnapshot(args.plan.priorDatabasePaths[market], priorSnapshots[market])
  }
  if (fileSha256(args.plan.priorManifestPath) !== args.plan.priorManifestSha256) {
    throw new Error('PRIOR_GENERATION_CHANGED')
  }
  // The restore clones are made after the per-market growth figures, so check the total once more.
  if (Math.max(0, initialDestinationFreeBytes - readDestinationFreeBytes()) > args.plan.maximumCandidateGrowthBytes) {
    throw new Error('CANDIDATE_GROWTH_LIMIT_EXCEEDED')
  }
  if (JSON.stringify(verifiedFiles.map(immutableFileSnapshot)) !== verifiedFileState
    || verifiedFiles.some((file) => ['-wal', '-journal'].some((suffix) => fs.existsSync(`${file}${suffix}`)
      && fs.lstatSync(`${file}${suffix}`).size > 0))) {
    throw new Error('CANDIDATE_CHANGED_AFTER_VERIFICATION')
  }
  const manifest = buildWeeklyBackupCompleteManifest(args.plan, {
    generationId: args.plan.runId,
    priorGenerationId: args.plan.priorGenerationId,
    priorGenerationStatus: args.plan.priorGenerationStatus,
    priorGenerationUnchanged: true,
    writerHoldDurationMs: holdDurationMs,
    snapshotLockHeldMs,
    verificationDurationMs: Date.now() - verificationStarted,
    destinationFreeBytesAfter: readDestinationFreeBytes(),
    completeManifestExists: fs.existsSync(path.join(generationRoot, 'COMPLETE.manifest.json')),
    candidateIsUniquePath: path.dirname(generationRoot) === path.resolve(args.plan.destinationRoot)
      && path.basename(generationRoot) === args.plan.runId,
    writerStatesRestored,
    dailySchedulesUnchanged: postflight.dailySchedulesUnchanged,
    webHealthyAfter: postflight.webHealthy,
    analogHealthyAfter: postflight.analogHealthy,
    jp: verified.JP,
    us: verified.US,
  }, new Date().toISOString())
  const published = operations.publishVerifiedGeneration({ generationRoot, manifest })
  args.onPhase?.('GENERATION_PUBLISHED')
  return { generationRoot, ...published }
}
