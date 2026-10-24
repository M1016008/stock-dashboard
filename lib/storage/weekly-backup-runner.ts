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
  cloneReplicaSeed,
  fileSha256,
  publishVerifiedGeneration,
  runMonitoredSqliteRsync,
  verifyReplica,
  type RsyncProgress,
  type ReplicaVerification,
} from '@/lib/storage/sqlite-rsync-generation'
import {
  withWeeklyWriterHold,
  type ApprovedWriterIdentity,
  type WriterHoldDriver,
} from '@/lib/storage/weekly-writer-hold'

export type WeeklyBackupRunnerPhase =
  | 'PREFLIGHT_PASSED'
  | 'SEEDS_CLONED'
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
  onPhase?: (phase: WeeklyBackupRunnerPhase) => void
  onProgress?: (market: Market, progress: RsyncProgress) => void
  operations?: {
    cloneReplicaSeed: typeof cloneReplicaSeed
    runMonitoredSqliteRsync: typeof runMonitoredSqliteRsync
    verifyReplica: (args: Parameters<typeof verifyReplica>[0]) => ReplicaVerification
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
}

export async function runWeeklyBackupGeneration(args: WeeklyBackupRunnerArguments): Promise<{
  generationRoot: string
  manifestPath: string
  manifestSha256: string
}> {
  const operations = args.operations ?? {
    cloneReplicaSeed,
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

  const refreshedBeforeHold = await args.observeDynamicGate()
  assertWeeklyBackupDynamicGate(args.plan, refreshedBeforeHold)
  assertCombinedWalLimit(args.plan)

  const mustFinishBeforeMs = Date.parse(args.plan.mustFinishBefore)
  if (Date.now() + args.plan.maximumWriterHoldMs + args.plan.maximumVerificationMs
    > mustFinishBeforeMs) throw new Error('REMAINING_EXECUTION_WINDOW_TOO_SHORT')
  const holdDeadlineMs = Math.min(
    Date.now() + args.plan.maximumWriterHoldMs,
    mustFinishBeforeMs - args.plan.maximumVerificationMs,
  )
  const held = await withWeeklyWriterHold({
    approved: args.approvedWriters,
    maximumHoldMs: args.plan.maximumWriterHoldMs,
    driver: args.writerDriver,
    operation: async (assertHoldValid) => {
      const stoppedObservation = await args.observeDynamicGate()
      assertWeeklyBackupDynamicGate(args.plan, stoppedObservation)
      assertCombinedWalLimit(args.plan)
      const acquired = {} as Record<Market, Acquisition>
      for (const market of markets) {
        await assertHoldValid()
        args.assertRuntimeIdentity()
        assertCombinedWalLimit(args.plan)
        const sourcePath = args.plan.sourceDatabasePaths[market]
        const sourceStat = assertRegularFile(sourcePath)
        const sourceWalPath = `${sourcePath}-wal`
        const sourceWalBytesAtStart = optionalRegularFileSize(sourceWalPath)
        const destinationFreeBytesAtStart = readDestinationFreeBytes()
        const result = await operations.runMonitoredSqliteRsync({
          sqliteRsyncBinary: args.plan.sqliteRsyncBinaryPath,
          sourceDatabasePath: sourcePath,
          candidateDatabasePath: candidatePaths[market],
          assertRuntimeIdentity: args.assertRuntimeIdentity,
          readDestinationFreeBytes,
          limits: {
            deadlineMs: holdDeadlineMs,
            destinationMount: args.plan.destinationMount,
            destinationReserveBytes: args.plan.destinationReserveBytes,
            destinationFreeBytesAtStart: initialDestinationFreeBytes,
            maximumCandidateGrowthBytes: args.plan.maximumCandidateGrowthBytes,
            sourceWalPath,
            sourceWalBytesAtStart,
            maximumWalGrowthBytes: args.plan.maximumWalGrowthBytes,
            sourceDatabaseSizeAtStart: sourceStat.size,
            sourceDatabaseMtimeMsAtStart: sourceStat.mtimeMs,
          },
          onProgress: (progress) => args.onProgress?.(market, progress),
        })
        const afterSync = readDestinationFreeBytes()
        acquired[market] = {
          sourceWalGrowthBytes: result.sourceWalGrowthBytes,
          candidatePhysicalGrowthBytes: seedGrowth[market]
            + Math.max(0, destinationFreeBytesAtStart - afterSync),
        }
        await assertHoldValid()
      }
      return acquired
    },
  })
  args.onPhase?.('WRITERS_RESTORED')

  const verificationStartedAt = Date.now()
  const verificationDeadlineMs = Math.min(
    verificationStartedAt + args.plan.maximumVerificationMs,
    mustFinishBeforeMs,
  )
  args.onPhase?.('VERIFICATION_STARTED')
  const verified = {} as Record<Market, MarketVerification>
  for (const market of markets) {
    args.assertRuntimeIdentity()
    const result = operations.verifyReplica({
      sqliteBinary: args.plan.sqliteBinaryPath,
      candidateRoot: generationRoot,
      candidateDatabasePath: candidatePaths[market],
      restoreDatabasePath: restorePaths[market],
      deadlineMs: verificationDeadlineMs,
    })
    verified[market] = {
      market,
      generationId: args.plan.runId,
      syncStatus: 'PASS',
      ...result,
      ...held.result[market],
    }
  }
  args.onPhase?.('VERIFICATION_PASSED')

  args.assertRuntimeIdentity()
  for (const market of markets) {
    assertImmutableFileSnapshot(args.plan.priorDatabasePaths[market], priorSnapshots[market])
  }
  if (fileSha256(args.plan.priorManifestPath) !== args.plan.priorManifestSha256) {
    throw new Error('PRIOR_GENERATION_CHANGED')
  }
  const postflight = await args.observePostflight()
  if (Date.now() >= mustFinishBeforeMs) throw new Error('EXECUTION_DEADLINE_EXCEEDED')
  const manifest = buildWeeklyBackupCompleteManifest(args.plan, {
    generationId: args.plan.runId,
    priorGenerationId: args.plan.priorGenerationId,
    priorGenerationStatus: args.plan.priorGenerationStatus,
    priorGenerationUnchanged: true,
    writerHoldDurationMs: held.receipt.holdDurationMs,
    verificationDurationMs: Date.now() - verificationStartedAt,
    destinationFreeBytesAfter: readDestinationFreeBytes(),
    completeManifestExists: fs.existsSync(path.join(generationRoot, 'COMPLETE.manifest.json')),
    candidateIsUniquePath: path.dirname(generationRoot) === path.resolve(args.plan.destinationRoot)
      && path.basename(generationRoot) === args.plan.runId,
    writerStatesRestored: held.receipt.restored,
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
