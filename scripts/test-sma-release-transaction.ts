import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WebAnalogReleaseTransaction,
  assertNoUncertainReleaseTransaction,
  type ReleaseTransactionIdentity,
  type ReleaseTransactionPaths,
  type ReleaseTransactionStage,
} from '@/lib/release/web-analog-transaction'

function hashTree(root: string): string {
  const digest = createHash('sha256')
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name)
      digest.update(path.relative(root, target))
      if (entry.isDirectory()) visit(target)
      else if (entry.isSymbolicLink()) digest.update(fs.readlinkSync(target))
      else digest.update(fs.readFileSync(target))
    }
  }
  visit(root)
  return digest.digest('hex')
}

function writeBuild(root: string, buildId: string, payload: string): void {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'BUILD_ID'), buildId)
  fs.writeFileSync(path.join(root, 'payload.txt'), payload)
}

function fixture(root = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-release-tx-')), initialize = true) {
  const oldRuntime = path.join(root, 'runtime-old', 'node_modules')
  const olderRuntime = path.join(root, 'runtime-older', 'node_modules')
  const candidateRuntime = path.join(root, 'runtime-candidate', 'node_modules')
  if (initialize) for (const runtime of [oldRuntime, olderRuntime, candidateRuntime]) fs.mkdirSync(runtime, { recursive: true })
  const artifact = path.join(root, 'artifact')
  const live = path.join(root, '.next-live')
  const previous = path.join(root, '.next-live-prev')
  if (initialize) {
    writeBuild(artifact, 'candidate-build', 'candidate')
    writeBuild(live, 'old-build', 'old')
    writeBuild(previous, 'older-build', 'older')
    fs.symlinkSync(oldRuntime, path.join(root, 'node_modules'))
    fs.symlinkSync(olderRuntime, path.join(root, '.node_modules-release-prev'))
  }
  const paths: ReleaseTransactionPaths = {
    releaseRoot: root,
    artifact,
    candidateRuntimeNodeModules: candidateRuntime,
    live,
    previous,
    stage: path.join(root, '.next-live-next'),
    nodeModules: path.join(root, 'node_modules'),
    runtimePrevious: path.join(root, '.node_modules-release-prev'),
    runtimeStage: path.join(root, '.node_modules-release-next'),
    journal: path.join(root, '.sma-release-journal.json'),
    lock: path.join(root, '.sma-release.lock'),
  }
  const identity: ReleaseTransactionIdentity = {
    candidateBuildId: 'candidate-build',
    candidateArtifactTreeSha256: '1'.repeat(64),
    candidateRuntimeIdentitySha256: '2'.repeat(64),
    rollbackBuildId: 'old-build',
    rollbackArtifactTreeSha256: '3'.repeat(64),
    rollbackRuntimeIdentitySha256: '4'.repeat(64),
    rollbackRuntimeNodeModulesTarget: oldRuntime,
  }
  return { root, paths, identity, oldRuntime, candidateRuntime, liveHash: initialize ? hashTree(live) : '' }
}

function transaction(run: ReturnType<typeof fixture>, failpoint?: (stage: ReleaseTransactionStage) => void) {
  return new WebAnalogReleaseTransaction({ paths: run.paths, identity: run.identity, failpoint, transactionId: 'fixture' })
}

