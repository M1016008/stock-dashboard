import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAtomicBundleActivationJournal,
  createSqliteBundleManifest,
  readSqliteBundleManifest,
  type SqliteBundleManifest,
} from '@/lib/storage/apfs-atomic-sqlite-bundle'
import {
  assertDurableActivationGenerationConvergence,
  createSqliteBundleIntegrityReceipt,
  createSqliteFullQuickCheckReceipt,
  executeDurableAtomicBundleSwap,
  inspectDurableAtomicBundleActivation,
  persistInitialDurableActivationJournal,
  persistSqliteBundleIntegrityReceipt,
  persistSqliteFullQuickCheckReceipt,
  persistSqliteBundleManifest,
  readDurableActivationJournal,
  sealDurableSwapIntent,
} from '@/lib/storage/durable-atomic-bundle-activation'

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
  const fullQuickCheck = createSqliteFullQuickCheckReceipt({
    bundlePath,
    transactionId,
    bundleId: `${directory}-bundle`,
    completedAt: '2026-11-01T00:00:00.000Z',
    sourceGeneration: `${generation}-source`,
    servingGeneration: `${generation}-serving`,
    cacheGeneration: `${generation}-cache`,
    journalMode: 'delete',
    sqliteExecutableSha256: createHash('sha256').update('fixture-node-sqlite-executable').digest('hex'),
  })
  persistSqliteFullQuickCheckReceipt(bundlePath, fullQuickCheck)
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

function childMode(): never | void {
  const [mode, journalPath, executable] = process.argv.slice(2)
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
    assert.equal(barrierChecks, 6)
    assert.equal(marker(normal.active.path), 'normal-new')
    assert.deepEqual(inspectInFreshProcess(script, normal.journalPath), {
      phase: 'SWAPPED',
      position: 'NEW_ACTIVE',
      durabilityIssues: [],
      activeCacheGeneration: 'normal-new-cache',
    })

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
    assert.throws(() => executeDurableAtomicBundleSwap({
      journalPath: fsyncFailure.journalPath,
      executablePath: executable,
      executableSha256,
      timeoutMs: 30_000,
      updatedAt: '2026-11-01T00:00:03.000Z',
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID/)

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
    const quickCheckPath = path.join(corruptQuickCheck.candidate.path, 'full-quick-check-receipt.json')
    const quickCheck = JSON.parse(fs.readFileSync(quickCheckPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(quickCheckPath, `${JSON.stringify({ ...quickCheck, cacheGeneration: 'tampered' })}\n`)
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
      ambiguous: 'FAIL_CLOSED_NO_AUTOMATIC_SWAP',
      fsyncFailure: 'PENDING_WRITE_INTENT_FAIL_CLOSED',
      concurrentJournalWriter: 'FAIL_CLOSED_BEFORE_CAS',
      integrityReceipt: 'FULL_QUICK_CHECK_DB_WAL_SHM_SOURCE_SERVING_CACHE_BOUND',
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
