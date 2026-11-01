import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  advanceAtomicBundleActivationJournal,
  assertActiveBundlePublication,
  assertSqliteBundleManifest,
  classifyAtomicBundlePosition,
  createAtomicBundleActivationJournal,
  createSqliteBundleManifest,
  executeAtomicBundleSwap,
  type SqliteBundleManifest,
} from '@/lib/storage/apfs-atomic-sqlite-bundle'

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
  const source = path.resolve('scripts/native/apfs-rename-swap.c')
  const result = spawnSync('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`atomic_bundle_helper_compile_failed:${result.error?.message ?? result.stderr}`)
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

function createBundle(root: string, directory: string, value: string, generation: string): {
  path: string
  manifest: SqliteBundleManifest
} {
  const bundlePath = path.join(root, directory)
  fs.mkdirSync(bundlePath)
  createDatabase(path.join(bundlePath, 'stockboard.db'), value)
  const manifest = createSqliteBundleManifest({
    bundlePath,
    bundleId: `${directory}-bundle`,
    transactionId: 'fixture-atomic-activation',
    createdAt: '2026-11-01T00:00:00.000Z',
    sourceGeneration: `${generation}-source`,
    servingGeneration: `${generation}-serving`,
    journalMode: 'delete',
    integrityReceiptSha256: generation === 'old' ? 'a'.repeat(64) : 'b'.repeat(64),
  })
  fs.writeFileSync(path.join(bundlePath, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return { path: bundlePath, manifest }
}

function loadManifest(bundlePath: string): SqliteBundleManifest {
  return JSON.parse(fs.readFileSync(path.join(bundlePath, 'bundle.json'), 'utf8')) as SqliteBundleManifest
}

function activationIntent(input: {
  activePath: string
  candidatePath: string
  activeManifest: SqliteBundleManifest
  candidateManifest: SqliteBundleManifest
}): ReturnType<typeof createAtomicBundleActivationJournal> {
  const prepared = createAtomicBundleActivationJournal({
    transactionId: input.activeManifest.transactionId,
    activePath: input.activePath,
    candidatePath: input.candidatePath,
    oldManifestSha256: input.activeManifest.manifestSha256,
    newManifestSha256: input.candidateManifest.manifestSha256,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  return advanceAtomicBundleActivationJournal(prepared, 'SWAP_INTENT', '2026-11-01T00:00:01.000Z')
}

function helperSwap(executable: string, left: string, right: string): void {
  const result = spawnSync(executable, ['--swap', left, right], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`fixture_swap_failed:${result.error?.message ?? result.stderr}`)
  }
}

function marker(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return String(database.prepare('SELECT value FROM marker WHERE id=1').get()?.value)
  } finally {
    database.close()
  }
}

function runCrashChild(): never {
  const [, , mode, executable, activePath, candidatePath] = process.argv
  if (!['--crash-before-swap', '--crash-after-swap'].includes(mode)) {
    throw new Error('fixture_crash_mode_invalid')
  }
  const activeManifest = loadManifest(activePath)
  const candidateManifest = loadManifest(candidatePath)
  const journal = activationIntent({
    activePath,
    candidatePath,
    activeManifest,
    candidateManifest,
  })
  let barrierChecks = 0
  executeAtomicBundleSwap({
    journal,
    activeManifest,
    candidateManifest,
    executablePath: executable,
    executableSha256: sha256File(executable),
    timeoutMs: 30_000,
    assertReaderWriterBarrierValid: () => {
      barrierChecks += 1
      if ((mode === '--crash-before-swap' && barrierChecks === 1)
        || (mode === '--crash-after-swap' && barrierChecks === 2)) {
        process.kill(process.pid, 'SIGKILL')
      }
    },
  })
  throw new Error('unreachable')
}

function assertKilled(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.status, null)
}

async function main(): Promise<void> {
  if (process.argv[2]?.startsWith('--crash-')) runCrashChild()
  const configuredRoot = process.env.STOCKBOARD_ATOMIC_BUNDLE_TEST_ROOT
  const parent = configuredRoot ? fs.realpathSync(configuredRoot) : fs.realpathSync(os.tmpdir())
  assert.doesNotMatch(parent, /^\/Volumes\/OWC Express 1M2 80G(?:\/|$)/)
  const root = fs.mkdtempSync(path.join(parent, 'stockboard-atomic-bundle-'))
  const startedAt = Date.now()
  try {
    const executable = compileHelper(root)
    const helperSha256 = sha256File(executable)
    const probe = spawnSync(executable, ['--probe', root], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)

    const active = createBundle(root, 'active', 'old', 'old')
    const candidate = createBundle(root, 'candidate', 'new', 'new')
    const intent = activationIntent({
      activePath: active.path,
      candidatePath: candidate.path,
      activeManifest: active.manifest,
      candidateManifest: candidate.manifest,
    })
    assert.equal(classifyAtomicBundlePosition({
      journal: intent,
      activeManifest: active.manifest,
      candidateManifest: candidate.manifest,
    }), 'OLD_ACTIVE')
    assert.throws(() => advanceAtomicBundleActivationJournal(
      createAtomicBundleActivationJournal({
        transactionId: intent.transactionId,
        activePath: intent.activePath,
        candidatePath: intent.candidatePath,
        oldManifestSha256: intent.oldManifestSha256,
        newManifestSha256: intent.newManifestSha256,
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
      }),
      'COMMITTED',
      '2026-11-01T00:00:02.000Z',
    ), /SQLITE_BUNDLE_ACTIVATION_TRANSITION_INVALID/)
    assert.throws(() => createAtomicBundleActivationJournal({
      transactionId: intent.transactionId,
      activePath: intent.activePath,
      candidatePath: intent.candidatePath,
      oldManifestSha256: intent.oldManifestSha256,
      newManifestSha256: intent.oldManifestSha256,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    }), /SQLITE_BUNDLE_ACTIVATION_JOURNAL_INVALID/)

    const rejectedActive = createBundle(root, 'rejected-active', 'rejected-old', 'rejected-old')
    const rejectedCandidate = createBundle(root, 'rejected-candidate', 'rejected-new', 'rejected-new')
    const rejectedIntent = activationIntent({
      activePath: rejectedActive.path,
      candidatePath: rejectedCandidate.path,
      activeManifest: rejectedActive.manifest,
      candidateManifest: rejectedCandidate.manifest,
    })
    fs.writeFileSync(path.join(rejectedCandidate.path, 'bundle.json'), `${JSON.stringify({
      ...rejectedCandidate.manifest, sourceGeneration: 'tampered',
    })}\n`)
    assert.throws(() => executeAtomicBundleSwap({
      journal: rejectedIntent,
      activeManifest: rejectedActive.manifest,
      candidateManifest: rejectedCandidate.manifest,
      executablePath: executable,
      executableSha256: helperSha256,
      timeoutMs: 30_000,
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_ON_DISK_MANIFEST_MISMATCH/)
    assert.equal(marker(path.join(rejectedActive.path, 'stockboard.db')), 'rejected-old')

    let barrierChecks = 0
    const swap = executeAtomicBundleSwap({
      journal: intent,
      activeManifest: active.manifest,
      candidateManifest: candidate.manifest,
      executablePath: executable,
      executableSha256: helperSha256,
      timeoutMs: 30_000,
      assertReaderWriterBarrierValid: () => { barrierChecks += 1 },
    })
    assert.equal(swap.position, 'NEW_ACTIVE')
    assert.equal(barrierChecks, 2)
    assert.equal(marker(path.join(active.path, 'stockboard.db')), 'new')
    assert.equal(marker(path.join(candidate.path, 'stockboard.db')), 'old')

    const activeAfter = loadManifest(active.path)
    const candidateAfter = loadManifest(candidate.path)
    assert.equal(classifyAtomicBundlePosition({
      journal: intent, activeManifest: activeAfter, candidateManifest: candidateAfter,
    }), 'NEW_ACTIVE')
    const swapped = advanceAtomicBundleActivationJournal(intent, 'SWAPPED', '2026-11-01T00:00:02.000Z')
    const reconciled = advanceAtomicBundleActivationJournal(
      swapped, 'GENERATION_RECONCILED', '2026-11-01T00:00:03.000Z',
    )
    assertActiveBundlePublication({
      journal: reconciled,
      activeManifest: activeAfter,
      candidateManifest: candidateAfter,
      sourceGeneration: 'new-source',
      servingGeneration: 'new-serving',
      activeDatabaseHandleCount: 0,
    })
    assert.throws(() => assertActiveBundlePublication({
      journal: reconciled,
      activeManifest: activeAfter,
      candidateManifest: candidateAfter,
      sourceGeneration: 'old-source',
      servingGeneration: 'new-serving',
      activeDatabaseHandleCount: 0,
    }), /SQLITE_BUNDLE_PUBLICATION_NOT_RECONCILED/)
    assert.throws(() => assertActiveBundlePublication({
      journal: reconciled,
      activeManifest: activeAfter,
      candidateManifest: candidateAfter,
      sourceGeneration: 'new-source',
      servingGeneration: 'new-serving',
      activeDatabaseHandleCount: 1,
    }), /SQLITE_BUNDLE_PUBLICATION_NOT_RECONCILED/)

    // An open SQLite connection continues reading the old inode after the directory swap.
    const staleActive = createBundle(root, 'stale-active', 'stale-old', 'stale-old')
    const staleCandidate = createBundle(root, 'stale-candidate', 'stale-new', 'stale-new')
    const staleReader = new DatabaseSync(path.join(staleActive.path, 'stockboard.db'), { readOnly: true })
    try {
      helperSwap(executable, staleActive.path, staleCandidate.path)
      assert.equal(String(staleReader.prepare('SELECT value FROM marker WHERE id=1').get()?.value), 'stale-old')
      assert.equal(marker(path.join(staleActive.path, 'stockboard.db')), 'stale-new')
    } finally {
      staleReader.close()
    }

    const crashActive = createBundle(root, 'crash-active', 'crash-old', 'crash-old')
    const crashCandidate = createBundle(root, 'crash-candidate', 'crash-new', 'crash-new')
    const crashIntent = activationIntent({
      activePath: crashActive.path,
      candidatePath: crashCandidate.path,
      activeManifest: crashActive.manifest,
      candidateManifest: crashCandidate.manifest,
    })
    const script = fileURLToPath(import.meta.url)
    const crashBefore = spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-before-swap', executable, crashActive.path, crashCandidate.path,
    ], { encoding: 'utf8' })
    assertKilled(crashBefore)
    assert.equal(classifyAtomicBundlePosition({
      journal: crashIntent,
      activeManifest: loadManifest(crashActive.path),
      candidateManifest: loadManifest(crashCandidate.path),
    }), 'OLD_ACTIVE')
    const crashAfter = spawnSync(process.execPath, [
      '--import', 'tsx', script, '--crash-after-swap', executable, crashActive.path, crashCandidate.path,
    ], { encoding: 'utf8' })
    assertKilled(crashAfter)
    assert.equal(classifyAtomicBundlePosition({
      journal: crashIntent,
      activeManifest: loadManifest(crashActive.path),
      candidateManifest: loadManifest(crashCandidate.path),
    }), 'NEW_ACTIVE')

    const timeoutActive = createBundle(root, 'timeout-active', 'timeout-old', 'timeout-old')
    const timeoutCandidate = createBundle(root, 'timeout-candidate', 'timeout-new', 'timeout-new')
    const timeoutIntent = activationIntent({
      activePath: timeoutActive.path,
      candidatePath: timeoutCandidate.path,
      activeManifest: timeoutActive.manifest,
      candidateManifest: timeoutCandidate.manifest,
    })
    const slowExecutable = path.join(root, 'slow-swap')
    fs.writeFileSync(slowExecutable, '#!/bin/sh\nwhile :; do :; done\n', { mode: 0o700 })
    assert.throws(() => executeAtomicBundleSwap({
      journal: timeoutIntent,
      activeManifest: timeoutActive.manifest,
      candidateManifest: timeoutCandidate.manifest,
      executablePath: slowExecutable,
      executableSha256: sha256File(slowExecutable),
      timeoutMs: 20,
      assertReaderWriterBarrierValid: () => {},
    }), /SQLITE_BUNDLE_SWAP_FAILED/)
    assert.equal(classifyAtomicBundlePosition({
      journal: timeoutIntent,
      activeManifest: loadManifest(timeoutActive.path),
      candidateManifest: loadManifest(timeoutCandidate.path),
    }), 'OLD_ACTIVE')

    const tampered = { ...loadManifest(crashActive.path), sourceGeneration: 'tampered' }
    assert.throws(() => assertSqliteBundleManifest(crashActive.path, tampered), /SQLITE_BUNDLE_MANIFEST_INVALID/)
    const ambiguous = classifyAtomicBundlePosition({
      journal: intent,
      activeManifest: { ...activeAfter, manifestSha256: 'c'.repeat(64) },
      candidateManifest: candidateAfter,
    })
    assert.equal(ambiguous, 'AMBIGUOUS')

    const walBundle = createBundle(root, 'wal-bundle', 'wal-value', 'wal')
    assert.throws(() => createSqliteBundleManifest({
      bundlePath: walBundle.path,
      bundleId: 'wal-bundle-unsealed',
      transactionId: 'fixture-atomic-activation',
      createdAt: '2026-11-01T00:00:03.000Z',
      sourceGeneration: 'wal-source',
      servingGeneration: 'wal-serving',
      journalMode: 'wal',
      integrityReceiptSha256: 'd'.repeat(64),
    }), /SQLITE_BUNDLE_JOURNAL_MODE_MISMATCH/)
    const walDatabase = new DatabaseSync(path.join(walBundle.path, 'stockboard.db'))
    try {
      assert.equal(String(walDatabase.prepare('PRAGMA journal_mode=WAL;').get()?.journal_mode), 'wal')
      walDatabase.exec("UPDATE marker SET value='wal-value-2';")
      const walManifest = createSqliteBundleManifest({
        bundlePath: walBundle.path,
        bundleId: 'wal-bundle-resealed',
        transactionId: 'fixture-atomic-activation',
        createdAt: '2026-11-01T00:00:04.000Z',
        sourceGeneration: 'wal-source',
        servingGeneration: 'wal-serving',
        journalMode: 'wal',
        integrityReceiptSha256: 'd'.repeat(64),
      })
      assert.ok(walManifest.wal && walManifest.shm)
      assertSqliteBundleManifest(walBundle.path, walManifest)
    } finally {
      walDatabase.close()
    }
    assert.throws(() => assertSqliteBundleManifest(walBundle.path, walBundle.manifest),
      /SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH|SQLITE_BUNDLE_UNEXPECTED_ENTRY/)

    const extraSidecar = createBundle(root, 'extra-sidecar', 'extra-sidecar', 'extra-sidecar')
    fs.writeFileSync(path.join(extraSidecar.path, 'stockboard.db-journal'), 'unsealed')
    assert.throws(() => assertSqliteBundleManifest(extraSidecar.path, extraSidecar.manifest),
      /SQLITE_BUNDLE_UNEXPECTED_ENTRY/)

    const gitHead = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const gitStatus = spawnSync('/usr/bin/git', [
      'status', '--porcelain=v1', '--untracked-files=no',
    ], { encoding: 'utf8' }).stdout
    const harnessSource = fileURLToPath(import.meta.url)
    const receiptBody = {
      version: 1,
      kind: 'JP_OHLCV_ATOMIC_BUNDLE_FIXTURE',
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      sourceCommit: gitHead,
      trackedWorkingTreeStatusSha256: createHash('sha256').update(gitStatus).digest('hex'),
      runtime: {
        nodePath: process.execPath,
        nodeSha256: sha256File(process.execPath),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      rootFilesystem: 'APFS',
      rootDevice: String(fs.statSync(parent).dev),
      harnessSource,
      harnessSourceSha256: sha256File(harnessSource),
      helperSource: path.resolve('scripts/native/apfs-rename-swap.c'),
      helperSourceSha256: sha256File(path.resolve('scripts/native/apfs-rename-swap.c')),
      helperExecutableSha256: helperSha256,
      input: {
        oldManifestSha256: active.manifest.manifestSha256,
        newManifestSha256: candidate.manifest.manifestSha256,
        oldDatabaseSha256: active.manifest.database.sha256,
        newDatabaseSha256: candidate.manifest.database.sha256,
      },
      swapElapsedMs: swap.elapsedMs,
      invariants: {
        directoryEntrySwap: 'PASS',
        oldInodeReaderRetention: 'OBSERVED',
        crashBeforeSwap: 'OLD_ACTIVE',
        crashAfterSwap: 'NEW_ACTIVE',
        helperTimeoutBeforeSwap: 'OLD_ACTIVE',
        generationMismatch: 'REJECTED',
        unknownManifest: 'AMBIGUOUS_FAIL_CLOSED',
        tamperedOnDiskManifest: 'REJECTED_BEFORE_SWAP',
        deleteToWalTransition: 'REQUIRES_RESEAL_BEFORE_PUBLICATION',
      },
      limitations: [
        'fixture-scale evidence does not prove sudden-power-loss durability',
        'fixture-scale evidence does not prove OWC allocation, latency or ENOSPC behavior',
        'reader admission and external cache migration remain separate publication gates',
      ],
    }
    const receipt = { ...receiptBody, receiptSha256: stableSha256(receiptBody) }
    const evidencePath = process.env.STOCKBOARD_ATOMIC_BUNDLE_EVIDENCE_PATH
    if (evidencePath) fs.writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(receipt))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
