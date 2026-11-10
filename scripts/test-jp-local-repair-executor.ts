import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import {
  JP_REPAIR_B2_BOUNDARY,
  JP_REPAIR_B2_SYNTHETIC_METHOD,
  assertJpRepairIsolatedTargets,
  executeJpRepair,
  type JpRepairExecutorInput,
  type JpRepairWorkflowContext,
} from '@/lib/jp-ohlcv-repair-executor'
import type { JpRepairPreflightResult, JpRepairProductionApproval } from '@/lib/jp-ohlcv-repair-production'
import { JP_REPAIR_ANALOG_CONTRACT } from '@/lib/jp-ohlcv-repair-stage-environment'
import type { WriterHoldDriver, WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'
import {
  JP_REPAIR_STAGE_FAILED,
  JP_REPAIR_STAGE_IN_FLIGHT,
  beginJpRepairStage,
  jpRepairRehearsalWorkflow,
  jpRepairStagePassed,
  recordJpRepairStage,
  type Cli,
  type JpRepairStageCheckpoint,
} from './rehearse-jp-local-repair-derived'

// These tests exercise the gate, the wiring to the real rehearsal workflow, and
// the rehearsal's own stage checkpoint protocol (in-flight mark, atomic receipt)
// driven by a synthetic three-stage body. The 28 real stage commands are not run
// here, and PASS here is never Production readiness. Synthetic, isolated
// fixtures only: three temporary SQLite files, a fake writer-hold driver, and a
// fake preflight. Nothing here opens a Production or OWC path.
const STAGES = ['one', 'two', 'three']
const RECEIPT = 'rehearsal-receipt.json'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

type Paths = { directory: string; database: string; analog: string; servingCache: string; checkpoints: string }

function binding(file: string) {
  const stat = fs.statSync(file)
  return { realpath: fs.realpathSync(file), dev: Number(stat.dev), inode: Number(stat.ino) }
}

function createTargets(root: string, name: string): Paths {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { recursive: true })
  const paths: Paths = {
    directory,
    database: path.join(directory, 'stockboard.db'),
    analog: path.join(directory, JP_REPAIR_ANALOG_CONTRACT.basename),
    servingCache: path.join(directory, 'stockboard-serving-cache.db'),
    checkpoints: path.join(directory, 'checkpoints'),
  }
  sql(paths.database, `CREATE TABLE marker(stage TEXT NOT NULL); CREATE TABLE repair_state(phase TEXT NOT NULL);
    INSERT INTO repair_state VALUES('base')`)
  sql(paths.analog, `CREATE TABLE analog_sequence_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO analog_sequence_meta VALUES('version','2'),('completed','1')`)
  sql(paths.servingCache, 'CREATE TABLE api_serving_cache(namespace TEXT NOT NULL)')
  return paths
}

function sql(file: string, statement: string): void {
  const db = new DatabaseSync(file)
  try { db.exec(statement) } finally { db.close() }
}

function rows(file: string, query: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return (db.prepare(query).all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]!) } finally { db.close() }
}

const writerLabels = ['com.stockboard.web', 'com.stockboard.analog-search']

function approvalFor(paths: Paths, overrides: { planApprovalSha256?: string } = {}): JpRepairProductionApproval {
  return {
    version: 4,
    gitCommitSha: 'a'.repeat(40),
    plan: { targetDate: '2026-07-17', approvalSha256: overrides.planApprovalSha256 ?? '1'.repeat(64), preservedConflictKeys: [] },
    database: binding(paths.database),
    analog: { ...binding(paths.analog), metaVersion: 2 },
    servingCache: binding(paths.servingCache),
    services: writerLabels.map((label) => ({
      label, program: `/approved/${label}`, plistPath: `/approved/${label}.plist`, definitionSha256: sha256(label),
    })),
  } as unknown as JpRepairProductionApproval
}

function preflightFor(approval: JpRepairProductionApproval, verdict: 'PASS' | 'HOLD' = 'PASS'): JpRepairPreflightResult {
  return {
    verdict, holdReasons: verdict === 'PASS' ? [] : ['SERVICE_IDENTITY_MISMATCH:com.stockboard.web'],
    approvalSha256: sha256(JSON.stringify(approval)), approval, planApprovalSha256: approval.plan.approvalSha256,
    services: [], limitations: [],
  }
}

