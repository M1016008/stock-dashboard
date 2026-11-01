import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  advanceAtomicBundleActivationJournal,
  assertSqliteBundleManifest,
  createAtomicBundleActivationJournal,
  createSqliteBundleManifest,
  readSqliteBundleManifest,
  type SqliteBundleManifest,
} from '@/lib/storage/apfs-atomic-sqlite-bundle'
import {
  assertDurableActivationGenerationConvergence,
  assertDurableActivationArtifactClassification,
  classifyDurableActivationArtifacts,
  commitDurableAtomicBundleActivation,
  createSqliteBundleIntegrityReceipt,
  executeDurableAtomicBundleReverse,
  executeDurableAtomicBundleSwap,
  inspectDurableAtomicBundleActivation,
  persistInitialDurableActivationJournal,
  persistSqliteCandidateIntegrityReceipt,
  persistSqliteBundleIntegrityReceipt,
  persistSqliteBundleManifest,
  readDurableActivationJournal,
  recordDurableGenerationReconciled,
  recordDurableReverseObservedAfterRestart,
  recordDurableSwapObservedAfterRestart,
  sealDurableReverseIntent,
  sealDurableSwapIntent,
} from '@/lib/storage/durable-atomic-bundle-activation'
import {
  atomicBundleRecoveryApprovalSha256,
  type AtomicBundleRecoveryApproval,
} from '@/lib/storage/atomic-bundle-recovery-approval'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  createFullSqliteIntegrityReceipt,
  sqliteArtifactIdentity,
} from '@/lib/storage/sqlite-integrity-contract'

type FixtureDatabase = {
  close(): void
  exec(sql: string): void
  prepare(sql: string): { get(): Record<string, unknown> | undefined }
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => FixtureDatabase
}

function sha256File(file: string): string {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function compileHelper(root: string): string {
  const executable = path.join(root, 'apfs-rename-swap')
  const result = spawnSync('/usr/bin/clang', [
    '-O2', '-Wall', '-Wextra', '-Werror', path.resolve('scripts/native/apfs-rename-swap.c'), '-o', executable,
  ], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`durable_fixture_helper_compile_failed:${result.error?.message ?? result.stderr}`)
  }
  return executable
}

function createDatabase(file: string, value: string): void {
  const database = new DatabaseSync(file)
  try {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO marker(id, value) VALUES(1, '${value}');
    `)
  } finally {
    database.close()
  }
}

function createSealedBundle(
  root: string,
  directory: string,
  value: string,
  generation: string,
  transactionId: string,
): { path: string; manifest: SqliteBundleManifest } {
  const bundlePath = path.join(root, directory)
  fs.mkdirSync(bundlePath)
  createDatabase(path.join(bundlePath, 'stockboard.db'), value)
  const databasePath = path.join(bundlePath, 'stockboard.db')
  const startedAt = Date.now()
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let quickCheckResult = ''
  try {
    quickCheckResult = String(database.prepare('PRAGMA quick_check;').get()?.quick_check)
  } finally {
    database.close()
  }
  const artifact = sqliteArtifactIdentity({ file: databasePath })
  const fullQuickCheck = createFullSqliteIntegrityReceipt({
    kind: 'BACKUP_COMPLETE',
    transactionId,
    createdAt: '2026-11-01T00:00:00.000Z',
    artifact,
    measurementEvidenceSha256: stableSha256({
      command: 'PRAGMA quick_check;',
      result: quickCheckResult,
      databaseSha256: artifact.sha256,
      runtime: process.execPath,
    }),
    quickCheckResult,
    quickCheckElapsedMs: Date.now() - startedAt,
    sourceGeneration: `${generation}-source`,
    servingGeneration: `${generation}-serving`,
    guarantees: ['fixture executed full SQLite quick_check before bundle sealing'],
    limitations: ['fixture receipt does not prove Production or OWC media durability'],
  })
  persistSqliteCandidateIntegrityReceipt(bundlePath, fullQuickCheck)
  const receipt = createSqliteBundleIntegrityReceipt({
    bundlePath,
    transactionId,
    bundleId: `${directory}-bundle`,
    completedAt: '2026-11-01T00:00:00.000Z',
    sourceGeneration: `${generation}-source`,
    servingGeneration: `${generation}-serving`,
    cacheGeneration: `${generation}-cache`,
    journalMode: 'delete',
  })
  persistSqliteBundleIntegrityReceipt(bundlePath, receipt)
  const manifest = createSqliteBundleManifest({
    bundlePath,
    bundleId: receipt.bundleId,
    transactionId,
    createdAt: receipt.completedAt,
    sourceGeneration: receipt.sourceGeneration,
    servingGeneration: receipt.servingGeneration,
    journalMode: receipt.journalMode,
    integrityReceiptSha256: receipt.receiptSha256,
  })
  persistSqliteBundleManifest(bundlePath, manifest)
  return { path: bundlePath, manifest }
}

function mutateBundleBytesAndRebindMetadataWithoutHash(
  bundlePath: string,
  manifest: SqliteBundleManifest,
): SqliteBundleManifest {
  const databasePath = path.join(bundlePath, 'stockboard.db')
  const descriptor = fs.openSync(databasePath, 'r+')
  try {
    const stat = fs.fstatSync(descriptor)
    const byte = Buffer.alloc(1)
    fs.readSync(descriptor, byte, 0, 1, stat.size - 1)
    byte[0] ^= 0xff
    fs.writeSync(descriptor, byte, 0, 1, stat.size - 1)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  const stat = fs.lstatSync(databasePath, { bigint: true })
  const { manifestSha256: _manifestSha256, ...body } = {
    ...manifest,
    database: {
      ...manifest.database,
      device: String(stat.dev),
      inode: String(stat.ino),
      sizeBytes: Number(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    },
  }
  const rebound = { ...body, manifestSha256: stableSha256(body) }
  fs.writeFileSync(path.join(bundlePath, 'bundle.json'), `${JSON.stringify(rebound, null, 2)}\n`)
  return rebound
}

function createPreparedJournal(input: {
  journalPath: string
  active: { path: string; manifest: SqliteBundleManifest }
  candidate: { path: string; manifest: SqliteBundleManifest }
}): void {
  persistInitialDurableActivationJournal({
    journalPath: input.journalPath,
    journal: createAtomicBundleActivationJournal({
      transactionId: input.candidate.manifest.transactionId,
      activePath: input.active.path,
      candidatePath: input.candidate.path,
      oldManifestSha256: input.active.manifest.manifestSha256,
      newManifestSha256: input.candidate.manifest.manifestSha256,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }),
  })
}

function setupActivation(root: string, prefix: string): {
  active: { path: string; manifest: SqliteBundleManifest }
  candidate: { path: string; manifest: SqliteBundleManifest }
  journalPath: string
} {
  const state = path.join(root, `${prefix}-state`)
  fs.mkdirSync(state)
  const active = createSealedBundle(
    root, `${prefix}-active`, `${prefix}-old`, `${prefix}-old`, `${prefix}-previous-transaction`,
  )
  const candidate = createSealedBundle(
    root, `${prefix}-candidate`, `${prefix}-new`, `${prefix}-new`, `${prefix}-candidate-transaction`,
  )
  const journalPath = path.join(state, 'activation.json')
  createPreparedJournal({ journalPath, active, candidate })
  return { active, candidate, journalPath }
}

function forwardToSwapped(input: {
  journalPath: string
  executablePath: string
  executableSha256: string
}): ReturnType<typeof executeDurableAtomicBundleSwap> {
  sealDurableSwapIntent({
    journalPath: input.journalPath,
    updatedAt: '2026-11-01T00:00:02.000Z',
    assertReaderWriterBarrierValid: () => {},
  })
  return executeDurableAtomicBundleSwap({
    journalPath: input.journalPath,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    timeoutMs: 30_000,
    updatedAt: '2026-11-01T00:00:03.000Z',
    assertReaderWriterBarrierValid: () => {},
  })
}

function marker(bundlePath: string): string {
  const database = new DatabaseSync(path.join(bundlePath, 'stockboard.db'), { readOnly: true })
  try {
    return String(database.prepare('SELECT value FROM marker WHERE id=1').get()?.value)
  } finally {
    database.close()
  }
}

function assertKilled(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, null)
  assert.equal(result.signal, 'SIGKILL')
}

function waitForFile(file: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture_wait_timeout:${file}`)
    Atomics.wait(sleeper, 0, 0, 10)
  }
}

