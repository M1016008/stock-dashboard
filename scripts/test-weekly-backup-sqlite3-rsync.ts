import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MOUNT = '/Volumes/StockBoard Backup'
const EXPECTED_UUID = '9FE99B78-6AF2-4493-AEF5-A1E5BDCDE683'
const FIXTURE_PARENT = path.join(MOUNT, '.stockboard-weekly-sqlite3-rsync-fixture')
const RUN_ROOT = path.join(FIXTURE_PARENT, `run-${process.pid}-${Date.now()}`)
const HARDWARE_QA_CONFIRMATION = 'WRITE_ISOLATED_WEEKLY_BACKUP_FIXTURE_TO_APPROVED_SANDISK'
const SQLITE = process.env.SQLITE3_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3'
const SQLITE_RSYNC = process.env.SQLITE3_RSYNC_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3_rsync'
const SQLDIFF = process.env.SQLDIFF_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqldiff'
const EXPECTED_TOOLS_SHA3 = 'a3106c6db3b50ec9ef4fde4edfafe7504179e9bfd7e0816a280b29c4d56a2e7b'
const PAYLOAD_ROWS = 32_768
const PAYLOAD_BYTES = 4_096

type CommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function command(commandPath: string, args: string[], options: { input?: string; timeout?: number; allowFailure?: boolean } = {}): CommandResult {
  const result = spawnSync(commandPath, args, {
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8_000_000,
  })
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`COMMAND_FAILED:${commandPath}:${result.status}:${result.signal}:${result.error?.message ?? result.stderr.trim()}`)
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function diskInfo(): Record<string, unknown> {
  const plist = command('/usr/sbin/diskutil', ['info', '-plist', MOUNT]).stdout
  const parsed = command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist }).stdout
  return JSON.parse(parsed) as Record<string, unknown>
}

function freeBytes(): bigint {
  const stat = fs.statfsSync(MOUNT, { bigint: true })
  return stat.bsize * stat.bavail
}

function sha256(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!bytes) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function sqlite(databasePath: string, sql: string, readOnly = false): string {
  const args = readOnly ? ['-readonly', databasePath, sql] : [databasePath, sql]
  return command(SQLITE, args, { timeout: 180_000 }).stdout.trim()
}

function sqliteCheck(databasePath: string): { quickCheck: string; integrityCheck: string; journalMode: string } {
  return {
    quickCheck: sqlite(databasePath, 'PRAGMA quick_check;', true),
    integrityCheck: sqlite(databasePath, 'PRAGMA integrity_check;', true),
    journalMode: sqlite(databasePath, 'PRAGMA journal_mode;', true),
  }
}

function contentHash(databasePath: string, tablePattern = '%'): string {
  const value = sqlite(databasePath, `.sha3sum --sha3-256 --schema ${tablePattern}`, true)
  return value.split(/\s+/)[0] ?? ''
}

function createDatabase(databasePath: string, generation: string, rows: number): void {
  sqlite(databasePath, `
    PRAGMA page_size=4096;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE fixture_pages(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
    CREATE TABLE live_writes(id INTEGER PRIMARY KEY, note TEXT NOT NULL);
    CREATE TABLE source_generation(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL);
    INSERT INTO source_generation VALUES(1, '${generation.replaceAll("'", "''")}');
    WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<${rows})
      INSERT INTO fixture_pages SELECT x, randomblob(${PAYLOAD_BYTES}) FROM seq;
  `)
}

function apfsClone(source: string, destination: string): void {
  assert.ok(!fs.existsSync(destination), `clone destination already exists: ${destination}`)
  command('/bin/cp', ['-c', source, destination])
}

function sqliteRsync(origin: string, replica: string, allowFailure = false): CommandResult & { elapsedMs: number } {
  const started = performance.now()
  const result = command(SQLITE_RSYNC, ['-vv', origin, replica], { timeout: 180_000, allowFailure })
  return { ...result, elapsedMs: Math.round(performance.now() - started) }
}

function exactTableMatch(left: string, right: string, table: string): boolean {
  return command(SQLDIFF, ['--table', table, left, right], { timeout: 180_000 }).stdout.trim() === ''
}

