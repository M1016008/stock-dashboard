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
  WEEKLY_INTEGRITY_CHECK,
  buildWeeklyBackupCompleteManifest,
  type MarketVerification,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'
import {
  checkpointSnapshotClone,
  cloneReplicaSeed,
  describeFileDifference,
  fileDigests,
  runMonitoredCommand,
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
  verified: Awaited<ReturnType<typeof verifyReplica>>): MarketVerification {
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
    // 2026-11-15: the real JP prior is read-only (0400) and cp -c keeps the mode, so the replica could not be written.
    if (market === 'JP') fs.chmodSync(prior, 0o400)
    command(SQLITE, [origin, `INSERT INTO fixture(value) VALUES('${market}-new');`])
    const priorModeBefore = fs.statSync(prior).mode & 0o777
    const priorBytesBefore = fs.readFileSync(prior)
    cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: prior,
      candidateRoot, candidateDatabasePath: candidate })
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o600)
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
    assert.equal(fs.statSync(prior).mode & 0o777, priorModeBefore)
    assert.equal(fs.readFileSync(prior).equals(priorBytesBefore), true)
    // The origin closed cleanly (no WAL), so it stands in for the checkpointed snapshot clone.
    verified[market] = marketVerification(market, generationId, await verifyReplica({
      sqliteBinary: SQLITE,
      candidateRoot,
      candidateDatabasePath: candidate,
      restoreDatabasePath: restore,
      snapshotDatabasePath: origin,
      deadlineMs: Date.now() + 60_000,
    }))
    assert.equal(verified[market].snapshotContentSha256, verified[market].contentSha256)
  }

  // A snapshot clone with a WAL: the checkpoint folds it into the clone only, then the sync from it
  // (sqlite3_rsync as its only user creates and removes the WAL) passes with WAL monitoring off.
  const snapshotRoot = path.join(sourceRoot, 'snapshot')
  fs.mkdirSync(snapshotRoot)
  const snapshotClone = path.join(snapshotRoot, 'jp.db')
  const walWriter = spawnSync(SQLITE, [snapshotClone], { encoding: 'utf8', input: '.dbconfig no_ckpt_on_close on\n'
    + 'PRAGMA journal_mode=WAL;\nCREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT);\n'
    + "INSERT INTO fixture(value) VALUES('a'),('b'),('c');\n" })
  assert.equal(walWriter.status, 0, walWriter.stderr)
  assert.ok(fs.statSync(`${snapshotClone}-wal`).size > 0)
  await checkpointSnapshotClone({ sqliteBinary: SQLITE, snapshotRoot, databasePath: snapshotClone,
    deadlineMs: Date.now() + 60_000 })
  assert.equal(fs.existsSync(`${snapshotClone}-wal`) && fs.statSync(`${snapshotClone}-wal`).size > 0, false)
  await assert.rejects(() => checkpointSnapshotClone({ sqliteBinary: SQLITE, snapshotRoot,
    databasePath: path.join(sourceRoot, 'jp-origin.db'), deadlineMs: Date.now() + 60_000 }), /PATH_OUTSIDE_APPROVED_ROOT/)
  const fromSnapshot = path.join(candidateRoot, 'from-snapshot.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: fromSnapshot })
  const snapshotStat = fs.statSync(snapshotClone)
  const freeNow = Number(fs.statfsSync(os.tmpdir(), { bigint: true }).bavail * fs.statfsSync(os.tmpdir(), { bigint: true }).bsize)
  let reserveChecks = 0
  await runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC, sourceDatabasePath: snapshotClone, candidateDatabasePath: fromSnapshot,
    assertRuntimeIdentity: () => undefined, monitorSourceWal: false, extraCheck: () => { reserveChecks += 1 },
    limits: { deadlineMs: Date.now() + 60_000, destinationMount: os.tmpdir(), destinationReserveBytes: 0,
      destinationFreeBytesAtStart: freeNow, maximumCandidateGrowthBytes: 1_000_000_000,
      sourceWalPath: `${snapshotClone}-wal`, sourceWalBytesAtStart: 0, maximumWalGrowthBytes: 0,
      sourceDatabaseSizeAtStart: snapshotStat.size, sourceDatabaseMtimeMsAtStart: snapshotStat.mtimeMs },
  })
  assert.equal(command(SQLITE, ['-readonly', fromSnapshot, 'SELECT count(*) FROM fixture;']), '3')
  // The source-volume reserve check stops a sync too.
  const reserveCandidate = path.join(candidateRoot, 'reserve-abort.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: reserveCandidate })
  await assert.rejects(() => runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC, sourceDatabasePath: snapshotClone, candidateDatabasePath: reserveCandidate,
    assertRuntimeIdentity: () => undefined, monitorSourceWal: false,
    extraCheck: () => { throw new Error('SOURCE_RESERVE_BREACHED') },
    limits: { deadlineMs: Date.now() + 60_000, destinationMount: os.tmpdir(), destinationReserveBytes: 0,
      destinationFreeBytesAtStart: freeNow, maximumCandidateGrowthBytes: 1_000_000_000,
      sourceWalPath: `${snapshotClone}-wal`, sourceWalBytesAtStart: 0, maximumWalGrowthBytes: 0,
      sourceDatabaseSizeAtStart: snapshotStat.size, sourceDatabaseMtimeMsAtStart: snapshotStat.mtimeMs },
  }), /SOURCE_RESERVE_BREACHED/)
  // A monitored command that ignores SIGTERM is killed, so a stopped check never hangs the run.
  const stubbornStarted = Date.now()
  await assert.rejects(() => runMonitoredCommand('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], {
    deadlineMs: Date.now() + 60_000, check: () => { throw new Error('SOURCE_RESERVE_BREACHED') } }), /SOURCE_RESERVE_BREACHED/)
  assert.ok(Date.now() - stubbornStarted < 15_000)

  // The content digest ignores only the header fields sqlite3_rsync rewrites (bytes 24-27, 92-99).
  const digestBase = path.join(root, 'digest-base.bin')
  fs.writeFileSync(digestBase, Buffer.alloc(9 * 1024 * 1024, 7))
  const flipped = (name: string, offset: number) => {
    const file = path.join(root, name)
    const bytes = fs.readFileSync(digestBase)
    bytes[offset] ^= 0xff
    fs.writeFileSync(file, bytes)
    return fileDigests(file)
  }
  const baseDigest = fileDigests(digestBase)
  for (const offset of [24, 27, 92, 95, 96, 99]) {
    const digest = flipped(`counter-${offset}.bin`, offset)
    assert.equal(digest.sqliteContentSha256, baseDigest.sqliteContentSha256)
    assert.notEqual(digest.sha256, baseDigest.sha256)
  }
  for (const offset of [0, 23, 28, 91, 100, 8 * 1024 * 1024 + 24]) {
    assert.notEqual(flipped(`content-${offset}.bin`, offset).sqliteContentSha256, baseDigest.sqliteContentSha256)
  }
  // Where two files differ: header bytes always listed, masked fields never counted as a difference.
  assert.deepEqual(describeFileDifference(digestBase, path.join(root, 'counter-96.bin')),
    { leftBytes: 9 * 1024 * 1024, rightBytes: 9 * 1024 * 1024, headerOffsets: [96], firstOffsets: [], differingBlocks: 0, complete: true })
  assert.deepEqual(describeFileDifference(digestBase, path.join(root, `content-${8 * 1024 * 1024 + 24}.bin`)),
    { leftBytes: 9 * 1024 * 1024, rightBytes: 9 * 1024 * 1024, headerOffsets: [], firstOffsets: [8 * 1024 * 1024 + 24], differingBlocks: 1, complete: true })

  // A replica whose bytes differ from the checked snapshot is never verified, and the log says where they differ.
  const differsReports: Record<string, unknown>[] = []
  await assert.rejects(() => verifyReplica({ sqliteBinary: SQLITE, candidateRoot,
    candidateDatabasePath: path.join(candidateRoot, 'jp-candidate.db'),
    restoreDatabasePath: path.join(candidateRoot, 'differs-restore.db'),
    snapshotDatabasePath: snapshotClone, deadlineMs: Date.now() + 60_000,
    report: (event) => differsReports.push(event) }), /REPLICA_DIFFERS_FROM_SNAPSHOT/)
  assert.deepEqual(differsReports[0], { check: 'quick_check', result: 'ok' })
  const differs = differsReports[1].replicaDiffers as ReturnType<typeof describeFileDifference>
  assert.ok(differs.complete && differs.differingBlocks > 0 && differs.firstOffsets.length > 0)

  // 2026-11-17: production writes with another SQLite (libsql 3.45.1), and sqlite3_rsync (3.54.1) stamps its
  // own version number into the replica header (bytes 96-99). Such a replica is still the snapshot's copy.
  // node:sqlite (bundled SQLite 3.50.x) stands in for production's libsql; the installed @types/node predates it.
  type SyncDatabase = { exec(sql: string): void; prepare(sql: string): { get(): unknown }; close(): void }
  const nodeSqlite = 'node:sqlite'
  const { DatabaseSync } = (await import(nodeSqlite)) as { DatabaseSync: new (file: string) => SyncDatabase }
  const otherOrigin = path.join(sourceRoot, 'other-library.db')
  const otherWriter = new DatabaseSync(otherOrigin)
  assert.notEqual((otherWriter.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    command(SQLITE, [':memory:', 'SELECT sqlite_version();']))
  otherWriter.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture(value) VALUES('a');")
  otherWriter.close()
  const otherPrior = path.join(priorRoot, 'other-library.db')
  fs.copyFileSync(otherOrigin, otherPrior)
  const laterWriter = new DatabaseSync(otherOrigin)
  laterWriter.exec("INSERT INTO fixture(value) VALUES('b');")
  laterWriter.close()
  const otherCandidate = path.join(candidateRoot, 'other-library-candidate.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: otherPrior, candidateRoot, candidateDatabasePath: otherCandidate })
  command(SQLITE_RSYNC, ['--wal-only', otherOrigin, otherCandidate])
  assert.notDeepEqual(fs.readFileSync(otherOrigin).subarray(96, 100), fs.readFileSync(otherCandidate).subarray(96, 100))
  const otherReports: Record<string, unknown>[] = []
  const otherVerified = await verifyReplica({ sqliteBinary: SQLITE, candidateRoot, candidateDatabasePath: otherCandidate,
    restoreDatabasePath: path.join(candidateRoot, 'other-library-restore.db'), snapshotDatabasePath: otherOrigin,
    deadlineMs: Date.now() + 60_000, report: (event) => otherReports.push(event) })
  assert.notEqual(fileDigests(otherOrigin).sha256, otherVerified.databaseSha256)
  assert.equal(otherVerified.snapshotContentSha256, otherVerified.contentSha256)
  assert.equal(otherVerified.integrityCheck, WEEKLY_INTEGRITY_CHECK)
  assert.deepEqual(otherReports, [{ check: 'quick_check', result: 'ok' }])
  assert.ok(reserveChecks > 0)

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

  // A source write seen during or right after the sync fails the run instead of publishing.
  const changedCandidate = path.join(candidateRoot, 'source-changed.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: changedCandidate })
  await assert.rejects(() => runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC,
    sourceDatabasePath: capacityOrigin,
    candidateDatabasePath: changedCandidate,
    assertRuntimeIdentity: () => undefined,
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
      sourceDatabaseMtimeMsAtStart: capacitySourceStat.mtimeMs - 1,
    },
  }), /SOURCE_DATABASE_CHANGED_DURING_SYNC/)

  // A WAL rewrite at the same length (only its mtime moves) also fails the run.
  const walProbe = path.join(sourceRoot, 'same-length.wal')
  fs.writeFileSync(walProbe, '')
  fs.utimesSync(walProbe, new Date(0), new Date(0))
  const walCandidate = path.join(candidateRoot, 'wal-changed.db')
  cloneReplicaSeed({ priorGenerationRoot: priorRoot, priorDatabasePath: path.join(priorRoot, 'jp.db'),
    candidateRoot, candidateDatabasePath: walCandidate })
  let walIdentityChecks = 0
  await assert.rejects(() => runMonitoredSqliteRsync({
    sqliteRsyncBinary: SQLITE_RSYNC,
    sourceDatabasePath: capacityOrigin,
    candidateDatabasePath: walCandidate,
    assertRuntimeIdentity: () => {
      walIdentityChecks += 1
      if (walIdentityChecks === 2) fs.utimesSync(walProbe, new Date(), new Date())
    },
    limits: {
      deadlineMs: Date.now() + 60_000,
      destinationMount: os.tmpdir(),
      destinationReserveBytes: 0,
      destinationFreeBytesAtStart: tmpFree,
      maximumCandidateGrowthBytes: 1_000_000_000,
      sourceWalPath: walProbe,
      sourceWalBytesAtStart: 0,
      maximumWalGrowthBytes: 0,
      sourceDatabaseSizeAtStart: capacitySourceStat.size,
      sourceDatabaseMtimeMsAtStart: capacitySourceStat.mtimeMs,
    },
  }), /SOURCE_WAL_CHANGED_DURING_SYNC/)

  await assert.rejects(() => verifyReplica({
    sqliteBinary: SQLITE,
    candidateRoot,
    candidateDatabasePath: path.join(candidateRoot, 'jp-candidate.db'),
    restoreDatabasePath: path.join(candidateRoot, 'expired-restore.db'),
    snapshotDatabasePath: path.join(sourceRoot, 'jp-origin.db'),
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
    stagingRoot: path.join(sourceRoot, 'staging'),
    cloneBinaryPath: path.join(root, 'apfs-clone-file'),
    cloneBinarySha256: '1'.repeat(64),
    sourceReserveBytes: 300_000_000_000,
    maximumSnapshotLockMs: 60_000,
  }
  const manifest = buildWeeklyBackupCompleteManifest(plan, {
    generationId,
    priorGenerationId: plan.priorGenerationId,
    priorGenerationStatus: plan.priorGenerationStatus,
    priorGenerationUnchanged: true,
    writerHoldDurationMs: 1_000,
    snapshotLockHeldMs: 500,
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