function b2For(paths: Paths, approval: JpRepairProductionApproval, name: string,
  change: (evidence: Record<string, unknown>) => void = () => {}): { evidencePath: string; expectedSha256: string } {
  const evidence: Record<string, unknown> = {
    version: 1, boundary: JP_REPAIR_B2_BOUNDARY, status: 'PASS', method: JP_REPAIR_B2_SYNTHETIC_METHOD,
    approvalSha256: sha256(JSON.stringify(approval)), gitCommitSha: approval.gitCommitSha,
    planApprovalSha256: approval.plan.approvalSha256,
    databases: { main: binding(paths.database), analog: binding(paths.analog), servingCache: binding(paths.servingCache) },
  }
  change(evidence)
  const evidencePath = path.join(paths.directory, `b2-${name}.json`)
  fs.writeFileSync(evidencePath, JSON.stringify(evidence))
  return { evidencePath, expectedSha256: sha256(fs.readFileSync(evidencePath)) }
}

// Approved writers stay loaded until bootout; `drift` changes a plist identity.
function fakeDriver(drift = false): { driver: WriterHoldDriver; actions: string[] } {
  const states = new Map<string, WriterRuntimeIdentity>(writerLabels.map((label) => [label, {
    label, definitionSha256: sha256(label), program: `/approved/${label}`, loaded: true, disabled: false, instances: 1,
  }]))
  const actions: string[] = []
  let now = 0
  return {
    actions,
    driver: {
      async observe(label) {
        const state = structuredClone(states.get(label)!)
        return drift ? { ...state, definitionSha256: 'f'.repeat(64) } : state
      },
      async bootout(label) { actions.push(`bootout:${label}`); Object.assign(states.get(label)!, { loaded: false, instances: 0 }) },
      async bootstrap(label) { actions.push(`bootstrap:${label}`); Object.assign(states.get(label)!, { loaded: true, instances: 1 }) },
      async processGroupAlive() { return false },
      async sleep(milliseconds) { now += milliseconds },
      now: () => now,
    },
  }
}

// Stands in for the 28 stage commands only. The checkpoint is the rehearsal's:
// the same receipt shape, binding check, and checkpoint functions that
// runJpLocalRepairRehearsal uses. `killAt` dies after the stage committed but
// before its receipt; `killAfterReceiptAt` dies once the receipt is durable;
// `recordFailAt` commits partial output and records a FAIL receipt.
function workflow(options: {
  failAt?: string; killAt?: string; killAfterReceiptAt?: string; recordFailAt?: string; executed: string[]
}) {
  return async (context: JpRepairWorkflowContext) => {
    const file = path.join(context.checkpointDirectory, RECEIPT)
    const receipt = (fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { status: 'DERIVED_PENDING', updatedAt: '', stages: [], executorBindingSha256: context.bindingSha256 }
    ) as JpRepairStageCheckpoint & { executorBindingSha256?: string }
    if (receipt.executorBindingSha256 !== context.bindingSha256) throw new Error('receipt belongs to another binding')
    for (const stage of STAGES) {
      if (jpRepairStagePassed(receipt, stage, [])) continue
      await context.assertHoldValid()
      if (options.failAt === stage) throw new Error(`stage ${stage} failed`)
      beginJpRepairStage(file, receipt, stage)
      sql(context.targets.database, `UPDATE repair_state SET phase='derived_pending'; INSERT INTO marker VALUES('${stage}')`)
      options.executed.push(stage)
      if (options.killAt === stage) process.kill(process.pid, 'SIGKILL')
      if (options.recordFailAt === stage) {
        recordJpRepairStage(file, receipt, { name: stage, status: 'FAIL', sealedFiles: [] })
        throw new Error(`stage ${stage} failed`)
      }
      recordJpRepairStage(file, receipt, { name: stage, status: 'PASS', sealedFiles: [] })
      if (options.killAfterReceiptAt === stage) process.kill(process.pid, 'SIGKILL')
    }
    sql(context.targets.database, "UPDATE repair_state SET phase='derived_complete'")
    return 'done'
  }
}