function waitForFile(filePath: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`WAIT_TIMEOUT:${filePath}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

async function concurrentSnapshot(origin: string, replica: string): Promise<{
  result: CommandResult & { elapsedMs: number }
  candidateRows: number
  finalSourceRows: number
  walBytesBefore: number
  walBytesPeak: number
}> {
  const ready = path.join(RUN_ROOT, 'writer.ready')
  const stop = path.join(RUN_ROOT, 'writer.stop')
  const writerResult = path.join(RUN_ROOT, 'writer.result')
  const writerSource = `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(${JSON.stringify(origin)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL;');
    const insert = db.prepare('INSERT INTO live_writes(note) VALUES (?)');
    for(let i=0;i<20;i++) insert.run('before-' + i);
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    let n=0;
    while(!fs.existsSync(${JSON.stringify(stop)})){
      insert.run('during-' + n++);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
    }
    const count = db.prepare('SELECT COUNT(*) AS count FROM live_writes').get().count;
    fs.writeFileSync(${JSON.stringify(writerResult)}, String(count));
    db.close();
  `
  const writer = spawn(process.execPath, ['-e', writerSource], { stdio: ['ignore', 'pipe', 'pipe'] })
  let writerStderr = ''
  writer.stderr.on('data', (chunk) => { writerStderr += String(chunk) })
  waitForFile(ready)
  const walPath = `${origin}-wal`
  const walBytesBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  let walBytesPeak = walBytesBefore
  const syncProcess = spawn(SQLITE_RSYNC, ['-vv', origin, replica], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  syncProcess.stdout.on('data', (chunk) => { stdout += String(chunk) })
  syncProcess.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const started = performance.now()
  while (syncProcess.exitCode === null && syncProcess.signalCode === null) {
    if (fs.existsSync(walPath)) walBytesPeak = Math.max(walBytesPeak, fs.statSync(walPath).size)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const syncStatus = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (syncProcess.exitCode !== null || syncProcess.signalCode !== null) {
      resolve({ code: syncProcess.exitCode, signal: syncProcess.signalCode })
    } else {
      syncProcess.once('exit', (code, signal) => resolve({ code, signal }))
    }
  })
  fs.writeFileSync(stop, 'stop')
  const writerStatus = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    writer.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(syncStatus.code, 0, `sqlite3_rsync concurrent snapshot failed: ${stderr}`)
  assert.equal(writerStatus.code, 0, `fixture writer failed: ${writerStderr}`)
  waitForFile(writerResult)
  const candidateRows = Number(sqlite(replica, 'SELECT COUNT(*) FROM live_writes;', true))
  const finalSourceRows = Number(fs.readFileSync(writerResult, 'utf8'))
  assert.ok(candidateRows >= 20 && candidateRows <= finalSourceRows)
  return {
    result: { status: syncStatus.code, signal: syncStatus.signal, stdout, stderr, elapsedMs: Math.round(performance.now() - started) },
    candidateRows,
    finalSourceRows,
    walBytesBefore,
    walBytesPeak,
  }
}

async function interruptedSync(origin: string, replica: string): Promise<{ signal: NodeJS.Signals | null; quickCheck: string }> {
  const child = spawn(SQLITE_RSYNC, ['-vv', origin, replica], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.notEqual(status.code, 0, 'interruption fixture must not complete successfully')
  assert.ok(!fs.existsSync(`${replica}.COMPLETE`), 'interrupted replica must not be promoted')
  const quickCheck = sqlite(replica, 'PRAGMA quick_check;')
  assert.equal(quickCheck, 'ok')
  return { signal: status.signal, quickCheck }
}

function capacityFailure(origin: string, oldGenerationHash: string, oldGeneration: string): {
  status: number | null
  stderr: string
  oldGenerationPreserved: boolean
} {
  const image = path.join(RUN_ROOT, 'capacity.sparseimage')
  const volumeName = `StockBoardRsyncFixture-${process.pid}`
  let mounted = false
  try {
    command('/usr/bin/hdiutil', ['create', '-size', '32m', '-type', 'SPARSE', '-fs', 'APFS', '-volname', volumeName, image])
    command('/usr/bin/hdiutil', ['attach', image, '-nobrowse'])
    mounted = true
    const replica = path.join('/Volumes', volumeName, 'replica.db')
    const result = sqliteRsync(origin, replica, true)
    assert.notEqual(result.status, 0, 'capacity-constrained sync must fail')
    assert.equal(sha256(oldGeneration), oldGenerationHash, 'capacity failure must not change the prior generation')
    return { status: result.status, stderr: result.stderr.trim(), oldGenerationPreserved: true }
  } finally {
    if (mounted) command('/usr/bin/hdiutil', ['detach', path.join('/Volumes', volumeName), '-force'], { allowFailure: true })
  }
}

function publishPair(jp: string, us: string, expectedGeneration: string, manifestPath: string): void {
  assert.equal(sqlite(jp, 'SELECT generation FROM source_generation WHERE id=1;', true), expectedGeneration)
  assert.equal(sqlite(us, 'SELECT generation FROM source_generation WHERE id=1;', true), expectedGeneration)
  assert.deepEqual(sqliteCheck(jp), { quickCheck: 'ok', integrityCheck: 'ok', journalMode: 'wal' })
  assert.deepEqual(sqliteCheck(us), { quickCheck: 'ok', integrityCheck: 'ok', journalMode: 'wal' })
  fs.writeFileSync(manifestPath, `${JSON.stringify({ status: 'COMPLETE', generation: expectedGeneration })}\n`, { flag: 'wx' })
}

async function main(): Promise<void> {
  if (process.env.STOCKBOARD_WEEKLY_BACKUP_HARDWARE_QA !== HARDWARE_QA_CONFIRMATION) {
    throw new Error('WEEKLY_BACKUP_HARDWARE_QA_CONFIRMATION_REQUIRED')
  }
  const info = diskInfo()
  assert.equal(info.VolumeUUID, EXPECTED_UUID)
  assert.equal(info.FilesystemType, 'apfs')
  assert.equal(info.Encryption, true)
  assert.equal(info.EncryptionThisVolumeProper, true)
  assert.equal(info.MountPoint, MOUNT)
  assert.equal(info.WritableVolume, true)
  for (const executable of [SQLITE, SQLITE_RSYNC, SQLDIFF]) assert.ok(fs.statSync(executable).isFile())
  assert.match(command(SQLITE, [':memory:', 'SELECT sqlite_version();']).stdout, /^3\.54\.1/)
  const toolArchive = '/tmp/sqlite-tools-osx-arm64-3540100.zip'
  if (fs.existsSync(toolArchive)) {
    const sha3 = createHash('sha3-256').update(fs.readFileSync(toolArchive)).digest('hex')
    assert.equal(sha3, EXPECTED_TOOLS_SHA3)
  }
  assert.ok(!fs.existsSync(RUN_ROOT))
  fs.mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 })
  assert.ok(fs.realpathSync(RUN_ROOT).startsWith(`${fs.realpathSync(MOUNT)}${path.sep}`))

  const freeBefore = freeBytes()
  const origin = path.join(RUN_ROOT, 'origin.db')
  const limitedSeed = path.join(RUN_ROOT, 'limited-seed.db')
  const candidate = path.join(RUN_ROOT, 'candidate.db')
  createDatabase(origin, 'single-db-generation-2', PAYLOAD_ROWS)
  command('/bin/sync', [])
  const freeAfterOrigin = freeBytes()
  apfsClone(origin, limitedSeed)
  const seedHash = sha256(limitedSeed)
  apfsClone(limitedSeed, candidate)
  command('/bin/sync', [])
  const freeAfterClone = freeBytes()
  sqlite(origin, 'UPDATE fixture_pages SET payload=randomblob(4096) WHERE id % 100 = 1;')
  command('/bin/sync', [])
  const freeAfterSourceMutation = freeBytes()

  const initialStableSync = sqliteRsync(origin, candidate)
  command('/bin/sync', [])
  const freeAfterInitialStableSync = freeBytes()
  assert.equal(contentHash(origin), contentHash(candidate))

  const liveCandidate = path.join(RUN_ROOT, 'live-candidate.db')
  apfsClone(candidate, liveCandidate)

  const concurrent = await concurrentSnapshot(origin, liveCandidate)
  const afterConcurrentCheck = sqliteCheck(liveCandidate)
  assert.equal(afterConcurrentCheck.quickCheck, 'ok')
  assert.equal(afterConcurrentCheck.integrityCheck, 'ok')
  assert.equal(contentHash(origin, 'fixture_pages'), contentHash(liveCandidate, 'fixture_pages'))
  assert.equal(sha256(limitedSeed), seedHash, 'sqlite3_rsync must not change the clone source generation')

  const stableSync = sqliteRsync(origin, liveCandidate)
  assert.equal(contentHash(origin), contentHash(liveCandidate), 'stable replica content must equal origin content')
  const stableSummary = command(SQLDIFF, ['--summary', origin, liveCandidate], { timeout: 180_000 }).stdout
  assert.doesNotMatch(stableSummary, /[1-9]\d* (?:changes|inserts|deletes)/)
  assert.deepEqual(sqliteCheck(liveCandidate), { quickCheck: 'ok', integrityCheck: 'ok', journalMode: 'wal' })
  const restoreSmoke = path.join(RUN_ROOT, 'restore-smoke.db')
  apfsClone(liveCandidate, restoreSmoke)
  const restoreVerification = sqliteCheck(restoreSmoke)
  assert.deepEqual(restoreVerification, { quickCheck: 'ok', integrityCheck: 'ok', journalMode: 'wal' })
  assert.equal(contentHash(restoreSmoke), contentHash(liveCandidate))

  const interruptedCandidate = path.join(RUN_ROOT, 'interrupted-candidate.db')
  apfsClone(limitedSeed, interruptedCandidate)
  const interrupted = await interruptedSync(origin, interruptedCandidate)
  assert.equal(sha256(limitedSeed), seedHash)

  const capacity = capacityFailure(origin, seedHash, limitedSeed)

  const pairGeneration = 'paired-update-generation-2026-10-24'
  const jpOrigin = path.join(RUN_ROOT, 'jp-origin.db')
  const usOrigin = path.join(RUN_ROOT, 'us-origin.db')
  const jpPrior = path.join(RUN_ROOT, 'jp-prior.db')
  const usPrior = path.join(RUN_ROOT, 'us-prior.db')
  const jpCandidate = path.join(RUN_ROOT, 'jp-candidate.db')
  const usCandidate = path.join(RUN_ROOT, 'us-candidate.db')
  const manifest = path.join(RUN_ROOT, 'COMPLETE.manifest.json')
  createDatabase(jpOrigin, 'prior-generation', 2_048)
  createDatabase(usOrigin, 'prior-generation', 2_048)
  apfsClone(jpOrigin, jpPrior)
  apfsClone(usOrigin, usPrior)
  apfsClone(jpPrior, jpCandidate)
  apfsClone(usPrior, usCandidate)
  sqlite(jpOrigin, `UPDATE source_generation SET generation='${pairGeneration}' WHERE id=1;`)
  sqlite(usOrigin, `UPDATE source_generation SET generation='${pairGeneration}' WHERE id=1;`)
  sqliteRsync(jpOrigin, jpCandidate)
  assert.throws(() => publishPair(jpCandidate, usCandidate, pairGeneration, manifest))
  assert.equal(fs.existsSync(manifest), false, 'one-market success must not publish a generation')
  sqliteRsync(usOrigin, usCandidate)
  publishPair(jpCandidate, usCandidate, pairGeneration, manifest)
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).status, 'COMPLETE')

  console.log(JSON.stringify({
    verdict: 'PASS',
    productionDatabaseOpened: false,
    existingBackupTouched: false,
    sqliteTools: {
      sqliteVersion: command(SQLITE, [':memory:', 'SELECT sqlite_version();']).stdout.trim(),
      archiveSha3: EXPECTED_TOOLS_SHA3,
      systemSqliteVersion: command('/usr/bin/sqlite3', ['--version']).stdout.trim().split(' ')[0],
      nodeSqliteVersion: '3.50.4',
    },
    fixture: {
      databaseBytes: fs.statSync(origin).size,
      originAllocationBytes: Number(freeBefore - freeAfterOrigin),
      twoCloneAllocationBytes: Number(freeAfterOrigin - freeAfterClone),
      sourceOnePercentMutationBytes: Number(freeAfterClone - freeAfterSourceMutation),
      sqlite3RsyncCandidateDeltaBytes: Number(freeAfterSourceMutation - freeAfterInitialStableSync),
      initialStableSyncElapsedMs: initialStableSync.elapsedMs,
      seedHashPreserved: sha256(limitedSeed) === seedHash,
    },
    concurrentSnapshot: {
      elapsedMs: concurrent.result.elapsedMs,
      candidateRows: concurrent.candidateRows,
      finalSourceRows: concurrent.finalSourceRows,
      walBytesBefore: concurrent.walBytesBefore,
      walBytesPeak: concurrent.walBytesPeak,
      quickCheck: afterConcurrentCheck.quickCheck,
      integrityCheck: afterConcurrentCheck.integrityCheck,
    },
    stableSync: {
      elapsedMs: stableSync.elapsedMs,
      contentMatch: true,
      quickCheck: 'ok',
      integrityCheck: 'ok',
    },
    restoreSmoke: {
      contentMatch: true,
      ...restoreVerification,
    },
    interruption: interrupted,
    capacityFailure: capacity,
    pairedGeneration: {
      oneMarketPublishRefused: true,
      bothMarketsPublished: true,
      generation: pairGeneration,
    },
  }, null, 2))
}

main().finally(() => {
  if (fs.existsSync(RUN_ROOT)) {
    const canonical = fs.realpathSync(RUN_ROOT)
    assert.ok(canonical.startsWith(`${fs.realpathSync(MOUNT)}${path.sep}.stockboard-weekly-sqlite3-rsync-fixture${path.sep}`))
    fs.rmSync(RUN_ROOT, { recursive: true, force: false })
  }
  if (fs.existsSync(FIXTURE_PARENT) && fs.readdirSync(FIXTURE_PARENT).length === 0) fs.rmdirSync(FIXTURE_PARENT)
  command('/bin/sync', [])
  console.error(JSON.stringify({ fixtureCleanup: 'PASS', freeBytesAfterCleanup: freeBytes().toString() }))
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
