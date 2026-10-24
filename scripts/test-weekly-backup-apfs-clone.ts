import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

type Database = {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    all(): Array<Record<string, unknown>>
    get(): Record<string, unknown> | undefined
    run(...values: unknown[]): unknown
  }
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => Database
}

const MOUNT = '/Volumes/StockBoard Backup'
const EXPECTED_UUID = '9FE99B78-6AF2-4493-AEF5-A1E5BDCDE683'
const FIXTURE_PARENT = path.join(MOUNT, '.stockboard-weekly-backup-fixture')
const RUN_ID = `apfs-clone-${process.pid}-${Date.now()}`
const RUN_ROOT = path.join(FIXTURE_PARENT, RUN_ID)
const HARDWARE_QA_CONFIRMATION = 'WRITE_ISOLATED_WEEKLY_BACKUP_FIXTURE_TO_APPROVED_SANDISK'
const PAYLOAD_ROWS = 32_768
const PAYLOAD_BYTES = 4_096
const CHANGED_ROWS = Math.ceil(PAYLOAD_ROWS / 100)
const RSYNC_BLOCK_BYTES = 4_096

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`COMMAND_FAILED:${command}:${result.status}:${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout
}

function diskInfo(): Record<string, unknown> {
  const plist = run('/usr/sbin/diskutil', ['info', '-plist', MOUNT])
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error || result.status !== 0) throw new Error('DISK_INFO_PARSE_FAILED')
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function freeBytes(): bigint {
  const stat = fs.statfsSync(MOUNT, { bigint: true })
  return stat.bsize * stat.bavail
}

function syncVolume(): void {
  run('/bin/sync', [])
}

function sha256(filePath: string): string {
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  const hash = createHash('sha256')
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function createFixtureDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA page_size=4096;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE fixture_pages(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      BEGIN IMMEDIATE;
    `)
    const insert = database.prepare('INSERT INTO fixture_pages(id, payload) VALUES (?, ?)')
    for (let id = 1; id <= PAYLOAD_ROWS; id += 1) insert.run(id, randomBytes(PAYLOAD_BYTES))
    database.exec('COMMIT;')
  } finally {
    database.close()
  }
}

function mutateOnePercent(databasePath: string): void {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
    const update = database.prepare('UPDATE fixture_pages SET payload = ? WHERE id = ?')
    for (let index = 0; index < CHANGED_ROWS; index += 1) {
      update.run(randomBytes(PAYLOAD_BYTES), 1 + index * 100)
    }
    database.exec('COMMIT;')
  } finally {
    database.close()
  }
}

function sqliteVerification(databasePath: string): { quickCheck: string; integrityCheck: string; rows: number } {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec('PRAGMA query_only=ON;')
    const quick = database.prepare('PRAGMA quick_check').get() as { quick_check?: string }
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    const count = database.prepare('SELECT COUNT(*) AS count FROM fixture_pages').get() as { count?: number }
    return {
      quickCheck: String(quick.quick_check),
      integrityCheck: String(integrity.integrity_check),
      rows: Number(count.count),
    }
  } finally {
    database.close()
  }
}

function consumed(before: bigint, after: bigint): number {
  return Number(before - after)
}

function assertNoSymlink(candidate: string): void {
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`SYMLINK_REFUSED:${candidate}`)
  }
}

const startedAt = new Date().toISOString()
let freeAfterCleanup: bigint | null = null