function inputFor(root: string, target: Paths, overrides: Partial<JpRepairExecutorInput<string>> & { approval?: JpRepairProductionApproval } = {}) {
  const approval = overrides.approval ?? approvalFor(target)
  const { approval: _ignored, ...rest } = overrides
  const executed: string[] = []
  const input: JpRepairExecutorInput<string> & { executed: string[] } = {
    mode: 'EXECUTE_ISOLATED',
    preflight: async () => preflightFor(approval),
    targets: { database: target.database, analog: target.analog, servingCache: target.servingCache },
    b2: b2For(target, approval, 'pass'),
    isolatedRoot: root,
    checkpointDirectory: target.checkpoints,
    revision: { sourceTreeSha256: 'e'.repeat(64), nodeModulesLockSha256: 'd'.repeat(64) },
    hold: { driver: fakeDriver().driver, maximumHoldMs: 60_000 },
    workflow: workflow({ executed }),
    ...rest,
    executed,
  }
  return input
}

const hash = (file: string) => sha256(fs.readFileSync(file))
const reasonCodes = (reasons: string[]) => reasons.map((reason) => reason.split(':')[0])

async function expectNoMutation(label: string, root: string, name: string,
  change: (target: Paths, input: ReturnType<typeof inputFor>) => Promise<Partial<JpRepairExecutorInput<string>>> | Partial<JpRepairExecutorInput<string>> | void,
  codes: string[], options: { started?: boolean } = {}): Promise<void> {
  const target = createTargets(root, name)
  const input = inputFor(root, target)
  const overrides = (await change(target, input)) ?? {}
  const before = [target.database, target.analog, target.servingCache].map(hash)
  const result = await executeJpRepair({ ...input, ...overrides, workflow: async (context) => {
    input.executed.push('entered')
    return input.workflow(context)
  } })
  assert.notEqual(result.verdict, 'PASS', label)
  assert.deepEqual(reasonCodes(result.holdReasons).slice(0, codes.length), codes, `${label}: ${result.holdReasons.join(' | ')}`)
  assert.equal(result.workflowStarted, options.started ?? false, `${label}: workflow start`)
  assert.deepEqual(input.executed, [], `${label}: no stage ran`)
  if (!options.started && fs.existsSync(target.database)) {
    assert.deepEqual([target.database, target.analog, target.servingCache].map(hash), before, `${label}: databases untouched`)
  }
}