if (process.argv[2] === '--crash-child') {
  const root = process.argv[3]
  const crashStage = process.argv[4] as ReleaseTransactionStage
  if (!root || !crashStage) throw new Error('crash child arguments missing')
  const run = fixture(root, false)
  const tx = transaction(run, (stage) => {
    if (stage === crashStage) process.kill(process.pid, 'SIGKILL')
  })
  tx.prepare()
  tx.markTargetsFrozen()
  tx.activate()
  tx.markServicesRestarted()
  process.exit(99)
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  tx.markTargetsFrozen()
  tx.activate()
  tx.markServicesRestarted()
  tx.commit()
  assert.equal(fs.readFileSync(path.join(run.paths.live, 'BUILD_ID'), 'utf8'), 'candidate-build')
  assert.equal(fs.readFileSync(path.join(run.paths.previous, 'BUILD_ID'), 'utf8'), 'old-build')
  assert.equal(path.resolve(run.root, fs.readlinkSync(run.paths.nodeModules)), run.candidateRuntime)
  assert.equal(path.resolve(run.root, fs.readlinkSync(run.paths.runtimePrevious)), run.oldRuntime)
  assert.equal(fs.existsSync(run.paths.journal), false)
  assert.equal(fs.existsSync(run.paths.lock), false)
  assert.ok(fs.readdirSync(run.root).some((name) => name.startsWith('.sma-release-journal.json.committed-')))
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  tx.markTargetsFrozen()
  tx.activate()
  assert.throws(() => tx.rollback(() => { throw new Error('restored_tree_hash_mismatch') }), /restored_tree_hash_mismatch/)
  assert.equal(hashTree(run.paths.live), run.liveHash, 'the old generation must still be restored before verification')
  const journal = JSON.parse(fs.readFileSync(run.paths.journal, 'utf8')) as { stage: string; error?: string }
  assert.equal(journal.stage, 'ROLLBACK_FAILED')
  assert.match(journal.error ?? '', /restored_tree_hash_mismatch/)
  assert.ok(fs.existsSync(run.paths.lock), 'failed rollback verification must retain the release lock')
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  tx.assertOwnedState('PREPARED')
  assert.throws(() => tx.assertOwnedState('TARGETS_FROZEN'), /owned_stage_mismatch/)
  fs.writeFileSync(run.paths.lock, `${JSON.stringify({ transactionId: 'foreign', pid: process.pid, startedAt: new Date().toISOString() })}\n`)
  assert.throws(() => tx.assertOwnedState('PREPARED'), /owned_lock_mismatch/)
  tx.rollback()
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  assert.equal(tx.rollback(), false)
  assert.equal(hashTree(run.paths.live), run.liveHash)
  assert.equal(path.resolve(run.root, fs.readlinkSync(run.paths.nodeModules)), run.oldRuntime)
  assert.equal(fs.existsSync(run.paths.stage), false)
  assert.equal(fs.existsSync(run.paths.journal), false)
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  tx.markTargetsFrozen()
  tx.activate()
  assert.equal(tx.rollback(), true)
  assert.equal(hashTree(run.paths.live), run.liveHash)
  assert.equal(path.resolve(run.root, fs.readlinkSync(run.paths.nodeModules)), run.oldRuntime)
  assert.equal(fs.readFileSync(path.join(run.paths.previous, 'BUILD_ID'), 'utf8'), 'older-build')
  assert.equal(fs.existsSync(run.paths.journal), false)
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const first = transaction(run)
  first.prepare()
  const foreign = transaction(run)
  assert.throws(() => foreign.prepare(), /journal_requires_manual_recovery|lock_requires_manual_recovery/)
  assert.equal(foreign.ownsMutableState(), false, 'a foreign journal or lock must never become locally recoverable')
  first.rollback()
  fs.rmSync(run.root, { recursive: true })
}

const crashStages: ReleaseTransactionStage[] = [
  'PREPARING',
  'PREPARED',
  'TARGETS_FROZEN',
  'PREVIOUS_RETIRED',
  'LIVE_MOVED',
  'ARTIFACT_ACTIVE',
  'RUNTIME_MOVED',
  'GENERATION_ACTIVE',
  'SERVICES_RESTARTED',
]
for (const crashStage of crashStages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sma-release-crash-${crashStage.toLowerCase()}-`))
  const run = fixture(root)
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--crash-child', root, crashStage], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(child.signal, 'SIGKILL', `${crashStage}: ${child.stderr}`)
  assert.ok(fs.existsSync(run.paths.journal), `${crashStage}: journal missing`)
  assert.ok(fs.existsSync(run.paths.lock), `${crashStage}: lock missing`)
  assert.throws(() => assertNoUncertainReleaseTransaction(run.paths), /requires_manual_recovery/)
  const recovery = WebAnalogReleaseTransaction.loadForExplicitRecovery(run.paths.journal)
  recovery.rollback()
  assert.equal(hashTree(run.paths.live), run.liveHash, `${crashStage}: live generation not restored`)
  assert.equal(path.resolve(run.root, fs.readlinkSync(run.paths.nodeModules)), run.oldRuntime, `${crashStage}: runtime not restored`)
  assert.equal(fs.existsSync(run.paths.lock), false)
  fs.rmSync(root, { recursive: true })
}

{
  const run = fixture()
  fs.writeFileSync(run.paths.journal, '{"version":1')
  assert.throws(() => WebAnalogReleaseTransaction.loadForExplicitRecovery(run.paths.journal), SyntaxError)
  assert.throws(() => assertNoUncertainReleaseTransaction(run.paths), /journal_requires_manual_recovery/)
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  fs.writeFileSync(`${run.paths.journal}.tmp-999`, 'partial')
  assert.throws(() => assertNoUncertainReleaseTransaction(run.paths), /partial_journal_requires_manual_recovery/)
  fs.rmSync(run.root, { recursive: true })
}

{
  const run = fixture()
  const tx = transaction(run)
  tx.prepare()
  tx.markTargetsFrozen()
  tx.activate()
  fs.rmSync(run.paths.previous, { recursive: true })
  assert.throws(() => tx.rollback(), /rollback_build_mismatch/)
  const journal = JSON.parse(fs.readFileSync(run.paths.journal, 'utf8')) as { stage: string }
  assert.equal(journal.stage, 'ROLLBACK_FAILED')
  assert.ok(fs.existsSync(run.paths.lock))
  fs.rmSync(run.root, { recursive: true })
}

console.log('test-sma-release-transaction: ok')