function writeChildResult(file: string, result: Record<string, unknown>): void {
  fs.writeFileSync(file, `${JSON.stringify(result)}\n`, { flag: 'wx' })
}

function restartApproval(input: {
  observation: ReturnType<typeof inspectDurableAtomicBundleActivation>
  barrierReceiptSha256: string
  now?: Date
  issuedAt?: string
  expiresAt?: string
}): { approval: AtomicBundleRecoveryApproval; approvalSha256: string } {
  const now = input.now ?? new Date()
  const approval: AtomicBundleRecoveryApproval = {
    version: 1,
    action: 'RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP',
    transactionId: input.observation.journal.transactionId,
    journalSha256: input.observation.journal.journalSha256,
    journalFileSha256: input.observation.fileSha256,
    oldManifestSha256: input.observation.journal.oldManifestSha256,
    newManifestSha256: input.observation.journal.newManifestSha256,
    activeIntegrityReceiptSha256: input.observation.activeReceipt.receiptSha256,
    barrierReceiptSha256: input.barrierReceiptSha256,
    allowedTransition: 'SWAP_INTENT_TO_SWAPPED',
    automaticSwapAllowed: false,
    automaticSwapBackAllowed: false,
    issuedAt: input.issuedAt ?? new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: input.expiresAt ?? new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    reason: 'Record a byte-verified NEW_ACTIVE observation after restart without invoking swap.',
  }
  return { approval, approvalSha256: atomicBundleRecoveryApprovalSha256(approval) }
}

function reverseRestartApproval(input: {
  observation: ReturnType<typeof inspectDurableAtomicBundleActivation>
  barrierReceiptSha256: string
  now?: Date
}): { approval: AtomicBundleRecoveryApproval; approvalSha256: string } {
  const now = input.now ?? new Date()
  const approval: AtomicBundleRecoveryApproval = {
    version: 1,
    action: 'RECORD_OBSERVED_OLD_ACTIVE_AFTER_REVERSE_WITHOUT_SWAP',
    transactionId: input.observation.journal.transactionId,
    journalSha256: input.observation.journal.journalSha256,
    journalFileSha256: input.observation.fileSha256,
    oldManifestSha256: input.observation.journal.oldManifestSha256,
    newManifestSha256: input.observation.journal.newManifestSha256,
    activeIntegrityReceiptSha256: input.observation.activeReceipt.receiptSha256,
    barrierReceiptSha256: input.barrierReceiptSha256,
    allowedTransition: 'REVERSE_INTENT_TO_PRE_CONSUMER_REVERSED',
    automaticSwapAllowed: false,
    automaticSwapBackAllowed: false,
    issuedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    reason: 'Record a byte-verified OLD_ACTIVE reverse observation without invoking another swap.',
  }
  return { approval, approvalSha256: atomicBundleRecoveryApprovalSha256(approval) }
}