async function testGateBeforeMutation(root: string): Promise<void> {
  // Control: every gate passes, the writers are held, and all stages run.
  const control = createTargets(root, 'control')
  const controlInput = inputFor(root, control)
  const holding = fakeDriver()
  const passed = await executeJpRepair({ ...controlInput, hold: { driver: holding.driver, maximumHoldMs: 60_000 } })
  assert.equal(passed.verdict, 'PASS', passed.holdReasons.join('|'))
  assert.equal(passed.productionReady, false, 'a synthetic PASS is never Production readiness')
  assert.deepEqual(controlInput.executed, STAGES)
  assert.deepEqual(rows(control.database, 'SELECT phase FROM repair_state'), ['derived_complete'])
  assert.deepEqual(holding.actions, [...writerLabels.map((label) => `bootout:${label}`),
    ...[...writerLabels].reverse().map((label) => `bootstrap:${label}`)], 'writers held, then restored in reverse')

  // Dry run: all gates evaluated, nothing executed.
  const dry = createTargets(root, 'dry-run')
  const dryInput = inputFor(root, dry, { mode: 'DRY_RUN' })
  const dryBefore = hash(dry.database)
  assert.equal((await executeJpRepair(dryInput)).verdict, 'PASS')
  assert.deepEqual(dryInput.executed, [])
  assert.equal(hash(dry.database), dryBefore)
  assert.equal(fs.existsSync(dry.checkpoints), false, 'a dry run creates no checkpoint')

  await expectNoMutation('failed preflight', root, 'preflight-hold', (target) => ({
    preflight: async () => preflightFor(approvalFor(target), 'HOLD'),
  }), ['PREFLIGHT_HOLD'])
  await expectNoMutation('no B2 evidence', root, 'b2-missing', () => ({ b2: undefined }), ['B2_EVIDENCE_MISSING'])
  await expectNoMutation('B2 FAIL', root, 'b2-fail', (target) => ({
    b2: b2For(target, approvalFor(target), 'fail', (evidence) => { evidence.status = 'FAIL' }),
  }), ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('B2 for another boundary', root, 'b2-boundary', (target) => ({
    b2: b2For(target, approvalFor(target), 'boundary', (evidence) => { evidence.boundary = 'B1_ADVISORY' }),
  }), ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('B2 without a method', root, 'b2-no-method', (target) => ({
    b2: b2For(target, approvalFor(target), 'no-method', (evidence) => { delete evidence.method }),
  }), ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('B2 claiming a physical verifier method', root, 'b2-physical', (target) => ({
    b2: b2For(target, approvalFor(target), 'physical', (evidence) => { evidence.method = 'C_MIN_PHYSICAL_VERIFIER' }),
  }), ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('dry run without an isolated root (Production-shaped)', root, 'dry-no-root', () => ({
    mode: 'DRY_RUN', isolatedRoot: undefined,
  }), ['ISOLATION_REQUIRED'])
  await expectNoMutation('B2 file changed after hashing', root, 'b2-hash', (target) => {
    const b2 = b2For(target, approvalFor(target), 'hash')
    fs.appendFileSync(b2.evidencePath, ' ')
    return { b2 }
  }, ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('B2 for another approval', root, 'b2-approval', (target) => ({
    b2: b2For(target, approvalFor(target), 'approval', (evidence) => { evidence.approvalSha256 = '0'.repeat(64) }),
  }), ['B2_EVIDENCE_REJECTED'])
  await expectNoMutation('B2 for another plan', root, 'b2-plan', (target) => ({
    b2: b2For(target, approvalFor(target), 'plan', (evidence) => { evidence.planApprovalSha256 = '0'.repeat(64) }),
  }), ['B2_EVIDENCE_REJECTED'])
  for (const role of ['main', 'analog', 'servingCache']) {
    await expectNoMutation(`B2 for another ${role} identity`, root, `b2-${role}`, (target) => ({
      b2: b2For(target, approvalFor(target), role, (evidence) => {
        (evidence.databases as Record<string, { inode: number }>)[role]!.inode += 1
      }),
    }), ['B2_EVIDENCE_REJECTED'])
  }

  // Identity drift between preflight and execution.
  const copyOver = (file: string) => { fs.copyFileSync(file, `${file}.copy`); fs.renameSync(`${file}.copy`, file) }
  await expectNoMutation('main replaced after preflight', root, 'drift-main', (target) => { copyOver(target.database) },
    ['DATABASE_IDENTITY_DRIFT'])
  await expectNoMutation('analog replaced after preflight', root, 'drift-analog', (target) => { copyOver(target.analog) },
    ['DATABASE_IDENTITY_DRIFT'])
  await expectNoMutation('serving cache replaced after preflight', root, 'drift-cache', (target) => { copyOver(target.servingCache) },
    ['DATABASE_IDENTITY_DRIFT'])
  await expectNoMutation('analog v3 path substituted', root, 'drift-v3', (target) => {
    const v3 = path.join(target.directory, 'analog-sequence-jp-v3.db')
    fs.copyFileSync(target.analog, v3)
    return { targets: { database: target.database, analog: v3, servingCache: target.servingCache } }
  }, ['DATABASE_IDENTITY_DRIFT'])
  await expectNoMutation('serving cache substituted by the analog', root, 'drift-swap', (target) => ({
    targets: { database: target.database, analog: target.analog, servingCache: target.analog },
  }), ['DATABASE_IDENTITY_DRIFT'])

  // Isolation: no root, a non-temporary root, a missing hold driver.
  await expectNoMutation('execution without an isolated root', root, 'no-root', () => ({ isolatedRoot: undefined }),
    ['ISOLATION_REQUIRED'])
  await expectNoMutation('a root that is not a temporary directory', root, 'home-root', () => ({ isolatedRoot: os.homedir() }),
    ['ISOLATION_OR_CHECKPOINT_REJECTED'])
  await expectNoMutation('a root beside the targets that excludes them', root, 'narrow-root', (target) => {
    const narrow = path.join(target.directory, 'narrow')
    fs.mkdirSync(narrow)
    return { isolatedRoot: narrow }
  }, ['ISOLATION_OR_CHECKPOINT_REJECTED'])
  await expectNoMutation('no writer hold driver', root, 'no-hold', () => ({ hold: undefined }), ['WRITER_HOLD_REQUIRED'])
  assert.throws(() => assertJpRepairIsolatedTargets('/Volumes/OWC-DEV/isolated', ['/Volumes/OWC-DEV/isolated/stockboard.db']),
    /external-volume path is forbidden/, 'a /Volumes/OWC* root')
  assert.throws(() => assertJpRepairIsolatedTargets(root, ['/Volumes/OWC-DEV/stockboard.db']),
    /external-volume path is forbidden/, 'a /Volumes/OWC* target inside a temporary root')
  assert.throws(() => assertJpRepairIsolatedTargets(root, [path.join(os.homedir(), 'stockboard.db')]),
    /outside the isolated root/, 'a target outside the isolated root')
  const link = path.join(root, 'link-to-home')
  fs.symlinkSync(os.homedir(), link)
  assert.throws(() => assertJpRepairIsolatedTargets(root, [path.join(link, 'stockboard.db')]), /outside the isolated root/,
    'a symlink out of the isolated root')

  // Service identity drift is caught by the existing writer hold, before any stage.
  const drifted = createTargets(root, 'service-drift')
  const driftInput = inputFor(root, drifted, { hold: { driver: fakeDriver(true).driver, maximumHoldMs: 60_000 } })
  const driftResult = await executeJpRepair(driftInput)
  assert.equal(driftResult.verdict, 'FAILED')
  assert.match(driftResult.holdReasons.join(), /WRITER_IDENTITY_MISMATCH/)
  assert.equal(driftResult.workflowStarted, false)
  assert.deepEqual(rows(drifted.database, 'SELECT stage FROM marker'), [], 'no synthetic mutation under service drift')
}

async function testRestartAndFailure(root: string): Promise<void> {
  // Partial-stage failure keeps derived_pending and the stages already done.
  const target = createTargets(root, 'partial')
  const failing = inputFor(root, target)
  const failed = await executeJpRepair({ ...failing, workflow: workflow({ failAt: 'three', executed: failing.executed }) })
  assert.equal(failed.verdict, 'FAILED')
  assert.equal(failed.workflowStarted, true)
  assert.match(failed.holdReasons.join(), /stage three failed/)
  assert.deepEqual(rows(target.database, 'SELECT phase FROM repair_state'), ['derived_pending'])
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two'])
  assert.deepEqual(fs.readdirSync(target.checkpoints).sort(), ['executor-binding.json', RECEIPT],
    'checkpoint evidence is retained, with no temporary files left behind')
  const partialReceipt = JSON.parse(fs.readFileSync(path.join(target.checkpoints, RECEIPT), 'utf8')) as JpRepairStageCheckpoint
  assert.deepEqual(partialReceipt.stages.map((stage) => stage.name), ['one', 'two'])
  assert.equal(partialReceipt.inFlightStage, undefined, 'a stage that failed before starting is not in flight')

  // Mixed revision, plan, and database identity cannot reuse that checkpoint.
  const replay = async (label: string, input: ReturnType<typeof inputFor>,
    expected = /another revision, plan, or database identity/) => {
    const before = hash(target.database)
    const result = await executeJpRepair(input)
    assert.equal(result.verdict, 'HOLD', label)
    assert.equal(reasonCodes(result.holdReasons)[0], 'ISOLATION_OR_CHECKPOINT_REJECTED', `${label}: ${result.holdReasons}`)
    assert.match(result.holdReasons.join(), expected)
    assert.equal(hash(target.database), before, `${label}: no mutation`)
    assert.deepEqual(input.executed, [])
  }
  await replay('another source tree', inputFor(root, target, {
    revision: { sourceTreeSha256: '0'.repeat(64), nodeModulesLockSha256: 'd'.repeat(64) },
  }))
  await replay('another dependency set', inputFor(root, target, {
    revision: { sourceTreeSha256: 'e'.repeat(64), nodeModulesLockSha256: '0'.repeat(64) },
  }))
  const otherPlan = approvalFor(target, { planApprovalSha256: '2'.repeat(64) })
  await replay('another plan', inputFor(root, target, {
    approval: otherPlan, b2: b2For(target, otherPlan, 'other-plan'),
  }))
  const otherCommit = { ...approvalFor(target), gitCommitSha: 'b'.repeat(40) } as JpRepairProductionApproval
  await replay('another commit', inputFor(root, target, {
    approval: otherCommit, b2: b2For(target, otherCommit, 'other-commit'),
  }))
  const mixed = createTargets(root, 'mixed-database')
  fs.cpSync(target.checkpoints, mixed.checkpoints, { recursive: true })
  const mixedInput = inputFor(root, mixed)
  const mixedBefore = hash(mixed.database)
  const mixedResult = await executeJpRepair(mixedInput)
  assert.equal(mixedResult.verdict, 'HOLD', 'another database identity')
  assert.equal(reasonCodes(mixedResult.holdReasons)[0], 'ISOLATION_OR_CHECKPOINT_REJECTED')
  assert.equal(hash(mixed.database), mixedBefore)

  // A torn binding (crash while it was first written) is never reused.
  const torn = createTargets(root, 'torn-binding')
  fs.mkdirSync(torn.checkpoints)
  fs.writeFileSync(path.join(torn.checkpoints, 'executor-binding.json'), '{"version":')
  const tornInput = inputFor(root, torn)
  const tornResult = await executeJpRepair(tornInput)
  assert.equal(tornResult.verdict, 'HOLD')
  assert.equal(reasonCodes(tornResult.holdReasons)[0], 'ISOLATION_OR_CHECKPOINT_REJECTED')
  assert.deepEqual(tornInput.executed, [])

  // Same revision: only the matching completed stages are reused.
  const resumed = inputFor(root, target)
  const finished = await executeJpRepair(resumed)
  assert.equal(finished.verdict, 'PASS', finished.holdReasons.join('|'))
  assert.deepEqual(resumed.executed, ['three'], 'one and two reused, three runs for the first time')
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two', 'three'])
  assert.deepEqual(rows(target.database, 'SELECT phase FROM repair_state'), ['derived_complete'])
}

function killChild(root: string, name: string, point: 'killAt' | 'killAfterReceiptAt', stage: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'child', root, name, point, stage], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SKIP_SCHEMA_ENSURE: '1' },
  })
}

// A child process runs the real executor and SIGKILLs itself once stage one's receipt is durable.
async function testSigkillRestart(root: string): Promise<void> {
  const target = createTargets(root, 'sigkill')
  const child = killChild(root, 'sigkill', 'killAfterReceiptAt', 'one')
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one'])
  assert.deepEqual(rows(target.database, 'SELECT phase FROM repair_state'), ['derived_pending'])
  assert.deepEqual(fs.readdirSync(target.checkpoints).sort(), ['executor-binding.json', RECEIPT])

  const restart = inputFor(root, target)
  const result = await executeJpRepair(restart)
  assert.equal(result.verdict, 'PASS', result.holdReasons.join('|'))
  assert.deepEqual(restart.executed, ['two', 'three'], 'stage one is reused after SIGKILL')
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two', 'three'])

  const other = createTargets(root, 'sigkill-other-revision')
  killChild(root, 'sigkill-other-revision', 'killAfterReceiptAt', 'one')
  const mixed = inputFor(root, other, { revision: { sourceTreeSha256: '0'.repeat(64), nodeModulesLockSha256: 'd'.repeat(64) } })
  const rejected = await executeJpRepair(mixed)
  assert.equal(rejected.verdict, 'HOLD')
  assert.deepEqual(rows(other.database, 'SELECT stage FROM marker'), ['one'], 'a restart at another revision runs nothing')
}

// SIGKILL after stage two committed to the database but before its receipt.
// The restart must not rerun stage two (or anything else): it holds.
async function testCrashAfterCommitBeforeReceipt(root: string): Promise<void> {
  const target = createTargets(root, 'commit-no-receipt')
  const child = killChild(root, 'commit-no-receipt', 'killAt', 'two')
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two'], 'stage two committed')
  const receipt = JSON.parse(fs.readFileSync(path.join(target.checkpoints, RECEIPT), 'utf8')) as JpRepairStageCheckpoint
  assert.deepEqual(receipt.stages.map((stage) => stage.name), ['one'], 'stage two has no receipt')
  assert.equal(receipt.inFlightStage?.name, 'two')

  for (const attempt of ['first restart', 'second restart']) {
    const before = [target.database, target.analog, target.servingCache].map(hash)
    const restart = inputFor(root, target)
    const result = await executeJpRepair(restart)
    assert.equal(result.verdict, 'HOLD', `${attempt}: ${result.holdReasons.join('|')}`)
    assert.equal(result.productionReady, false)
    assert.equal(reasonCodes(result.holdReasons)[0], JP_REPAIR_STAGE_IN_FLIGHT, attempt)
    assert.match(result.holdReasons.join(), /stage two .* not rerun/)
    assert.deepEqual(restart.executed, [], `${attempt}: no stage is rerun`)
    assert.deepEqual([target.database, target.analog, target.servingCache].map(hash), before, `${attempt}: databases untouched`)
  }
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two'])
  // The checkpoint functions refuse to start or skip anything while a stage is in flight.
  assert.throws(() => jpRepairStagePassed(receipt, 'one', []), /not rerun/)
  assert.throws(() => beginJpRepairStage(path.join(root, 'unused.json'), receipt, 'three'), /not rerun/)
  assert.throws(() => recordJpRepairStage(path.join(root, 'unused.json'), { ...receipt, inFlightStage: undefined },
    { name: 'two', status: 'PASS', sealedFiles: [] }), /was not marked in flight/)
}

// Stage two committed partial output and recorded a FAIL receipt. Restarts
// must not rerun it (or anything else): they hold.
async function testFailReceiptRestart(root: string): Promise<void> {
  const target = createTargets(root, 'fail-receipt')
  const first = inputFor(root, target)
  const failed = await executeJpRepair({ ...first, workflow: workflow({ recordFailAt: 'two', executed: first.executed }) })
  assert.equal(failed.verdict, 'FAILED', failed.holdReasons.join('|'))
  assert.deepEqual(first.executed, ['one', 'two'])
  const receipt = JSON.parse(fs.readFileSync(path.join(target.checkpoints, RECEIPT), 'utf8')) as JpRepairStageCheckpoint
  assert.deepEqual(receipt.stages.map(({ name, status }) => `${name}:${status}`), ['one:PASS', 'two:FAIL'])

  for (const attempt of ['first restart', 'second restart']) {
    const before = [target.database, target.analog, target.servingCache].map(hash)
    const restart = inputFor(root, target)
    const result = await executeJpRepair(restart)
    assert.equal(result.verdict, 'HOLD', `${attempt}: ${result.holdReasons.join('|')}`)
    assert.equal(result.productionReady, false)
    assert.equal(reasonCodes(result.holdReasons)[0], JP_REPAIR_STAGE_FAILED, attempt)
    assert.match(result.holdReasons.join(), /stage two has a FAIL receipt.* not rerun/)
    assert.deepEqual(restart.executed, [], `${attempt}: no stage is rerun`)
    assert.deepEqual([target.database, target.analog, target.servingCache].map(hash), before, `${attempt}: databases untouched`)
  }
  assert.deepEqual(rows(target.database, 'SELECT stage FROM marker'), ['one', 'two'])
}

// The real workflow adapter: it refuses paths that are not the gate's targets
// and, when they are, enters runJpLocalRepairRehearsal (which here stops at its
// first input check, before any database is opened).
async function testRehearsalWorkflowWiring(root: string): Promise<void> {
  const cliFor = (target: Paths, change: Partial<Cli> = {}): Cli => ({
    database: target.database,
    base: path.join(target.directory, 'missing-base.db'),
    metadata: path.join(target.directory, 'missing-metadata.db'),
    official: path.join(target.directory, 'missing-official.json'),
    analog: path.join(target.directory, JP_REPAIR_ANALOG_CONTRACT.basename),
    servingCache: path.join(target.directory, 'stockboard-serving-cache.db'),
    receipt: path.join(target.checkpoints, RECEIPT),
    priceBasisEvidence: path.join(target.directory, 'missing-evidence.json'),
    reset: false,
    validateOnly: false,
    failBeforeStage: null,
    ...change,
  })
  const cases: Array<[string, (target: Paths) => Partial<Cli>, RegExp]> = [
    ['another database', (target) => ({ database: path.join(target.directory, 'other', 'stockboard.db') }),
      /not the execution gate targets/],
    ['receipt outside the checkpoint directory', (target) => ({ receipt: path.join(target.directory, RECEIPT) }),
      /not the execution gate targets/],
    ['reset', () => ({ reset: true }), /never resets/],
    ['validate-only', () => ({ validateOnly: true }), /never resets or validates-only/],
    ['matching targets', () => ({}),
      /base, metadata, and official evidence must already exist|rehearsal output must remain in a temporary directory/],
  ]
  for (const [label, change, expected] of cases) {
    const target = createTargets(root, `wiring-${label.replace(/[^a-z]+/g, '-')}`)
    const before = [target.database, target.analog, target.servingCache].map(hash)
    const result = await executeJpRepair({ ...inputFor(root, target), workflow: jpRepairRehearsalWorkflow(cliFor(target, change(target))) })
    assert.equal(result.verdict, 'FAILED', label)
    assert.equal(result.workflowStarted, true, label)
    assert.match(result.holdReasons.join(), expected, label)
    assert.deepEqual([target.database, target.analog, target.servingCache].map(hash), before, `${label}: databases untouched`)
    assert.equal(fs.existsSync(path.join(target.checkpoints, RECEIPT)), false, `${label}: no rehearsal receipt written`)
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'child') {
    const [root, name, point, stage] = process.argv.slice(3) as [string, string, 'killAt' | 'killAfterReceiptAt', string]
    const target: Paths = {
      directory: path.join(root, name), database: path.join(root, name, 'stockboard.db'),
      analog: path.join(root, name, JP_REPAIR_ANALOG_CONTRACT.basename),
      servingCache: path.join(root, name, 'stockboard-serving-cache.db'), checkpoints: path.join(root, name, 'checkpoints'),
    }
    const input = inputFor(root, target)
    await executeJpRepair({ ...input, workflow: workflow({
      ...(point === 'killAt' ? { killAt: stage } : { killAfterReceiptAt: stage }), executed: input.executed,
    }) })
    throw new Error('the child must have been killed')
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-repair-executor-')))
  try {
    await testGateBeforeMutation(root)
    await testRestartAndFailure(root)
    await testSigkillRestart(root)
    await testCrashAfterCommitBeforeReceipt(root)
    await testFailReceiptRestart(root)
    await testRehearsalWorkflowWiring(root)
    // The Production runner is preflight/dry-run only: it must report productionReady
    // and exit nonzero on any gate HOLD or productionReady=false, and must never execute.
    const runner = fs.readFileSync(path.join(process.cwd(), 'scripts/run-jp-local-repair-production.ts'), 'utf8')
    assert.match(runner, /mode: 'DRY_RUN'/)
    assert.doesNotMatch(runner, /EXECUTE_ISOLATED|jpRepairRehearsalWorkflow/)
    assert.match(runner, /productionReady: gate\.productionReady/)
    assert.match(runner, /gate\.verdict !== 'PASS' \|\| !gate\.productionReady\) process\.exitCode = 1/)
    console.log('JP local repair executor tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