try {
  if (process.env.STOCKBOARD_WEEKLY_BACKUP_HARDWARE_QA !== HARDWARE_QA_CONFIRMATION) {
    throw new Error('WEEKLY_BACKUP_HARDWARE_QA_CONFIRMATION_REQUIRED')
  }
  const info = diskInfo()
  assert.equal(info.VolumeUUID, EXPECTED_UUID, 'unexpected SanDisk volume UUID')
  assert.equal(info.MountPoint, MOUNT, 'unexpected SanDisk mount point')
  assert.equal(info.FilesystemType, 'apfs', 'fixture requires APFS')
  assert.equal(info.Encryption, true, 'fixture requires encrypted APFS')
  assert.equal(info.EncryptionThisVolumeProper, true, 'fixture requires per-volume encryption')
  assert.equal(info.WritableVolume, true, 'fixture requires a writable volume')
  assert.equal(info.BusProtocol, 'USB', 'fixture requires the approved USB target')
  assertNoSymlink(MOUNT)
  assertNoSymlink(FIXTURE_PARENT)
  assert.ok(!fs.existsSync(RUN_ROOT), 'fixture run directory must be new')
  fs.mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 })
  assert.ok(fs.realpathSync(RUN_ROOT).startsWith(`${fs.realpathSync(MOUNT)}${path.sep}`))

  const original = path.join(RUN_ROOT, 'generation-v1.sqlite')
  const updatedSource = path.join(RUN_ROOT, 'generation-v2-source.sqlite')
  const candidate = path.join(RUN_ROOT, 'generation-v2-candidate.sqlite')
  const restore = path.join(RUN_ROOT, 'restore-smoke.sqlite')

  const freeBefore = freeBytes()
  const createStarted = performance.now()
  createFixtureDatabase(original)
  syncVolume()
  const createMs = performance.now() - createStarted
  const originalHash = sha256(original)
  const originalSize = fs.statSync(original).size
  const freeAfterOriginal = freeBytes()

  const cloneStarted = performance.now()
  run('/bin/cp', ['-c', original, updatedSource])
  run('/bin/cp', ['-c', original, candidate])
  syncVolume()
  const cloneMs = performance.now() - cloneStarted
  const freeAfterClones = freeBytes()
  assert.equal(sha256(updatedSource), originalHash)
  assert.equal(sha256(candidate), originalHash)

  const sourceUpdateStarted = performance.now()
  mutateOnePercent(updatedSource)
  syncVolume()
  const sourceUpdateMs = performance.now() - sourceUpdateStarted
  const updatedHash = sha256(updatedSource)
  assert.notEqual(updatedHash, originalHash)
  const freeAfterSourceUpdate = freeBytes()

  const deltaStarted = performance.now()
  const rsyncOutput = run('/usr/bin/rsync', [
    '--inplace',
    '--no-whole-file',
    '--checksum',
    `--block-size=${RSYNC_BLOCK_BYTES}`,
    '--stats',
    updatedSource,
    candidate,
  ])
  syncVolume()
  const deltaMs = performance.now() - deltaStarted
  const freeAfterDelta = freeBytes()
  assert.equal(sha256(candidate), updatedHash, 'delta-updated candidate must match the new source')
  assert.equal(sha256(original), originalHash, 'the prior generation must remain immutable')

  const candidateVerification = sqliteVerification(candidate)
  assert.deepEqual(candidateVerification, { quickCheck: 'ok', integrityCheck: 'ok', rows: PAYLOAD_ROWS })
  run('/bin/cp', ['-c', candidate, restore])
  syncVolume()
  const freeAfterRestoreClone = freeBytes()
  const restoreVerification = sqliteVerification(restore)
  assert.deepEqual(restoreVerification, candidateVerification)

  console.log(JSON.stringify({
    verdict: 'PASS',
    productionDatabaseOpened: false,
    existingBackupTouched: false,
    startedAt,
    completedAt: new Date().toISOString(),
    volume: {
      uuid: info.VolumeUUID,
      mountPoint: info.MountPoint,
      filesystem: info.FilesystemType,
      encrypted: info.Encryption,
      parentWholeDisk: info.ParentWholeDisk,
      totalBytes: info.TotalSize,
      freeBytesBefore: freeBefore.toString(),
    },
    fixture: {
      databaseBytes: originalSize,
      payloadRows: PAYLOAD_ROWS,
      payloadBytesPerRow: PAYLOAD_BYTES,
      changedRows: CHANGED_ROWS,
      changedPayloadBytes: CHANGED_ROWS * PAYLOAD_BYTES,
      rsyncBlockBytes: RSYNC_BLOCK_BYTES,
      originalHash,
      updatedHash,
      candidateVerification,
      restoreVerification,
    },
    allocation: {
      originalBytes: consumed(freeBefore, freeAfterOriginal),
      twoCloneBytes: consumed(freeAfterOriginal, freeAfterClones),
      sourceOnePercentUpdateBytes: consumed(freeAfterClones, freeAfterSourceUpdate),
      candidateDeltaUpdateBytes: consumed(freeAfterSourceUpdate, freeAfterDelta),
      restoreCloneBytes: consumed(freeAfterDelta, freeAfterRestoreClone),
    },
    durationMs: {
      create: Math.round(createMs),
      twoClones: Math.round(cloneMs),
      sourceOnePercentUpdate: Math.round(sourceUpdateMs),
      candidateDeltaUpdate: Math.round(deltaMs),
    },
    rsyncStats: rsyncOutput.trim().split('\n').filter((line) => /bytes|speedup|files transferred/i.test(line)),
  }, null, 2))
} finally {
  if (fs.existsSync(RUN_ROOT)) {
    const canonicalMount = fs.realpathSync(MOUNT)
    const canonicalRun = fs.realpathSync(RUN_ROOT)
    assert.ok(canonicalRun.startsWith(`${canonicalMount}${path.sep}.stockboard-weekly-backup-fixture${path.sep}`))
    fs.rmSync(RUN_ROOT, { recursive: true, force: false })
  }
  if (fs.existsSync(FIXTURE_PARENT) && fs.readdirSync(FIXTURE_PARENT).length === 0) fs.rmdirSync(FIXTURE_PARENT)
  syncVolume()
  freeAfterCleanup = freeBytes()
  console.error(JSON.stringify({ fixtureCleanup: 'PASS', freeBytesAfterCleanup: freeAfterCleanup.toString() }))
}