function childMode(): never | void {
  const [mode, journalPath, executable, ...rest] = process.argv.slice(2)
  if (mode === '--inspect') {
    const observation = inspectDurableAtomicBundleActivation({ journalPath, verifyByteIdentity: false })
    process.stdout.write(JSON.stringify({
      phase: observation.journal.phase,
      position: observation.position,
      durabilityIssues: observation.durabilityIssues,
      activeCacheGeneration: observation.activeReceipt.cacheGeneration,
    }))
    return
  }
  if (mode === '--race-seal-winner') {
    const [ready, contended, result] = rest
    try {
      const observation = sealDurableSwapIntent({
        journalPath,
        updatedAt: executable,
        assertReaderWriterBarrierValid: () => {},
        checkpoint: (checkpoint) => {
          if (checkpoint !== 'PENDING_LOCK_ACQUIRED') return
          fs.writeFileSync(ready, 'ready\n', { flag: 'wx' })
          waitForFile(contended)
        },
      })
      writeChildResult(result, { status: 'SUCCESS', phase: observation.journal.phase })
    } catch (error) {
      writeChildResult(result, { status: 'REJECTED', error: String(error) })
    }
    return
  }
  if (mode === '--race-seal-loser') {
    const [ready, contended, result] = rest
    waitForFile(ready)
    try {
      sealDurableSwapIntent({
        journalPath,
        updatedAt: executable,
        assertReaderWriterBarrierValid: () => {},
      })
      writeChildResult(result, { status: 'UNEXPECTED_SUCCESS' })
    } catch (error) {
      writeChildResult(result, { status: 'REJECTED', error: String(error) })
    } finally {
      fs.writeFileSync(contended, 'contended\n', { flag: 'wx' })
    }
    return
  }
  if (mode === '--race-cas-seal') {
    const [ready, gate, result] = rest
    try {
      sealDurableSwapIntent({
        journalPath,
        updatedAt: executable,
        assertReaderWriterBarrierValid: () => {},
        checkpoint: (checkpoint) => {
          if (checkpoint !== 'PENDING_DIRECTORY_FSYNC') return
          fs.writeFileSync(ready, 'ready\n', { flag: 'wx' })
          waitForFile(gate)
        },
      })
      writeChildResult(result, { status: 'UNEXPECTED_SUCCESS' })
    } catch (error) {
      writeChildResult(result, { status: 'REJECTED', error: String(error) })
    }
    return
  }
  if (mode === '--displace-journal') {
    const [ready, gate, result] = rest
    waitForFile(ready)
    const current = readDurableActivationJournal(journalPath).journal
    const displaced = advanceAtomicBundleActivationJournal(current, 'HOLD', executable)
    fs.writeFileSync(journalPath, `${JSON.stringify(displaced, null, 2)}\n`)
    fs.writeFileSync(gate, 'continue\n', { flag: 'wx' })
    writeChildResult(result, { status: 'DISPLACED', journalSha256: displaced.journalSha256 })
    return
  }
  if (mode === '--crash-seal-checkpoint') {
    const [checkpointName] = rest
    sealDurableSwapIntent({
      journalPath,
      updatedAt: executable,
      assertReaderWriterBarrierValid: () => {},
      checkpoint: (checkpoint) => {
        if (checkpoint === checkpointName) process.kill(process.pid, 'SIGKILL')
      },
    })
    throw new Error('durable_fixture_journal_crash_not_injected')
  }
  if (['--crash-before-reverse', '--crash-after-reverse'].includes(mode)) {
    const [sourceGeneration, servingGeneration, cacheGeneration] = rest
    let barriers = 0
    executeDurableAtomicBundleReverse({
      journalPath,
      executablePath: executable,
      executableSha256: sha256File(executable),
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: sourceGeneration,
      observedServingGeneration: servingGeneration,
      observedCacheGeneration: cacheGeneration,
      assertReaderWriterBarrierValid: () => {
        barriers += 1
        if ((mode === '--crash-before-reverse' && barriers === 1)
          || (mode === '--crash-after-reverse' && barriers === 3)) {
          process.kill(process.pid, 'SIGKILL')
        }
      },
    })
    throw new Error('durable_fixture_reverse_crash_not_injected')
  }
  if (!['--crash-before-swap', '--crash-after-swap'].includes(mode)) return
  let barriers = 0
  executeDurableAtomicBundleSwap({
    journalPath,
    executablePath: executable,
    executableSha256: sha256File(executable),
    timeoutMs: 30_000,
    updatedAt: '2026-11-01T00:00:03.000Z',
    assertReaderWriterBarrierValid: () => {
      barriers += 1
      if ((mode === '--crash-before-swap' && barriers === 1)
        || (mode === '--crash-after-swap' && barriers === 3)) {
        process.kill(process.pid, 'SIGKILL')
      }
    },
  })
  throw new Error('durable_fixture_crash_not_injected')
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fixture_child_failed:${code ?? signal}`))
    })
  })
}

function inspectInFreshProcess(script: string, journalPath: string): {
  phase: string
  position: string
  durabilityIssues: string[]
  activeCacheGeneration: string
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--inspect', journalPath], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as {
    phase: string
    position: string
    durabilityIssues: string[]
    activeCacheGeneration: string
  }
}

async function main(): Promise<void> {
  if (process.argv[2]?.startsWith('--')) {
    const result = childMode()
    if (result === undefined) return
  }
  const configuredRoot = process.env.STOCKBOARD_ATOMIC_BUNDLE_TEST_ROOT
  const parent = configuredRoot ? fs.realpathSync(configuredRoot) : fs.realpathSync(os.tmpdir())
  assert.doesNotMatch(parent, /^\/Volumes\/OWC Express 1M2 80G(?:\/|$)/)
  const root = fs.mkdtempSync(path.join(parent, 'stockboard-durable-activation-'))
  try {
    const executable = compileHelper(root)
    const executableSha256 = sha256File(executable)
    const probe = spawnSync(executable, ['--probe', root], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const script = fileURLToPath(import.meta.url)

    const normal = setupActivation(root, 'normal')
    let barrierChecks = 0
    const intent = sealDurableSwapIntent({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => { barrierChecks += 1 },
    })
    assert.equal(intent.journal.phase, 'SWAP_INTENT')
    assert.equal(intent.position, 'OLD_ACTIVE')
    assert.equal(barrierChecks, 3)
    const swapped = executeDurableAtomicBundleSwap({
      journalPath: normal.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => { barrierChecks += 1 },
    })
    assert.equal(swapped.journal.phase, 'SWAPPED')
    assert.equal(swapped.position, 'NEW_ACTIVE')
    assert.equal(swapped.activeReceipt.cacheGeneration, 'normal-new-cache')
    assert.doesNotThrow(() => assertDurableActivationGenerationConvergence({
      observation: swapped,
      sourceGeneration: 'normal-new-source',
      servingGeneration: 'normal-new-serving',
      cacheGeneration: 'normal-new-cache',
    }))
    assert.throws(() => assertDurableActivationGenerationConvergence({
      observation: swapped,
      sourceGeneration: 'normal-new-source',
      servingGeneration: 'normal-new-serving',
      cacheGeneration: 'stale-cache',
    }), /SQLITE_BUNDLE_GENERATION_CONVERGENCE_MISMATCH/)
    assert.equal(barrierChecks, 7)
    assert.equal(marker(normal.active.path), 'normal-new')
    assert.deepEqual(inspectInFreshProcess(script, normal.journalPath), {
      phase: 'SWAPPED',
      position: 'NEW_ACTIVE',
      durabilityIssues: [],
      activeCacheGeneration: 'normal-new-cache',
    })
    assert.throws(() => commitDurableAtomicBundleActivation({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'normal-new-source',
      observedServingGeneration: 'normal-new-serving',
      observedCacheGeneration: 'normal-new-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_COMMIT_PHASE_INVALID/)
    assert.throws(() => recordDurableGenerationReconciled({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'normal-new-source',
      observedServingGeneration: 'normal-new-serving',
      observedCacheGeneration: 'stale-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_GENERATION_CONVERGENCE_MISMATCH/)
    const reconciled = recordDurableGenerationReconciled({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'normal-new-source',
      observedServingGeneration: 'normal-new-serving',
      observedCacheGeneration: 'normal-new-cache',
      assertReaderWriterBarrierValid: () => { barrierChecks += 1 },
    })
    assert.equal(reconciled.journal.phase, 'GENERATION_RECONCILED')
    assert.equal(inspectInFreshProcess(script, normal.journalPath).phase, 'GENERATION_RECONCILED')
    assert.throws(() => sealDurableReverseIntent({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:04.500Z',
      observedSourceGeneration: 'normal-old-source',
      observedServingGeneration: 'normal-old-serving',
      observedCacheGeneration: 'normal-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_REVERSE_INTENT_PRECONDITION_INVALID/)
    assert.throws(() => commitDurableAtomicBundleActivation({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'normal-new-source',
      observedServingGeneration: 'normal-new-serving',
      observedCacheGeneration: 'stale-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_GENERATION_CONVERGENCE_MISMATCH/)
    const committed = commitDurableAtomicBundleActivation({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'normal-new-source',
      observedServingGeneration: 'normal-new-serving',
      observedCacheGeneration: 'normal-new-cache',
      assertReaderWriterBarrierValid: () => { barrierChecks += 1 },
    })
    assert.equal(committed.journal.phase, 'COMMITTED')
    assert.equal(barrierChecks, 13)
    assert.throws(() => sealDurableReverseIntent({
      journalPath: normal.journalPath,
      updatedAt: '2026-11-01T00:00:06.000Z',
      observedSourceGeneration: 'normal-old-source',
      observedServingGeneration: 'normal-old-serving',
      observedCacheGeneration: 'normal-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_REVERSE_INTENT_PRECONDITION_INVALID/)

    const reverse = setupActivation(root, 'reverse')
    forwardToSwapped({ journalPath: reverse.journalPath, executablePath: executable, executableSha256 })
    const reverseIntent = sealDurableReverseIntent({
      journalPath: reverse.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-old-source',
      observedServingGeneration: 'reverse-old-serving',
      observedCacheGeneration: 'reverse-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assert.equal(reverseIntent.journal.phase, 'REVERSE_INTENT')
    assert.equal(reverseIntent.position, 'NEW_ACTIVE')
    const reversed = executeDurableAtomicBundleReverse({
      journalPath: reverse.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:06.000Z',
      observedSourceGeneration: 'reverse-old-source',
      observedServingGeneration: 'reverse-old-serving',
      observedCacheGeneration: 'reverse-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assert.equal(reversed.journal.phase, 'PRE_CONSUMER_REVERSED')
    assert.equal(reversed.position, 'OLD_ACTIVE')
    assert.equal(marker(reverse.active.path), 'reverse-old')
    assert.throws(() => commitDurableAtomicBundleActivation({
      journalPath: reverse.journalPath,
      updatedAt: '2026-11-01T00:00:07.000Z',
      observedSourceGeneration: 'reverse-old-source',
      observedServingGeneration: 'reverse-old-serving',
      observedCacheGeneration: 'reverse-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_COMMIT_PHASE_INVALID/)
    assert.throws(() => executeDurableAtomicBundleReverse({
      journalPath: reverse.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:07.000Z',
      observedSourceGeneration: 'reverse-old-source',
      observedServingGeneration: 'reverse-old-serving',
      observedCacheGeneration: 'reverse-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_REVERSE_PRECONDITION_INVALID/)

    const reverseInvalidTransitionTime = setupActivation(root, 'reverse-invalid-transition-time')
    forwardToSwapped({
      journalPath: reverseInvalidTransitionTime.journalPath, executablePath: executable, executableSha256,
    })
    sealDurableReverseIntent({
      journalPath: reverseInvalidTransitionTime.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-invalid-transition-time-old-source',
      observedServingGeneration: 'reverse-invalid-transition-time-old-serving',
      observedCacheGeneration: 'reverse-invalid-transition-time-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assert.throws(() => executeDurableAtomicBundleReverse({
      journalPath: reverseInvalidTransitionTime.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'reverse-invalid-transition-time-old-source',
      observedServingGeneration: 'reverse-invalid-transition-time-old-serving',
      observedCacheGeneration: 'reverse-invalid-transition-time-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_ACTIVATION_TRANSITION_INVALID/)
    assert.equal(marker(reverseInvalidTransitionTime.active.path), 'reverse-invalid-transition-time-new')
    assert.deepEqual(inspectInFreshProcess(script, reverseInvalidTransitionTime.journalPath), {
      phase: 'REVERSE_INTENT',
      position: 'NEW_ACTIVE',
      durabilityIssues: [],
      activeCacheGeneration: 'reverse-invalid-transition-time-new-cache',
    })

    const reverseGenerationMismatch = setupActivation(root, 'reverse-generation-mismatch')
    forwardToSwapped({
      journalPath: reverseGenerationMismatch.journalPath, executablePath: executable, executableSha256,
    })
    assert.throws(() => sealDurableReverseIntent({
      journalPath: reverseGenerationMismatch.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'unapproved-source',
      observedServingGeneration: 'reverse-generation-mismatch-old-serving',
      observedCacheGeneration: 'reverse-generation-mismatch-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_REVERSE_GENERATION_CONVERGENCE_MISMATCH/)
    assert.equal(readDurableActivationJournal(reverseGenerationMismatch.journalPath).journal.phase, 'SWAPPED')

    const hashOnlyMismatch = setupActivation(root, 'hash-only-mismatch')
    const reboundCandidateManifest = mutateBundleBytesAndRebindMetadataWithoutHash(
      hashOnlyMismatch.candidate.path, hashOnlyMismatch.candidate.manifest,
    )
    fs.unlinkSync(hashOnlyMismatch.journalPath)
    createPreparedJournal({
      journalPath: hashOnlyMismatch.journalPath,
      active: hashOnlyMismatch.active,
      candidate: { path: hashOnlyMismatch.candidate.path, manifest: reboundCandidateManifest },
    })
    assert.throws(() => assertSqliteBundleManifest(
      hashOnlyMismatch.candidate.path, reboundCandidateManifest,
    ), /SQLITE_BUNDLE_MEMBER_HASH_MISMATCH/)
    assert.throws(() => sealDurableSwapIntent({
      journalPath: hashOnlyMismatch.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_MEMBER_HASH_MISMATCH/)

    const reverseChangedOld = setupActivation(root, 'reverse-changed-old')
    forwardToSwapped({ journalPath: reverseChangedOld.journalPath, executablePath: executable, executableSha256 })
    fs.appendFileSync(path.join(reverseChangedOld.candidate.path, 'stockboard.db'), 'changed')
    assert.throws(() => sealDurableReverseIntent({
      journalPath: reverseChangedOld.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-changed-old-old-source',
      observedServingGeneration: 'reverse-changed-old-old-serving',
      observedCacheGeneration: 'reverse-changed-old-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH/)

    const reverseChangedAfterIntent = setupActivation(root, 'reverse-changed-after-intent')
    forwardToSwapped({
      journalPath: reverseChangedAfterIntent.journalPath, executablePath: executable, executableSha256,
    })
    sealDurableReverseIntent({
      journalPath: reverseChangedAfterIntent.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-changed-after-intent-old-source',
      observedServingGeneration: 'reverse-changed-after-intent-old-serving',
      observedCacheGeneration: 'reverse-changed-after-intent-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    fs.appendFileSync(path.join(reverseChangedAfterIntent.candidate.path, 'stockboard.db'), 'changed-after-intent')
    assert.throws(() => executeDurableAtomicBundleReverse({
      journalPath: reverseChangedAfterIntent.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:06.000Z',
      observedSourceGeneration: 'reverse-changed-after-intent-old-source',
      observedServingGeneration: 'reverse-changed-after-intent-old-serving',
      observedCacheGeneration: 'reverse-changed-after-intent-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH/)

    const reverseWal = setupActivation(root, 'reverse-wal')
    forwardToSwapped({ journalPath: reverseWal.journalPath, executablePath: executable, executableSha256 })
    fs.writeFileSync(path.join(reverseWal.candidate.path, 'stockboard.db-wal'), 'unexpected-wal')
    assert.throws(() => sealDurableReverseIntent({
      journalPath: reverseWal.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-wal-old-source',
      observedServingGeneration: 'reverse-wal-old-serving',
      observedCacheGeneration: 'reverse-wal-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_UNEXPECTED_ENTRY/)

    const reverseShm = setupActivation(root, 'reverse-shm')
    forwardToSwapped({ journalPath: reverseShm.journalPath, executablePath: executable, executableSha256 })
    fs.writeFileSync(path.join(reverseShm.active.path, 'stockboard.db-shm'), 'unexpected-shm')
    assert.throws(() => sealDurableReverseIntent({
      journalPath: reverseShm.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-shm-old-source',
      observedServingGeneration: 'reverse-shm-old-serving',
      observedCacheGeneration: 'reverse-shm-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_UNEXPECTED_ENTRY/)

    const serviceReconnect = setupActivation(root, 'service-reconnect')
    const readers = ['web', 'analog', 'trigger'].map(() => new DatabaseSync(
      path.join(serviceReconnect.active.path, 'stockboard.db'), { readOnly: true },
    ))
    const assertNoServiceHandles = (): void => {
      if (readers.length > 0) throw new Error('fixture_reader_handle_present')
    }
    assert.throws(() => sealDurableSwapIntent({
      journalPath: serviceReconnect.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: assertNoServiceHandles,
    }), /fixture_reader_handle_present/)
    while (readers.length > 0) readers.pop()?.close()
    forwardToSwapped({ journalPath: serviceReconnect.journalPath, executablePath: executable, executableSha256 })
    const newReaders = ['web', 'analog', 'trigger'].map(() => new DatabaseSync(
      path.join(serviceReconnect.active.path, 'stockboard.db'), { readOnly: true },
    ))
    const assertNewReadersStopped = (): void => {
      if (newReaders.length > 0) throw new Error('fixture_new_reader_handle_present')
    }
    assert.throws(() => sealDurableReverseIntent({
      journalPath: serviceReconnect.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'service-reconnect-old-source',
      observedServingGeneration: 'service-reconnect-old-serving',
      observedCacheGeneration: 'service-reconnect-old-cache',
      assertReaderWriterBarrierValid: assertNewReadersStopped,
    }), /fixture_new_reader_handle_present/)
    while (newReaders.length > 0) newReaders.pop()?.close()
    sealDurableReverseIntent({
      journalPath: serviceReconnect.journalPath,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'service-reconnect-old-source',
      observedServingGeneration: 'service-reconnect-old-serving',
      observedCacheGeneration: 'service-reconnect-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    executeDurableAtomicBundleReverse({
      journalPath: serviceReconnect.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:06.000Z',
      observedSourceGeneration: 'service-reconnect-old-source',
      observedServingGeneration: 'service-reconnect-old-serving',
      observedCacheGeneration: 'service-reconnect-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    for (const service of ['web', 'analog', 'trigger']) {
      const reader = new DatabaseSync(path.join(serviceReconnect.active.path, 'stockboard.db'), { readOnly: true })
      assert.equal(
        String(reader.prepare('SELECT value FROM marker WHERE id=1').get()?.value),
        'service-reconnect-old',
        `${service} must reconnect to the restored old bundle`,
      )
      reader.close()
    }

    const invalidTransitionTime = setupActivation(root, 'invalid-transition-time')
    sealDurableSwapIntent({
      journalPath: invalidTransitionTime.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    })
    assert.throws(() => sealDurableReverseIntent({
      journalPath: invalidTransitionTime.journalPath,
      updatedAt: '2026-11-01T00:00:02.500Z',
      observedSourceGeneration: 'invalid-transition-time-old-source',
      observedServingGeneration: 'invalid-transition-time-old-serving',
      observedCacheGeneration: 'invalid-transition-time-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_REVERSE_INTENT_PRECONDITION_INVALID/)
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: invalidTransitionTime.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-10-31T23:59:59.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_ACTIVATION_TRANSITION_INVALID/)
    assert.equal(marker(invalidTransitionTime.active.path), 'invalid-transition-time-old')
    assert.equal(inspectInFreshProcess(script, invalidTransitionTime.journalPath).position, 'OLD_ACTIVE')

    const beforeCrash = setupActivation(root, 'before-crash')
    sealDurableSwapIntent({
      journalPath: beforeCrash.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    })
    assertKilled(spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-before-swap', beforeCrash.journalPath, executable,
    ], { encoding: 'utf8' }))
    assert.equal(inspectInFreshProcess(script, beforeCrash.journalPath).position, 'OLD_ACTIVE')
    assert.equal(readDurableActivationJournal(beforeCrash.journalPath).journal.phase, 'SWAP_INTENT')

    const afterCrash = setupActivation(root, 'after-crash')
    sealDurableSwapIntent({
      journalPath: afterCrash.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    })
    assertKilled(spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-after-swap', afterCrash.journalPath, executable,
    ], { encoding: 'utf8' }))
    const afterCrashRestart = inspectInFreshProcess(script, afterCrash.journalPath)
    assert.equal(afterCrashRestart.phase, 'SWAP_INTENT')
    assert.equal(afterCrashRestart.position, 'NEW_ACTIVE')
    assert.deepEqual(afterCrashRestart.durabilityIssues, [])
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: afterCrash.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:04.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID/)
    assert.throws(() => recordDurableGenerationReconciled({
      journalPath: afterCrash.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'after-crash-new-source',
      observedServingGeneration: 'after-crash-new-serving',
      observedCacheGeneration: 'after-crash-new-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_GENERATION_RECONCILE_PHASE_INVALID/)
    const restartObservation = inspectDurableAtomicBundleActivation({
      journalPath: afterCrash.journalPath,
      verifyByteIdentity: true,
    })
    const recoveryNow = new Date()
    const barrierReceiptSha256 = 'b'.repeat(64)
    const approvedRestart = restartApproval({
      observation: restartObservation,
      barrierReceiptSha256,
      now: recoveryNow,
    })
    const assertRecoveryRejected = (
      approval: AtomicBundleRecoveryApproval,
      suppliedBarrierReceiptSha256 = barrierReceiptSha256,
    ): void => {
      assert.throws(() => recordDurableSwapObservedAfterRestart({
        journalPath: afterCrash.journalPath,
        recoveryApproval: approval,
        recoveryApprovalSha256: atomicBundleRecoveryApprovalSha256(approval),
        barrierReceiptSha256: suppliedBarrierReceiptSha256,
        assertReaderWriterBarrierValid: () => {},
      }), /SQLITE_BUNDLE_RECOVERY_APPROVAL_MISMATCH/)
    }
    assert.throws(() => recordDurableSwapObservedAfterRestart({
      journalPath: afterCrash.journalPath,
      recoveryApproval: {} as AtomicBundleRecoveryApproval,
      recoveryApprovalSha256: 'invalid',
      barrierReceiptSha256,
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_RECOVERY_APPROVAL_MISMATCH/)
    assert.throws(() => recordDurableSwapObservedAfterRestart({
      journalPath: afterCrash.journalPath,
      recoveryApproval: approvedRestart.approval,
      recoveryApprovalSha256: 'd'.repeat(64),
      barrierReceiptSha256,
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_RECOVERY_APPROVAL_MISMATCH/)
    const approvalWithExtraKey = {
      ...approvedRestart.approval,
      unsealedAuthority: true,
    } as AtomicBundleRecoveryApproval
    assertRecoveryRejected(approvalWithExtraKey)
    assertRecoveryRejected({ ...approvedRestart.approval, transactionId: 'unrelated-transaction' })
    assertRecoveryRejected(approvedRestart.approval, 'c'.repeat(64))
    assertRecoveryRejected({ ...approvedRestart.approval, journalFileSha256: 'c'.repeat(64) })
    assertRecoveryRejected({ ...approvedRestart.approval, oldManifestSha256: 'c'.repeat(64) })
    assertRecoveryRejected({ ...approvedRestart.approval, activeIntegrityReceiptSha256: 'c'.repeat(64) })
    assertRecoveryRejected({
      ...approvedRestart.approval,
      automaticSwapAllowed: true,
    } as unknown as AtomicBundleRecoveryApproval)
    assertRecoveryRejected({
      ...approvedRestart.approval,
      action: 'UNAPPROVED_ACTION',
    } as unknown as AtomicBundleRecoveryApproval)
    assertRecoveryRejected({ ...approvedRestart.approval, reason: '' })
    assertRecoveryRejected({ ...approvedRestart.approval, issuedAt: 'invalid' })
    const expiredApproval = restartApproval({
      observation: restartObservation,
      barrierReceiptSha256,
      issuedAt: new Date(recoveryNow.getTime() - 20 * 60 * 1000).toISOString(),
      expiresAt: new Date(recoveryNow.getTime() - 5 * 60 * 1000).toISOString(),
    })
    assertRecoveryRejected(expiredApproval.approval)
    const futureApproval = restartApproval({
      observation: restartObservation,
      barrierReceiptSha256,
      issuedAt: new Date(recoveryNow.getTime() + 60_000).toISOString(),
      expiresAt: new Date(recoveryNow.getTime() + 10 * 60 * 1000).toISOString(),
    })
    assertRecoveryRejected(futureApproval.approval)
    const overlongApproval = restartApproval({
      observation: restartObservation,
      barrierReceiptSha256,
      issuedAt: new Date(recoveryNow.getTime() - 1_000).toISOString(),
      expiresAt: new Date(recoveryNow.getTime() + 15 * 60 * 1000).toISOString(),
    })
    assertRecoveryRejected(overlongApproval.approval)
    const markersBeforeRestartRecord = [marker(afterCrash.active.path), marker(afterCrash.candidate.path)]
    const restartRecorded = recordDurableSwapObservedAfterRestart({
      journalPath: afterCrash.journalPath,
      recoveryApproval: approvedRestart.approval,
      recoveryApprovalSha256: approvedRestart.approvalSha256,
      barrierReceiptSha256,
      assertReaderWriterBarrierValid: () => {},
    })
    assert.equal(restartRecorded.journal.phase, 'SWAPPED')
    assert.equal(restartRecorded.journal.recoveryApprovalSha256, approvedRestart.approvalSha256)
    assert.deepEqual(
      [marker(afterCrash.active.path), marker(afterCrash.candidate.path)],
      markersBeforeRestartRecord,
    )

    const reverseBeforeCrash = setupActivation(root, 'reverse-before-crash')
    forwardToSwapped({ journalPath: reverseBeforeCrash.journalPath, executablePath: executable, executableSha256 })
    sealDurableReverseIntent({
      journalPath: reverseBeforeCrash.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'reverse-before-crash-old-source',
      observedServingGeneration: 'reverse-before-crash-old-serving',
      observedCacheGeneration: 'reverse-before-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assertKilled(spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-before-reverse', reverseBeforeCrash.journalPath, executable,
      'reverse-before-crash-old-source', 'reverse-before-crash-old-serving', 'reverse-before-crash-old-cache',
    ], { encoding: 'utf8' }))
    const reverseBeforeRestart = inspectInFreshProcess(script, reverseBeforeCrash.journalPath)
    assert.equal(reverseBeforeRestart.phase, 'REVERSE_INTENT')
    assert.equal(reverseBeforeRestart.position, 'NEW_ACTIVE')

    const reverseAfterCrash = setupActivation(root, 'reverse-after-crash')
    forwardToSwapped({ journalPath: reverseAfterCrash.journalPath, executablePath: executable, executableSha256 })
    sealDurableReverseIntent({
      journalPath: reverseAfterCrash.journalPath,
      updatedAt: '2026-11-01T00:00:04.000Z',
      observedSourceGeneration: 'reverse-after-crash-old-source',
      observedServingGeneration: 'reverse-after-crash-old-serving',
      observedCacheGeneration: 'reverse-after-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assertKilled(spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-after-reverse', reverseAfterCrash.journalPath, executable,
      'reverse-after-crash-old-source', 'reverse-after-crash-old-serving', 'reverse-after-crash-old-cache',
    ], { encoding: 'utf8' }))
    const reverseAfterRestart = inspectDurableAtomicBundleActivation({
      journalPath: reverseAfterCrash.journalPath,
      verifyByteIdentity: true,
    })
    assert.equal(reverseAfterRestart.journal.phase, 'REVERSE_INTENT')
    assert.equal(reverseAfterRestart.position, 'OLD_ACTIVE')
    assert.throws(() => executeDurableAtomicBundleReverse({
      journalPath: reverseAfterCrash.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:05.000Z',
      observedSourceGeneration: 'reverse-after-crash-old-source',
      observedServingGeneration: 'reverse-after-crash-old-serving',
      observedCacheGeneration: 'reverse-after-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_REVERSE_PRECONDITION_INVALID/)
    const reverseBarrierReceiptSha256 = 'e'.repeat(64)
    const approvedReverseRestart = reverseRestartApproval({
      observation: reverseAfterRestart,
      barrierReceiptSha256: reverseBarrierReceiptSha256,
    })
    assert.throws(() => recordDurableReverseObservedAfterRestart({
      journalPath: reverseAfterCrash.journalPath,
      recoveryApproval: {
        ...approvedReverseRestart.approval,
        action: 'RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP',
      },
      recoveryApprovalSha256: approvedReverseRestart.approvalSha256,
      barrierReceiptSha256: reverseBarrierReceiptSha256,
      observedSourceGeneration: 'reverse-after-crash-old-source',
      observedServingGeneration: 'reverse-after-crash-old-serving',
      observedCacheGeneration: 'reverse-after-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_RECOVERY_APPROVAL_MISMATCH/)
    const recordedReverse = recordDurableReverseObservedAfterRestart({
      journalPath: reverseAfterCrash.journalPath,
      recoveryApproval: approvedReverseRestart.approval,
      recoveryApprovalSha256: approvedReverseRestart.approvalSha256,
      barrierReceiptSha256: reverseBarrierReceiptSha256,
      observedSourceGeneration: 'reverse-after-crash-old-source',
      observedServingGeneration: 'reverse-after-crash-old-serving',
      observedCacheGeneration: 'reverse-after-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    })
    assert.equal(recordedReverse.journal.phase, 'PRE_CONSUMER_REVERSED')
    assert.equal(recordedReverse.position, 'OLD_ACTIVE')
    assert.equal(marker(reverseAfterCrash.active.path), 'reverse-after-crash-old')
    assert.throws(() => recordDurableReverseObservedAfterRestart({
      journalPath: reverseAfterCrash.journalPath,
      recoveryApproval: approvedReverseRestart.approval,
      recoveryApprovalSha256: approvedReverseRestart.approvalSha256,
      barrierReceiptSha256: reverseBarrierReceiptSha256,
      observedSourceGeneration: 'reverse-after-crash-old-source',
      observedServingGeneration: 'reverse-after-crash-old-serving',
      observedCacheGeneration: 'reverse-after-crash-old-cache',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_REVERSE_RESTART_OBSERVATION_PRECONDITION_INVALID/)

    const timeout = setupActivation(root, 'timeout')
    sealDurableSwapIntent({
      journalPath: timeout.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    })
    const slowExecutable = path.join(root, 'slow-swap')
    fs.writeFileSync(slowExecutable, '#!/bin/sh\nwhile :; do :; done\n', { mode: 0o700 })
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: timeout.journalPath,
      executablePath: slowExecutable,
      executableSha256: sha256File(slowExecutable),
      timeoutMs: 20,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_SWAP_FAILED/)
    const timeoutRestart = inspectInFreshProcess(script, timeout.journalPath)
    assert.equal(timeoutRestart.phase, 'SWAP_INTENT')
    assert.equal(timeoutRestart.position, 'OLD_ACTIVE')

    const fsyncFailure = setupActivation(root, 'fsync-failure')
    assert.throws(() => sealDurableSwapIntent({
      journalPath: fsyncFailure.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
      checkpoint: (checkpoint) => {
        if (checkpoint === 'JOURNAL_DIRECTORY_FSYNC') throw new Error('simulated_directory_fsync_failure')
      },
    }), /simulated_directory_fsync_failure/)
    const fsyncRestart = inspectInFreshProcess(script, fsyncFailure.journalPath)
    assert.equal(fsyncRestart.phase, 'SWAP_INTENT')
    assert.equal(fsyncRestart.position, 'OLD_ACTIVE')
    assert.deepEqual(fsyncRestart.durabilityIssues, ['PENDING_WRITE_INTENT_PRESENT'])
    const publishedPending = classifyDurableActivationArtifacts({
      journalPath: fsyncFailure.journalPath,
      checkedAt: '2026-11-01T00:00:02.500Z',
    })
    assert.equal(publishedPending.classification, 'PUBLISHED_PENDING_CLEANUP')
    assert.equal(publishedPending.destructiveActionAllowed, false)
    assert.doesNotThrow(() => assertDurableActivationArtifactClassification(publishedPending))
    assert.throws(() => assertDurableActivationArtifactClassification({
      ...publishedPending,
      classification: 'CLEAN',
    }), /SQLITE_BUNDLE_ARTIFACT_CLASSIFICATION_INVALID/)
    const { receiptSha256: _publishedReceiptSha256, ...publishedBody } = publishedPending
    const forgedPublished = {
      ...publishedBody,
      classification: 'CLEAN' as const,
    }
    assert.throws(() => assertDurableActivationArtifactClassification({
      ...forgedPublished,
      receiptSha256: stableSha256(forgedPublished),
    }), /SQLITE_BUNDLE_ARTIFACT_CLASSIFICATION_INVALID/)
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: fsyncFailure.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID/)

    const unpublishedCrash = setupActivation(root, 'unpublished-crash')
    assertKilled(spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-seal-checkpoint', unpublishedCrash.journalPath,
      '2026-11-01T00:00:02.000Z', 'JOURNAL_FILE_FSYNC',
    ], { encoding: 'utf8' }))
    const unpublishedArtifacts = classifyDurableActivationArtifacts({
      journalPath: unpublishedCrash.journalPath,
      checkedAt: '2026-11-01T00:00:02.500Z',
    })
    assert.equal(unpublishedArtifacts.classification, 'WRITE_NOT_PUBLISHED')
    assert.equal(unpublishedArtifacts.temporaries.length, 1)
    assert.equal(unpublishedArtifacts.destructiveActionAllowed, false)
    fs.chmodSync(`${unpublishedCrash.journalPath}.pending`, 0o666)
    assert.equal(classifyDurableActivationArtifacts({
      journalPath: unpublishedCrash.journalPath,
      checkedAt: '2026-11-01T00:00:02.750Z',
    }).classification, 'AMBIGUOUS')

    const corruptTemporary = setupActivation(root, 'corrupt-temporary')
    fs.writeFileSync(`${corruptTemporary.journalPath}.tmp-corrupt`, '{not-json}\n', { mode: 0o600 })
    assert.equal(classifyDurableActivationArtifacts({
      journalPath: corruptTemporary.journalPath,
      checkedAt: '2026-11-01T00:00:02.500Z',
    }).classification, 'AMBIGUOUS')

    const danglingPending = setupActivation(root, 'dangling-pending')
    fs.symlinkSync(path.join(root, 'missing-pending-target'), `${danglingPending.journalPath}.pending`)
    const danglingClassification = classifyDurableActivationArtifacts({
      journalPath: danglingPending.journalPath,
      checkedAt: '2026-11-01T00:00:02.500Z',
    })
    assert.equal(danglingClassification.classification, 'AMBIGUOUS')
    assert.equal(danglingClassification.pendingArtifactPresent, true)
    assert.equal(danglingClassification.pendingArtifactValid, false)
    assert.deepEqual(
      readDurableActivationJournal(danglingPending.journalPath).durabilityIssues,
      ['PENDING_WRITE_INTENT_PRESENT'],
    )

    const concurrent = setupActivation(root, 'concurrent')
    let concurrentRejected = false
    const firstIntent = sealDurableSwapIntent({
      journalPath: concurrent.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
      checkpoint: (checkpoint) => {
        if (checkpoint !== 'PENDING_LOCK_ACQUIRED') return
        assert.throws(() => sealDurableSwapIntent({
          journalPath: concurrent.journalPath,
          updatedAt: '2026-11-01T00:00:02.500Z',
          assertReaderWriterBarrierValid: () => {},
        }), /SQLITE_BUNDLE_DURABLE_SWAP_INTENT_PRECONDITION_INVALID/)
        concurrentRejected = true
      },
    })
    assert.equal(concurrentRejected, true)
    assert.equal(firstIntent.journal.phase, 'SWAP_INTENT')
    assert.throws(() => sealDurableSwapIntent({
      journalPath: concurrent.journalPath,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_SWAP_INTENT_PRECONDITION_INVALID/)

    const processRace = setupActivation(root, 'process-race')
    const raceReady = path.join(root, 'process-race-ready')
    const raceContended = path.join(root, 'process-race-contended')
    const raceResultA = path.join(root, 'process-race-result-a')
    const raceResultB = path.join(root, 'process-race-result-b')
    const raceChildA = spawn(process.execPath, [
      '--import', 'tsx', script, '--race-seal-winner', processRace.journalPath,
      '2026-11-01T00:00:02.000Z', raceReady, raceContended, raceResultA,
    ], { stdio: 'ignore' })
    const raceChildB = spawn(process.execPath, [
      '--import', 'tsx', script, '--race-seal-loser', processRace.journalPath,
      '2026-11-01T00:00:02.500Z', raceReady, raceContended, raceResultB,
    ], { stdio: 'ignore' })
    await Promise.all([waitForChild(raceChildA), waitForChild(raceChildB)])
    const raceResults = [raceResultA, raceResultB]
      .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { status: string; error?: string })
    assert.equal(raceResults.filter((row) => row.status === 'SUCCESS').length, 1)
    assert.equal(raceResults.filter((row) => row.status === 'REJECTED').length, 1)
    assert.match(
      raceResults.find((row) => row.status === 'REJECTED')?.error ?? '',
      /EEXIST|SQLITE_BUNDLE_DURABLE_SWAP_INTENT_PRECONDITION_INVALID/,
    )
    assert.equal(readDurableActivationJournal(processRace.journalPath).journal.phase, 'SWAP_INTENT')

    const processCas = setupActivation(root, 'process-cas')
    const casReady = path.join(root, 'process-cas-ready')
    const casGate = path.join(root, 'process-cas-go')
    const casWriterResult = path.join(root, 'process-cas-writer-result')
    const casAttackerResult = path.join(root, 'process-cas-attacker-result')
    const casWriter = spawn(process.execPath, [
      '--import', 'tsx', script, '--race-cas-seal', processCas.journalPath,
      '2026-11-01T00:00:02.000Z', casReady, casGate, casWriterResult,
    ])
    const casAttacker = spawn(process.execPath, [
      '--import', 'tsx', script, '--displace-journal', processCas.journalPath,
      '2026-11-01T00:00:01.500Z', casReady, casGate, casAttackerResult,
    ])
    await Promise.all([waitForChild(casWriter), waitForChild(casAttacker)])
    const casWriterOutcome = JSON.parse(fs.readFileSync(casWriterResult, 'utf8')) as {
      status: string; error: string
    }
    assert.equal(casWriterOutcome.status, 'REJECTED')
    assert.match(casWriterOutcome.error, /SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH/)
    assert.equal(readDurableActivationJournal(processCas.journalPath).journal.phase, 'HOLD')
    assert.equal(classifyDurableActivationArtifacts({
      journalPath: processCas.journalPath,
      checkedAt: '2026-11-01T00:00:02.500Z',
    }).classification, 'AMBIGUOUS')

    const staleCas = setupActivation(root, 'stale-cas')
    assert.throws(() => sealDurableSwapIntent({
      journalPath: staleCas.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
      checkpoint: (checkpoint) => {
        if (checkpoint !== 'PENDING_LOCK_ACQUIRED') return
        const current = readDurableActivationJournal(staleCas.journalPath).journal
        const displaced = advanceAtomicBundleActivationJournal(
          current, 'HOLD', '2026-11-01T00:00:01.500Z',
        )
        fs.writeFileSync(staleCas.journalPath, `${JSON.stringify(displaced, null, 2)}\n`)
      },
    }), /SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH/)
    assert.equal(fs.existsSync(`${staleCas.journalPath}.pending`), false)
    assert.equal(readDurableActivationJournal(staleCas.journalPath).journal.phase, 'HOLD')

    const initialLockRoot = path.join(root, 'initial-lock-state')
    fs.mkdirSync(initialLockRoot)
    const initialLockActive = createSealedBundle(
      root, 'initial-lock-active', 'initial-lock-old', 'initial-lock-old', 'initial-lock-old-transaction',
    )
    const initialLockCandidate = createSealedBundle(
      root, 'initial-lock-candidate', 'initial-lock-new', 'initial-lock-new', 'initial-lock-new-transaction',
    )
    const initialLockPath = path.join(initialLockRoot, 'activation.json')
    const initialLockJournal = createAtomicBundleActivationJournal({
      transactionId: initialLockCandidate.manifest.transactionId,
      activePath: initialLockActive.path,
      candidatePath: initialLockCandidate.path,
      oldManifestSha256: initialLockActive.manifest.manifestSha256,
      newManifestSha256: initialLockCandidate.manifest.manifestSha256,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    let exclusiveCreateRejected = false
    persistInitialDurableActivationJournal({
      journalPath: initialLockPath,
      journal: initialLockJournal,
      checkpoint: (checkpoint) => {
        if (checkpoint !== 'PENDING_LOCK_ACQUIRED') return
        assert.throws(() => persistInitialDurableActivationJournal({
          journalPath: initialLockPath,
          journal: initialLockJournal,
        }), /EEXIST/)
        exclusiveCreateRejected = true
      },
    })
    assert.equal(exclusiveCreateRejected, true)

    const noReplaceRoot = path.join(root, 'no-replace-state')
    fs.mkdirSync(noReplaceRoot)
    const noReplacePath = path.join(noReplaceRoot, 'activation.json')
    const collisionBytes = '{"collision":true}\n'
    assert.throws(() => persistInitialDurableActivationJournal({
      journalPath: noReplacePath,
      journal: initialLockJournal,
      checkpoint: (checkpoint) => {
        if (checkpoint === 'JOURNAL_RENAME') fs.writeFileSync(noReplacePath, collisionBytes, { flag: 'wx' })
      },
    }), /EEXIST/)
    assert.equal(fs.readFileSync(noReplacePath, 'utf8'), collisionBytes)
    assert.equal(fs.existsSync(`${noReplacePath}.pending`), true)

    const partial = setupActivation(root, 'partial')
    fs.unlinkSync(path.join(partial.candidate.path, 'integrity-receipt.json'))
    assert.throws(() => inspectDurableAtomicBundleActivation({
      journalPath: partial.journalPath, verifyByteIdentity: false,
    }), /ENOENT/)

    const changedCandidate = setupActivation(root, 'changed-candidate')
    fs.appendFileSync(path.join(changedCandidate.candidate.path, 'stockboard.db'), 'changed-after-verification')
    assert.throws(() => sealDurableSwapIntent({
      journalPath: changedCandidate.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH/)

    const corruptJournal = setupActivation(root, 'corrupt-journal')
    const journal = readDurableActivationJournal(corruptJournal.journalPath).journal
    fs.writeFileSync(corruptJournal.journalPath, `${JSON.stringify({ ...journal, phase: 'COMMITTED' })}\n`)
    assert.throws(() => inspectDurableAtomicBundleActivation({
      journalPath: corruptJournal.journalPath, verifyByteIdentity: false,
    }), /SQLITE_BUNDLE_ACTIVATION_JOURNAL_INVALID/)

    const corruptReceipt = setupActivation(root, 'corrupt-receipt')
    const receiptPath = path.join(corruptReceipt.candidate.path, 'integrity-receipt.json')
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, cacheGeneration: 'tampered' })}\n`)
    assert.throws(() => inspectDurableAtomicBundleActivation({
      journalPath: corruptReceipt.journalPath, verifyByteIdentity: false,
    }), /SQLITE_BUNDLE_INTEGRITY_RECEIPT_(?:IDENTITY_)?MISMATCH/)

    const corruptQuickCheck = setupActivation(root, 'corrupt-quick-check')
    const quickCheckPath = path.join(corruptQuickCheck.candidate.path, 'sqlite-integrity-receipt.json')
    const quickCheck = JSON.parse(fs.readFileSync(quickCheckPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(quickCheckPath, `${JSON.stringify({ ...quickCheck, sourceGeneration: 'tampered' })}\n`)
    assert.throws(() => inspectDurableAtomicBundleActivation({
      journalPath: corruptQuickCheck.journalPath, verifyByteIdentity: false,
    }), /SQLITE_FULL_QUICK_CHECK_RECEIPT_MISMATCH/)

    const corruptManifest = setupActivation(root, 'corrupt-manifest')
    const manifestPath = path.join(corruptManifest.candidate.path, 'bundle.json')
    const manifest = readSqliteBundleManifest(corruptManifest.candidate.path)
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sourceGeneration: 'tampered' })}\n`)
    assert.throws(() => inspectDurableAtomicBundleActivation({
      journalPath: corruptManifest.journalPath, verifyByteIdentity: false,
    }), /SQLITE_BUNDLE_MANIFEST_INVALID/)

    const ambiguous = setupActivation(root, 'ambiguous')
    sealDurableSwapIntent({
      journalPath: ambiguous.journalPath,
      updatedAt: '2026-11-01T00:00:02.000Z',
      assertReaderWriterBarrierValid: () => {},
    })
    const unrelated = createSealedBundle(
      root, 'ambiguous-unrelated', 'unrelated', 'unrelated', 'unrelated-transaction',
    )
    const displace = spawnSync(executable, ['--swap', ambiguous.candidate.path, unrelated.path], { encoding: 'utf8' })
    assert.equal(displace.status, 0, displace.stderr)
    const ambiguousRestart = inspectInFreshProcess(script, ambiguous.journalPath)
    assert.equal(ambiguousRestart.position, 'AMBIGUOUS')
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: ambiguous.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID/)

    const wal = setupActivation(root, 'wal-transition')
    const walDatabase = new DatabaseSync(path.join(wal.candidate.path, 'stockboard.db'))
    try {
      assert.equal(String(walDatabase.prepare('PRAGMA journal_mode=WAL;').get()?.journal_mode), 'wal')
      walDatabase.exec("UPDATE marker SET value='wal-mutated';")
      assert.throws(() => sealDurableSwapIntent({
        journalPath: wal.journalPath,
        updatedAt: '2026-11-01T00:00:02.000Z',
        assertReaderWriterBarrierValid: () => {},
      }), /SQLITE_BUNDLE_UNEXPECTED_ENTRY|SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH/)
    } finally {
      walDatabase.close()
    }

    assert.equal(readSqliteBundleManifest(normal.active.path).manifestSha256, normal.candidate.manifest.manifestSha256)
    console.log(JSON.stringify({
      status: 'PASS',
      durableSwapIntentBeforeSwap: 'FSYNCED_AND_READ_BACK',
      crashBeforeSwap: 'OLD_ACTIVE',
      crashAfterSwap: 'NEW_ACTIVE',
      crashAfterSwapRecovery: 'APPROVAL_HASH_BOUND_SWAPPED',
      preConsumerReverse: 'PRE_CONSUMER_REVERSED_OLD_ACTIVE',
      crashBeforeReverse: 'REVERSE_INTENT_NEW_ACTIVE_HOLD_FOR_EXPLICIT_DECISION',
      crashAfterReverse: 'APPROVAL_HASH_BOUND_PRE_CONSUMER_REVERSED',
      committedReverse: 'REJECTED',
      reverseBarrier: 'WEB_ANALOG_TRIGGER_HANDLES_REJECTED',
      reverseSidecars: 'WAL_SHM_REJECTED',
      byteIdentityHashMismatch: 'REJECTED_WITH_METADATA_REBOUND',
      serviceReconnect: 'OLD_BUNDLE_REOPENED_BY_WEB_ANALOG_TRIGGER_FIXTURE',
      ambiguous: 'FAIL_CLOSED_NO_AUTOMATIC_SWAP',
      fsyncFailure: 'PENDING_WRITE_INTENT_FAIL_CLOSED',
      recoveryApproval: 'HASH_CONTRACT_BOUND_AUTHORITY_WIRING_PENDING',
      blockingArtifacts: 'READ_ONLY_CLASSIFIED_NO_DESTRUCTIVE_ACTION',
      concurrentJournalWriter: 'INDEPENDENT_PROCESS_EXCLUSIVE_PENDING_LOCK_AND_SECOND_CAS',
      integrityReceipt: 'EXISTING_FULL_CHECK_RECEIPT_AND_DB_WAL_SHM_GENERATIONS_BOUND',
      physicalPowerLoss: 'UNKNOWN',
    }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
