import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MINIMUM_DESTINATION_RESERVE_BYTES,
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_SCHEMA_VERSION,
  WEEKLY_BACKUP_WRITER_LABELS,
  buildWeeklyBackupCompleteManifest,
  type MarketVerification,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'
import {
  cloneReplicaSeed,
  publishVerifiedGeneration,
  runMonitoredSqliteRsync,
  verifyReplica,
} from '@/lib/storage/sqlite-rsync-generation'

const SQLITE = process.env.SQLITE3_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3'
const SQLITE_RSYNC = process.env.SQLITE3_RSYNC_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3_rsync'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-weekly-generation-'))

function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  return result.stdout.trim()
}

function marketVerification(market: 'JP' | 'US', generationId: string,
  verified: ReturnType<typeof verifyReplica>): MarketVerification {
  return {
    market,
    generationId,
    syncStatus: 'PASS',
    ...verified,
    sourceWalGrowthBytes: 0,
    candidatePhysicalGrowthBytes: fs.statSync(path.join(root, 'candidate', `${market.toLowerCase()}-candidate.db`)).size,
  }
}

async function main(): Promise<void> {
try {
  for (const executable of [SQLITE, SQLITE_RSYNC]) assert.equal(fs.statSync(executable).isFile(), true)
  const sourceRoot = path.join(root, 'source')
  const candidateRoot = path.join(root, 'candidate')
  const priorRoot = path.join(candidateRoot, 'prior')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(candidateRoot)
  fs.mkdirSync(priorRoot)
  const generationId = 'fixture-generation-v2'
  const verified = {} as Record<'JP' | 'US', MarketVerification>

  for (const market of ['JP', 'US'] as const) {
    const origin = path.join(sourceRoot, `${market.toLowerCase()}-origin.db`)
    const prior = path.join(priorRoot, `${market.toLowerCase()}.db`)
    const candidate = path.join(candidateRoot, `${market.toLowerCase()}-candidate.db`)
    const restore = path.join(candidateRoot, `${market.toLowerCase()}-restore.db`)
    command(SQLITE, [origin, `
      PRAGMA journal_mode=WAL;
      CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO fixture(value) VALUES('prior');
    `])
    fs.copyFileSync(origin, prior)
    command(SQLITE, [origin, `INSERT INTO fixture(value) VALUES('${market}-new');`])
    cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: prior,
      candidateRoot, candidateDatabasePath: candidate })
    const walPath = `${origin}-wal`
    const walAtStart = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
    const sourceStat = fs.statSync(origin)
    const destinationStat = fs.statfsSync(os.tmpdir(), { bigint: true })
    const destinationFreeBytesAtStart = Number(destinationStat.bsize * destinationStat.bavail)
    await runMonitoredSqliteRsync({
      sqliteRsyncBinary: SQLITE_RSYNC,
      sourceDatabasePath: origin,
      candidateDatabasePath: candidate,
      assertRuntimeIdentity: () => undefined,
      limits: {
        deadlineMs: Date.now() + 60_000,
        destinationMount: os.tmpdir(),
        destinationReserveBytes: 0,
        destinationFreeBytesAtStart,
        maximumCandidateGrowthBytes: 1_000_000_000,
        sourceWalPath: walPath,
        sourceWalBytesAtStart: walAtStart,
        maximumWalGrowthBytes: 0,
        sourceDatabaseSizeAtStart: sourceStat.size,
        sourceDatabaseMtimeMsAtStart: sourceStat.mtimeMs,
      },
    })
    assert.equal(command(SQLITE, ['-readonly', candidate, 'SELECT COUNT(*) FROM fixture;']), '2')
    verified[market] = marketVerification(market, generationId, verifyReplica({
      sqliteBinary: SQLITE,
      candidateRoot,
      candidateDatabasePath: candidate,
      restoreDatabasePath: restore,
      deadlineMs: Date.now() + 60_000,
    }))
  }

  const capacityOrigin = path.join(sourceRoot, 'jp-origin.db')
  const capacityCandidate = path.join(candidateRoot, 'capacity-abort.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: capacityCandidate })
  const capacitySourceStat = fs.statSync(capacityOrigin)
  const tmpStat = fs.statfsSync(os.tmpdir(), { bigint: true })
  const tmpFree = Number(tmpStat.bsize * tmpStat.bavail)
  await assert.rejects(() => runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC,
    sourceDatabasePath: capacityOrigin,
    candidateDatabasePath: capacityCandidate,
    assertRuntimeIdentity: () => undefined,
    readDestinationFreeBytes: () => tmpFree,
    limits: {
      deadlineMs: Date.now() + 60_000,
      destinationMount: os.tmpdir(),
      destinationReserveBytes: 0,
      destinationFreeBytesAtStart: tmpFree + 1,
      maximumCandidateGrowthBytes: 0,
      sourceWalPath: `${capacityOrigin}-wal`,
      sourceWalBytesAtStart: 0,
      maximumWalGrowthBytes: 0,
      sourceDatabaseSizeAtStart: capacitySourceStat.size,
      sourceDatabaseMtimeMsAtStart: capacitySourceStat.mtimeMs,
    },
  }), /CANDIDATE_GROWTH_LIMIT_EXCEEDED/)

  const identityCandidate = path.join(candidateRoot, 'identity-abort.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: identityCandidate })
  let identityChecks = 0
  await assert.rejects(() => runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC,
    sourceDatabasePath: capacityOrigin,
    candidateDatabasePath: identityCandidate,
    assertRuntimeIdentity: () => {
      identityChecks += 1
      if (identityChecks > 1) throw new Error('RUNTIME_DEVICE_IDENTITY_CHANGED')
    },
    limits: {
      deadlineMs: Date.now() + 60_000,
      destinationMount: os.tmpdir(),
      destinationReserveBytes: 0,
      destinationFreeBytesAtStart: tmpFree,
      maximumCandidateGrowthBytes: 1_000_000_000,
      sourceWalPath: `${capacityOrigin}-wal`,
      sourceWalBytesAtStart: 0,
      maximumWalGrowthBytes: 0,
      sourceDatabaseSizeAtStart: capacitySourceStat.size,
      sourceDatabaseMtimeMsAtStart: capacitySourceStat.mtimeMs,
    },
  }), /RUNTIME_DEVICE_IDENTITY_CHANGED/)
  assert.ok(identityChecks > 1)

  assert.throws(() => verifyReplica({
    sqliteBinary: SQLITE,
    candidateRoot,
    candidateDatabasePath: path.join(candidateRoot, 'jp-candidate.db'),
    restoreDatabasePath: path.join(candidateRoot, 'expired-restore.db'),
    deadlineMs: Date.now() - 1,
  }), /VERIFICATION_DEADLINE_EXCEEDED/)

  const plan: WeeklyBackupPlan = {
    schemaVersion: WEEKLY_BACKUP_SCHEMA_VERSION,
    runId: 'weekly-generation-fixture-v1',
    oneShot: true,
    startsAt: '2026-10-25T02:00:00+09:00',
    mustStartBefore: '2026-10-25T02:15:00+09:00',
    mustFinishBefore: '2026-10-27T03:00:00+09:00',
    destinationReserveBytes: MINIMUM_DESTINATION_RESERVE_BYTES,
    maximumCandidateGrowthBytes: 1_000_000_000,
    maximumCombinedWalBytes: 1_000_000_000,
    maximumWalGrowthBytes: 0,
    maximumWriterHoldMs: 8 * 60 * 60 * 1_000,
    maximumVerificationMs: 40 * 60 * 60 * 1_000,
    sourceMount: sourceRoot,
    destinationMount: candidateRoot,
    sourcePhysicalSerial: 'fixture-source-serial',
    destinationPhysicalSerial: 'fixture-destination-serial',
    sourceVolumeUuid: 'fixture-source',
    destinationVolumeUuid: 'fixture-destination',
    sourceDatabasePaths: {
      JP: path.join(sourceRoot, 'jp-origin.db'),
      US: path.join(sourceRoot, 'us-origin.db'),
    },
    priorDatabasePaths: {
      JP: path.join(priorRoot, 'jp.db'),
      US: path.join(priorRoot, 'us.db'),
    },
    destinationRoot: candidateRoot,
    priorGenerationId: 'fixture-prior-limited',
    priorGenerationStatus: 'ACQUIRED_WITH_LIMITATIONS',
    writerLabels: [...WEEKLY_BACKUP_WRITER_LABELS],
    readerLabelsKeptOnline: [...WEEKLY_BACKUP_READER_LABELS],
    runbookSha256: 'c'.repeat(64),
    priorManifestPath: path.join(candidateRoot, 'BACKUP_ACQUIRED_WITH_LIMITATIONS.manifest.json'),
    priorManifestSha256: 'd'.repeat(64),
    sqliteVersion: '3.54.1',
    sqliteBinaryPath: SQLITE,
    sqliteBinarySha256: 'e'.repeat(64),
    sqliteRsyncBinaryPath: SQLITE_RSYNC,
    sqliteRsyncBinarySha256: 'f'.repeat(64),
    sqliteToolsArchiveSha3: 'a3106c6db3b50ec9ef4fde4edfafe7504179e9bfd7e0816a280b29c4d56a2e7b',
  }
  const manifest = buildWeeklyBackupCompleteManifest(plan, {
    generationId,
    priorGenerationId: plan.priorGenerationId,
    priorGenerationStatus: plan.priorGenerationStatus,
    priorGenerationUnchanged: true,
    writerHoldDurationMs: 1_000,
    verificationDurationMs: 2_000,
    destinationFreeBytesAfter: 900_000_000_000,
    completeManifestExists: false,
    candidateIsUniquePath: true,
    writerStatesRestored: true,
    dailySchedulesUnchanged: true,
    webHealthyAfter: true,
    analogHealthyAfter: true,
    jp: verified.JP,
    us: verified.US,
  }, '2026-10-25T03:00:00+09:00')
  const published = publishVerifiedGeneration({ generationRoot: candidateRoot, manifest })
  assert.equal(JSON.parse(fs.readFileSync(published.manifestPath, 'utf8')).status, 'VERIFIED')
  assert.match(published.manifestSha256, /^[a-f0-9]{64}$/)
  assert.throws(() => publishVerifiedGeneration({ generationRoot: candidateRoot, manifest }),
    /COMPLETE_MANIFEST_COLLISION/)

  console.log(JSON.stringify({ verdict: 'PASS', productionDatabaseOpened: false,
    destinationBackupWritten: false, markets: ['JP', 'US'], publishedAtomically: true,
    candidateGrowthFailClosed: true, runtimeIdentityFailClosed: true,
    verificationDeadlineFailClosed: true }, null, 2))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
