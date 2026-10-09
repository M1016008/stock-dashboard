import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditAll,
  buildAuditToken,
  checkUntrackedWhitespace,
  classifySafety,
  collectChangedFiles,
  collectRuntimeSnapshot,
  compareLintBaseline,
  consumeRemovalApproval,
  containsPathReference,
  createRemovalApproval,
  evaluateHookGate,
  evaluateIntegrationProof,
  isDisposableIgnoredPath,
  normalizeLintDiagnostic,
  parseWorktreePorcelain,
  recordVerification,
  removalGitArguments,
  removeWorktree,
  selectRelevantTests,
  summarizeGitHubChecks,
  validateApprovalAgainstAudit,
  validateRemovalApproval,
  withRemovalLock,
  type CliOptions,
  type IntegrationProof,
  type RuntimeSnapshot,
  type SafetyFacts,
  type WorktreeAudit,
} from './development-workflow'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

const parsed = parseWorktreePorcelain(`worktree /repo/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/feature with spaces
HEAD 2222222222222222222222222222222222222222
detached
locked in use
`)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].branch, 'main')
assert.equal(parsed[1].path.endsWith('/repo/feature with spaces'), true)
assert.equal(parsed[1].detached, true)
assert.equal(parsed[1].locked, 'in use')

const exampleTarget = '/repo/.codex/worktrees/feature'
assert.equal(containsPathReference(`node ${exampleTarget}/server.js`, exampleTarget), true)
assert.equal(containsPathReference(`${exampleTarget}-integration`, exampleTarget), false)
assert.equal(containsPathReference(`cwd="${exampleTarget}"`, exampleTarget), true)

assert.equal(isDisposableIgnoredPath('.next-live/BUILD_ID'), true)
assert.equal(isDisposableIgnoredPath('node_modules'), true)
assert.equal(isDisposableIgnoredPath('scripts/__pycache__/test.pyc'), true)
assert.equal(isDisposableIgnoredPath('.env.local'), false)
assert.equal(isDisposableIgnoredPath('data/stockboard.db'), false)
assert.equal(isDisposableIgnoredPath('mail/outbox.db'), false)

const safeFacts: SafetyFacts = {
  isRepositoryRoot: false,
  isCurrentDirectory: false,
  exists: true,
  locked: false,
  prunable: false,
  dirtyEntries: 0,
  protectedIgnoredEntries: 0,
  externalSymlinkEntries: 0,
  runtimeReferences: 0,
  sourceReferences: 0,
  reverseSymlinkReferences: 0,
  scanErrors: 0,
  integrated: true,
  deletionInspectionComplete: true,
}
assert.equal(classifySafety(safeFacts).category, 'REMOVABLE')
assert.equal(classifySafety({ ...safeFacts, dirtyEntries: 1 }).category, 'BACKUP')
assert.equal(classifySafety({ ...safeFacts, integrated: false }).category, 'INTEGRATE')
assert.equal(classifySafety({ ...safeFacts, runtimeReferences: 1 }).category, 'KEEP')
assert.equal(classifySafety({ ...safeFacts, sourceReferences: 1 }).category, 'KEEP')
assert.equal(classifySafety({ ...safeFacts, externalSymlinkEntries: 1 }).category, 'KEEP')
assert.equal(classifySafety({ ...safeFacts, scanErrors: 1 }).category, 'REVIEW')
assert.equal(classifySafety({ ...safeFacts, deletionInspectionComplete: false }).category, 'REVIEW')
assert.equal(classifySafety({ ...safeFacts, exists: false }).category, 'STALE')

assert.deepEqual(summarizeGitHubChecks([]), {
  status: 'missing', total: 0, passing: 0, pending: 0, failing: 0, names: [], failures: [],
})
assert.equal(summarizeGitHubChecks([{ name: 'build', conclusion: 'SUCCESS' }]).status, 'passing')
assert.equal(summarizeGitHubChecks([{ name: 'build', status: 'IN_PROGRESS' }]).status, 'pending')
assert.deepEqual(summarizeGitHubChecks([{ name: 'build', conclusion: 'FAILURE' }]).failures, ['build:FAILURE'])
assert.deepEqual(removalGitArguments('/absolute/worktree'), ['worktree', 'remove', '/absolute/worktree'])

