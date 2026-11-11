import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertReleaseRootBaselineStatus } from '@/lib/release/release-root-baseline'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-release-root-baseline-'))
try {
  const releaseRoot = path.join(temporary, 'release')
  const releaseState = path.join(temporary, 'state')
  const live = path.join(releaseRoot, '.next-live')
  const activeRuntime = path.join(temporary, 'active-runtime', 'node_modules')
  const oldRuntime = path.join(temporary, 'old-runtime', 'node_modules')
  const runtimePrevious = path.join(releaseRoot, '.node_modules-release-prev')
  const nodeModules = path.join(releaseRoot, 'node_modules')
  const transactionId = 'fixture-transaction'
  const journalBase = path.join(releaseState, 'sma-release-journal.json')
  const journalFile = `${journalBase}.committed-${transactionId}`
  const runtimeIdentitySha256 = 'a'.repeat(64)

  fs.mkdirSync(live, { recursive: true })
  fs.mkdirSync(releaseState, { recursive: true })
  fs.mkdirSync(activeRuntime, { recursive: true })
  fs.mkdirSync(oldRuntime, { recursive: true })
  fs.writeFileSync(path.join(live, 'BUILD_ID'), 'current-build\n')
  fs.symlinkSync(activeRuntime, nodeModules)
  fs.symlinkSync(oldRuntime, runtimePrevious)
  const journal = {
    version: 1,
    transactionId,
    stage: 'COMMITTED',
    candidate: { buildId: 'current-build' },
    rollback: { runtimeIdentitySha256, runtimeNodeModulesTarget: oldRuntime },
    paths: {
      releaseRoot,
      live,
      nodeModules,
      runtimePrevious,
      candidateRuntimeNodeModules: activeRuntime,
      journal: journalBase,
    },
  }
  fs.writeFileSync(journalFile, JSON.stringify(journal))

  assert.equal(assertReleaseRootBaselineStatus(releaseRoot, releaseState, ''), null)
  assert.deepEqual(
    assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    { target: fs.realpathSync(oldRuntime), runtimeIdentitySha256, journalFile },
  )

  const duplicateId = 'duplicate-transaction'
  const duplicateJournal = `${journalBase}.committed-${duplicateId}`
  fs.writeFileSync(duplicateJournal, JSON.stringify({ ...journal, transactionId: duplicateId }))
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_runner_owned_rollback_runtime_journal_mismatch:2/,
  )
  fs.unlinkSync(duplicateJournal)

  const malformedJournal = `${journalBase}.committed-malformed`
  fs.writeFileSync(malformedJournal, '{}')
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_committed_journal_invalid_contract/,
  )
  fs.unlinkSync(malformedJournal)

  for (const status of [
    ' M package.json',
    ' M .node_modules-release-prev',
    '?? unrelated-file',
    '?? .node_modules-release-prev/',
    '?? .node_modules-release-prev2',
    '?? .node_modules-release-prev\n?? unrelated-file',
    '?? .node_modules-release-prev\n?? .node_modules-release-prev',
  ]) {
    assert.throws(
      () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, status),
      /release_baseline_worktree_dirty/,
    )
  }

  fs.unlinkSync(runtimePrevious)
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_runner_owned_rollback_runtime_missing/,
  )
  fs.writeFileSync(runtimePrevious, 'not-a-link')
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_runner_owned_rollback_runtime_must_be_symlink/,
  )

  fs.unlinkSync(runtimePrevious)
  const internal = path.join(releaseRoot, 'node_modules-fixture')
  const externalAlias = path.join(temporary, 'external-alias')
  fs.mkdirSync(internal)
  fs.symlinkSync(internal, externalAlias)
  fs.symlinkSync(externalAlias, runtimePrevious)
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_runner_owned_rollback_runtime_must_be_external/,
  )

  fs.unlinkSync(runtimePrevious)
  const foreignRuntime = path.join(temporary, 'foreign-runtime', 'node_modules')
  fs.mkdirSync(foreignRuntime, { recursive: true })
  fs.symlinkSync(foreignRuntime, runtimePrevious)
  assert.throws(
    () => assertReleaseRootBaselineStatus(releaseRoot, releaseState, '?? .node_modules-release-prev'),
    /release_runner_owned_rollback_runtime_journal_mismatch:0/,
  )

  console.log('SMA release root repeat-deploy baseline: PASS')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