const strictRuntime = (overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  processes: [],
  openPaths: [],
  launchAgents: [],
  activeConfigs: [],
  errors: [],
  inspection: {
    platform: 'darwin',
    processScan: 'complete',
    openFileScan: 'complete',
    launchdScan: 'complete',
    macosDeletionReady: true,
  },
  ...overrides,
})

const tokenFixture: Omit<WorktreeAudit, 'auditToken'> = {
  path: '/repo/worktree',
  branch: 'feature',
  head: '1'.repeat(40),
  category: 'REMOVABLE',
  reasons: ['safe'],
  exists: true,
  dirtyEntries: 0,
  dirtyDigest: 'a'.repeat(64),
  ignoredDisposable: [],
  ignoredProtected: [],
  externalSymlinks: [],
  ignoredDigest: 'b'.repeat(64),
  runtimeReferences: [],
  sourceReferences: [],
  reverseSymlinkReferences: [],
  integrated: true,
  ahead: 0,
  behind: 0,
  locked: false,
  prunable: false,
  diskKiB: 10,
  scanErrors: [],
  deletionInspection: strictRuntime().inspection,
  filesystemIdentity: { device: 1, inode: 2 },
}
const token = buildAuditToken('2'.repeat(40), tokenFixture)
assert.match(token, /^[0-9a-f]{64}$/)
assert.notEqual(token, buildAuditToken('3'.repeat(40), tokenFixture))

const passingCi = summarizeGitHubChecks([{ name: 'completion-gate', conclusion: 'SUCCESS' }])
const mergedPr = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: 'MERGED',
  baseRefName: 'main',
  headRefOid: '1'.repeat(40),
  mergeCommit: { oid: '2'.repeat(40) },
  ...overrides,
})
const mergeProof = evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: true, mergeCommitInBase: true, pr: mergedPr(), ci: passingCi,
})
assert.equal(mergeProof.proven, true)
assert.equal(mergeProof.method, 'merge-commit')
const squashProof = evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: false, mergeCommitInBase: true,
  pr: mergedPr({ mergeMethod: 'SQUASH' }), ci: passingCi,
})
assert.equal(squashProof.proven, true)
assert.equal(squashProof.method, 'squash-or-rebase')
const rebaseProof = evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: false, mergeCommitInBase: true,
  pr: mergedPr({ mergeMethod: 'REBASE' }), ci: passingCi,
})
assert.equal(rebaseProof.proven, true)
assert.equal(rebaseProof.method, 'squash-or-rebase')
assert.equal(evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: true, mergeCommitInBase: true,
  pr: mergedPr({ baseRefName: 'release' }), ci: passingCi,
}).proven, false)
assert.equal(evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: true, mergeCommitInBase: true,
  pr: mergedPr({ headRefOid: '9'.repeat(40) }), ci: passingCi,
}).proven, false)
assert.equal(evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: false, mergeCommitInBase: false, pr: mergedPr(), ci: passingCi,
}).proven, false)
assert.equal(evaluateIntegrationProof({
  expectedBase: 'main', localHead: '1'.repeat(40), localHeadInBase: true, mergeCommitInBase: true,
  pr: mergedPr(), ci: summarizeGitHubChecks([{ name: 'unrelated-check', conclusion: 'SUCCESS' }]),
}).proven, false)

const lintComparison = compareLintBaseline([
  { fingerprint: 'existing', display: 'existing' },
  { fingerprint: 'new', display: 'new violation' },
], { schemaVersion: 1, entries: { existing: 1 } })
assert.equal(lintComparison.suppressed, 1)
assert.deepEqual(lintComparison.newFindings, ['new violation'])
assert.equal(
  normalizeLintDiagnostic('/repo', 'Error: Existing compiler finding\n\n/repo/app/page.tsx:10:2\n> 10 | setState()'),
  normalizeLintDiagnostic('/repo', 'Error: Existing compiler finding\n\n/repo/app/page.tsx:90:2\n> 90 | setState()'),
)
assert.equal(normalizeLintDiagnostic('/repo', 'Unexpected any. Specify a different type.'), 'Unexpected any. Specify a different type.')

const selectionConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'development-completion-tests.json'), 'utf8'))
const projectPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const selected = selectRelevantTests(['scripts/development-workflow.ts'], selectionConfig, projectPackage.scripts)
assert.equal(selected.unmappedCode.length, 0)
assert.equal(selected.tests.includes('test:development-workflow'), true)
assert.equal(selected.tests.includes('test:timeframes'), true)
assert.equal(selected.tests.includes('test:stage-classification'), true)
assert.deepEqual(selectRelevantTests(['lib/unmapped-new-feature.ts'], selectionConfig, projectPackage.scripts).unmappedCode, ['lib/unmapped-new-feature.ts'])
const currentSelection = selectRelevantTests(collectChangedFiles(projectRoot, 'origin/main'), selectionConfig, projectPackage.scripts)
assert.deepEqual(currentSelection.unmappedCode, [])
const deletedStageSelection = selectRelevantTests(['scripts/test-stage-transition-scanner.ts'], selectionConfig, projectPackage.scripts)
assert.equal(deletedStageSelection.tests.includes('test:stage-transition-scanner'), true)
const actionsWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'development-completion.yml'), 'utf8')
assert.match(actionsWorkflow, /runs-on: ubuntu-24\.04/)
assert.match(actionsWorkflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
assert.match(actionsWorkflow, /EXPECTED_BASE: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/)
assert.match(actionsWorkflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_HEAD"/)

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-development-workflow-'))
const fixtureMain = path.join(temporaryRoot, 'main')
const fixtureFeature = path.join(temporaryRoot, 'feature')
fs.mkdirSync(fixtureMain)
const GIT = '/usr/bin/git'
const gitRaw = (args: string[], cwd = fixtureMain): string => execFileSync(GIT, args, { cwd, encoding: 'utf8' })
const git = (args: string[], cwd = fixtureMain): string => gitRaw(args, cwd).trim()

try {
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Workflow Test'])
  git(['config', 'user.email', 'workflow-test@example.invalid'])
  fs.writeFileSync(path.join(fixtureMain, 'fixture.txt'), 'fixture\n')
  fs.writeFileSync(path.join(fixtureMain, '.gitignore'), [
    '.env*', 'node_modules', '.next*', 'data/*.db', '.claude/', 'scripts/development-workflow.ts',
  ].join('\n') + '\n')
  git(['add', 'fixture.txt', '.gitignore'])
  git(['commit', '-m', 'fixture'])
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'main'])])
  git(['worktree', 'add', '-b', 'feature', fixtureFeature, 'main'])
  const canonicalFeature = fs.realpathSync(fixtureFeature)

  const linuxRuntime = collectRuntimeSnapshot(fixtureMain, { platform: 'linux', homeDirectory: temporaryRoot })
  assert.equal(linuxRuntime.inspection.openFileScan, 'not-applicable')
  assert.equal(linuxRuntime.inspection.launchdScan, 'not-applicable')
  assert.equal(linuxRuntime.inspection.macosDeletionReady, false)
  assert.equal(linuxRuntime.errors.some((error) => error.includes('LaunchAgent')), false)
  const linuxAudit = auditAll('main', fixtureMain, { runtime: linuxRuntime }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(linuxAudit)
  assert.equal(linuxAudit.category, 'REVIEW')
  assert.equal(linuxAudit.auditToken, null)

  if (process.platform === 'darwin') {
    const macRuntime = collectRuntimeSnapshot(fixtureMain)
    assert.equal(macRuntime.inspection.processScan, 'complete')
    assert.equal(macRuntime.inspection.openFileScan, 'complete')
    assert.equal(macRuntime.inspection.launchdScan, 'complete')
    assert.equal(macRuntime.inspection.macosDeletionReady, true)
    const macAudit = auditAll('main', fixtureMain, { runtime: macRuntime }).worktrees.find((row) => row.path === canonicalFeature)
    assert.ok(macAudit)
    assert.equal(macAudit.deletionInspection.macosDeletionReady, true)
    assert.equal(macAudit.scanErrors.length, 0)
  }

  assert.throws(() => collectChangedFiles(fixtureFeature, 'missing-ref'), /rev-parse .*failed/)
  fs.writeFileSync(path.join(fixtureFeature, 'untracked-whitespace.txt'), 'trailing whitespace \n')
  assert.throws(() => checkUntrackedWhitespace(fixtureFeature), /whitespace errors/)
  fs.writeFileSync(path.join(fixtureFeature, 'untracked-whitespace.txt'), 'clean\n')
  assert.doesNotThrow(() => checkUntrackedWhitespace(fixtureFeature))
  fs.unlinkSync(path.join(fixtureFeature, 'untracked-whitespace.txt'))
  fs.unlinkSync(path.join(fixtureFeature, 'fixture.txt'))
  assert.equal(collectChangedFiles(fixtureFeature, 'origin/main').includes('fixture.txt'), true)
  fs.writeFileSync(path.join(fixtureFeature, 'fixture.txt'), 'fixture\n')

  const externalEnv = path.join(temporaryRoot, 'external-env-source')
  fs.writeFileSync(externalEnv, 'TEST_ONLY=fixture\n', { mode: 0o600 })
  fs.symlinkSync(externalEnv, path.join(fixtureFeature, '.env.local'))
  let blocked = auditAll('main', fixtureMain, { runtime: strictRuntime() }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(blocked)
  assert.equal(blocked.category, 'KEEP')
  assert.deepEqual(blocked.externalSymlinks, ['.env.local'])
  fs.unlinkSync(path.join(fixtureFeature, '.env.local'))

  const sharedModules = path.join(temporaryRoot, 'shared-node-modules')
  fs.mkdirSync(sharedModules)
  fs.symlinkSync(sharedModules, path.join(fixtureFeature, 'node_modules'))
  blocked = auditAll('main', fixtureMain, { runtime: strictRuntime() }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(blocked)
  assert.equal(blocked.category, 'KEEP')
  assert.deepEqual(blocked.externalSymlinks, ['node_modules'])
  fs.unlinkSync(path.join(fixtureFeature, 'node_modules'))

  fs.symlinkSync(externalEnv, path.join(fixtureFeature, 'tracked-link'))
  git(['add', 'tracked-link'], fixtureFeature)
  git(['commit', '-m', 'track external symlink'], fixtureFeature)
  blocked = auditAll('feature', fixtureMain, { runtime: strictRuntime() }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(blocked)
  assert.equal(blocked.category, 'KEEP')
  assert.deepEqual(blocked.externalSymlinks, ['tracked-link'])
  fs.unlinkSync(path.join(fixtureFeature, 'tracked-link'))
  git(['add', '-u'], fixtureFeature)
  git(['commit', '-m', 'remove external symlink'], fixtureFeature)

  const reverseLink = path.join(fixtureMain, 'feature-reference')
  fs.symlinkSync(fixtureFeature, reverseLink)
  blocked = auditAll('feature', fixtureMain, { runtime: strictRuntime() }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(blocked)
  assert.equal(blocked.category, 'KEEP')
  assert.equal(blocked.reverseSymlinkReferences.length, 1)
  fs.unlinkSync(reverseLink)

  git(['merge', '--ff-only', 'feature'])
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'main'])])
  let result = auditAll('main', fixtureMain, { runtime: strictRuntime() })
  let removable = result.worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(removable)
  assert.equal(removable.category, 'REMOVABLE')
  assert.match(removable.auditToken ?? '', /^[0-9a-f]{64}$/)

  const proofForFixture: IntegrationProof = {
    proven: true,
    method: 'merge-commit',
    reasons: [],
    baseRefName: 'main',
    headRefOid: removable.head,
    mergeCommitOid: removable.head,
  }
  const now = Date.now()
  const approval = createRemovalApproval({ commonDir: path.join(fixtureMain, '.git'), auditResult: result, audit: removable, integrationProof: proofForFixture, nowMs: now, ttlMinutes: 2 })
  validateRemovalApproval(path.join(fixtureMain, '.git'), approval, canonicalFeature, now + 1)

  fs.writeFileSync(path.join(fixtureFeature, 'uncommitted.ts'), 'export const changed = true\n')
  let changedResult = auditAll('main', fixtureMain, { runtime: strictRuntime() })
  let changedAudit = changedResult.worktrees.find((row) => row.path === canonicalFeature)
  assert.throws(() => validateApprovalAgainstAudit(approval, changedResult, changedAudit, proofForFixture), /approval-bound audit changed/)
  fs.unlinkSync(path.join(fixtureFeature, 'uncommitted.ts'))

  fs.writeFileSync(path.join(fixtureFeature, 'head-change.txt'), 'head change\n')
  git(['add', 'head-change.txt'], fixtureFeature)
  git(['commit', '-m', 'change head after approval'], fixtureFeature)
  changedResult = auditAll('main', fixtureMain, { runtime: strictRuntime(), integrationOverrides: new Map([[canonicalFeature, true]]) })
  changedAudit = changedResult.worktrees.find((row) => row.path === canonicalFeature)
  assert.throws(() => validateApprovalAgainstAudit(approval, changedResult, changedAudit, proofForFixture), /HEAD changed/)
  git(['merge', '--ff-only', 'feature'])
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'main'])])

  result = auditAll('main', fixtureMain, { runtime: strictRuntime() })
  removable = result.worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(removable)
  assert.equal(removable.category, 'REMOVABLE')
  const currentProof: IntegrationProof = { ...proofForFixture, headRefOid: removable.head, mergeCommitOid: removable.head }

  const processChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', canonicalFeature], { stdio: 'ignore' })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
  try {
    const processRuntime = collectRuntimeSnapshot(fixtureMain)
    const processAudit = auditAll('main', fixtureMain, { runtime: { ...processRuntime, inspection: strictRuntime().inspection } })
      .worktrees.find((row) => row.path === canonicalFeature)
    assert.ok(processAudit)
    assert.equal(processAudit.category, 'KEEP')
    assert.equal(processAudit.runtimeReferences.some((reference) => reference === `process:${processChild.pid}`), true)
  } finally {
    processChild.kill('SIGTERM')
  }

  const launchRuntime = strictRuntime({ launchAgents: [{ label: 'com.stockboard.production', text: `<string>${canonicalFeature}/server.js</string>` }] })
  const launchAudit = auditAll('main', fixtureMain, { runtime: launchRuntime }).worktrees.find((row) => row.path === canonicalFeature)
  assert.ok(launchAudit)
  assert.equal(launchAudit.category, 'KEEP')
  assert.equal(launchAudit.runtimeReferences.includes('LaunchAgent:com.stockboard.production'), true)

  const approvalCommon = path.join(fixtureMain, '.git')
  const reusable = createRemovalApproval({ commonDir: approvalCommon, auditResult: result, audit: removable, integrationProof: currentProof, nowMs: now, ttlMinutes: 2 })
  const consumed = consumeRemovalApproval(approvalCommon, reusable.approvalId, canonicalFeature, now + 1)
  assert.equal(consumed.approvalId, reusable.approvalId)
  assert.throws(() => consumeRemovalApproval(approvalCommon, reusable.approvalId, canonicalFeature, now + 2), /already been consumed/)

  const expired = createRemovalApproval({ commonDir: approvalCommon, auditResult: result, audit: removable, integrationProof: currentProof, nowMs: now, ttlMinutes: 1 })
  assert.throws(() => consumeRemovalApproval(approvalCommon, expired.approvalId, canonicalFeature, now + 61_000), /expired/)

  const tampered = createRemovalApproval({ commonDir: approvalCommon, auditResult: result, audit: removable, integrationProof: currentProof, nowMs: now, ttlMinutes: 2 })
  const tamperedFile = path.join(approvalCommon, 'stockboard-workflow', 'approvals', 'pending', `${tampered.approvalId}.json`)
  const tamperedJson = JSON.parse(fs.readFileSync(tamperedFile, 'utf8')) as Record<string, unknown>
  tamperedJson.head = 'f'.repeat(40)
  fs.writeFileSync(tamperedFile, `${JSON.stringify(tamperedJson, null, 2)}\n`, { mode: 0o600 })
  assert.throws(() => consumeRemovalApproval(approvalCommon, tampered.approvalId, canonicalFeature, now + 1), /signature is invalid/)

  const mismatch = createRemovalApproval({ commonDir: approvalCommon, auditResult: result, audit: removable, integrationProof: currentProof, nowMs: now, ttlMinutes: 2 })
  assert.throws(() => consumeRemovalApproval(approvalCommon, mismatch.approvalId, fixtureMain, now + 1), /target does not match/)

  assert.throws(() => removeWorktree({
    base: 'main',
    path: canonicalFeature,
    confirm: canonicalFeature,
    approvalId: reusable.approvalId,
    tests: [],
    json: false,
    github: false,
    selectTests: false,
  }), /automated approval\/removal is disabled/)
  const targetAlias = path.join(temporaryRoot, 'feature-alias')
  fs.symlinkSync(canonicalFeature, targetAlias)
  assert.throws(() => removeWorktree({
    base: 'main',
    path: targetAlias,
    confirm: targetAlias,
    approvalId: reusable.approvalId,
    tests: [],
    json: false,
    github: false,
    selectTests: false,
  }), /symbolic-link worktree paths are not accepted/)
  fs.unlinkSync(targetAlias)

  withRemovalLock(approvalCommon, canonicalFeature, () => {
    assert.throws(() => withRemovalLock(approvalCommon, canonicalFeature, () => undefined), /another worktree removal is active/)
  })

  const hookOptions: CliOptions = { base: 'origin/main', path: canonicalFeature, tests: [], json: false, github: false, selectTests: false, event: 'Stop' }
  assert.deepEqual(evaluateHookGate(hookOptions), { required: false, verified: true, reasons: [], event: 'Stop' })

  const hookDir = path.join(fixtureFeature, '.claude', 'hooks')
  const binDir = path.join(fixtureFeature, 'node_modules', '.bin')
  const scriptDir = path.join(fixtureFeature, 'scripts')
  fs.mkdirSync(hookDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(scriptDir, { recursive: true })
  fs.symlinkSync(path.join(projectRoot, 'node_modules', '.bin', 'tsx'), path.join(binDir, 'tsx'))
  fs.symlinkSync(path.join(projectRoot, 'scripts', 'development-workflow.ts'), path.join(scriptDir, 'development-workflow.ts'))
  const hookScript = path.join(projectRoot, '.claude', 'hooks', 'development-completion-reminder.mjs')
  const runHook = (event: 'Stop' | 'TaskCompleted', lastAssistantMessage = '') => spawnSync(process.execPath, [hookScript], {
    cwd: fixtureFeature,
    env: { ...process.env, CLAUDE_PROJECT_DIR: fixtureFeature },
    input: JSON.stringify({ hook_event_name: event, stop_hook_active: false, last_assistant_message: lastAssistantMessage }),
    encoding: 'utf8',
  })
  assert.equal(runHook('Stop').status, 0)
  fs.writeFileSync(path.join(fixtureFeature, 'hook-change.ts'), 'export const hookChange = true\n')
  assert.equal(runHook('Stop', 'I need a clarification before continuing.').status, 0)
  const blockedStop = runHook('Stop', 'Done. [stockboard-development-complete]')
  assert.equal(blockedStop.status, 2)
  assert.match(blockedStop.stderr, /completion gate blocked/)
  const blockedHook = runHook('TaskCompleted')
  assert.equal(blockedHook.status, 2)
  assert.match(blockedHook.stderr, /completion gate blocked/)

  const hookStatus = gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], fixtureFeature)
  const hookChanged = collectChangedFiles(fixtureFeature, 'origin/main')
  recordVerification(approvalCommon, {
    target: canonicalFeature,
    head: git(['rev-parse', 'HEAD'], fixtureFeature),
    base: 'origin/main',
    baseSha: git(['rev-parse', 'origin/main'], fixtureFeature),
    statusDigest: sha256(hookStatus),
    changedFilesDigest: sha256(JSON.stringify(hookChanged)),
    tests: ['test:development-workflow'],
    finishedAt: new Date().toISOString(),
  })
  assert.equal(runHook('Stop', 'Done. [stockboard-development-complete]').status, 0)
  fs.unlinkSync(path.join(binDir, 'tsx'))
  assert.equal(runHook('Stop', 'Done. [stockboard-development-complete]').status, 2)

  assert.equal(fs.existsSync(fixtureFeature), true)
  assert.equal(git(['worktree', 'list', '--porcelain']).includes(`worktree ${canonicalFeature}`), true)
  assert.equal(fs.readFileSync(externalEnv, 'utf8'), 'TEST_ONLY=fixture\n')
} finally {
  assert.equal(path.dirname(temporaryRoot), os.tmpdir())
  assert.match(path.basename(temporaryRoot), /^stockboard-development-workflow-/)
  fs.rmSync(temporaryRoot, { recursive: true })
}

console.log('Development workflow tests: PASS')
