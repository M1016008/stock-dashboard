import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { summarizeOpenJpOhlcvCoverageIssues } from '@/lib/jp-ohlcv-coverage'
import {
  createJpOhlcvRepairPlan,
  jpOhlcvValueSha256,
  type JpOhlcvOfficialRow,
} from '@/lib/jp-ohlcv-local-repair'
import {
  JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME,
  JP_REPAIR_PRODUCTION_LIMITATIONS,
  JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION,
  JP_REPAIR_REHEARSAL_STAGE_COUNT,
  JP_REPAIR_SERVICE_LABEL_PREFIX,
  JP_REPAIR_SERVICE_LABELS,
  JP_REPAIR_TRIGGER_RUNTIME_LABELS,
  JP_REPAIR_TRIGGER_SCHEMA_CONTRACT,
  assertJpRepairExecutionCommit,
  corporateActionEvidenceSha256,
  inspectJpRepairDatabaseLogicalState,
  preflightJpRepairProduction,
  verifyExistingJpRepairFinalValidationReceipt,
  verifyJpRepairPlanBinding,
  type JpRepairFinalValidationReceipt,
  type JpRepairPreflightInput,
  type JpRepairProductionApproval,
  type JpRepairRuntimeIdentity,
} from '@/lib/jp-ohlcv-repair-production'
import {
  JP_REPAIR_RUNTIME_SOURCE_PATHSPECS,
  STOCKBOARD_BUILD_MANIFEST_NAME,
  jpRepairCompiledTreeSha256,
  jpRepairRuntimeSourceTreeSha256,
  stockboardBuildProvenance,
  verifyStockboardBuildManifest,
  writeStockboardBuildManifest,
} from '@/lib/jp-ohlcv-repair-runtime-manifest'
import {
  createLaunchdWriterHoldDriver,
  listLoadedLaunchdLabels,
  readLaunchdWorkingDirectory,
  type CommandRunner,
  type LaunchdRuntimeIdentity,
} from '@/lib/storage/launchd-writer-hold-driver'
import { WEEKLY_BACKUP_WRITER_LABELS } from '@/lib/storage/weekly-backup-policy'
import { bindValidateOnlyReceipts, persistFinalValidationReceipt } from './rehearse-jp-local-repair-derived'

// realpath: runtime WorkingDirectory binding compares resolved paths.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-repair-production-')))
const targetDate = '2026-07-17'
// Trigger re-evaluation runs at MAX(ohlcv_daily.date), not at the repair target.
const derivedAsOfDate = '2026-11-05'
const originalBatchId = '11111111-1111-4111-8111-111111111111'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd, encoding: 'utf8',
  })
}

function testRuntimeManifest(): void {
  assert.deepEqual([...JP_REPAIR_RUNTIME_SOURCE_PATHSPECS], [
    'lib', 'scripts', 'types', 'requirements', 'package.json', 'package-lock.json', 'tsconfig.json',
    ':(exclude,glob)scripts/**/test-*', ':(exclude,glob)scripts/**/test_*',
  ], 'the runtime manifest is explicit and reviewed')
  const repo = path.join(root, 'manifest-repo')
  const files: Record<string, string> = {
    'lib/repair.ts': 'export const repair = 1\n',
    'scripts/batch-snapshots.ts': 'stage\n',
    'scripts/lib/helper.ts': 'helper\n',
    'scripts/ml_serving.py': 'print(1)\n',
    'scripts/test-repair.ts': 'test\n',
    'scripts/test_ml.py': 'test\n',
    'scripts/bench/test-sweep.ts': 'bench\n',
    'app/page.tsx': 'ui\n',
    'components/chart.tsx': 'ui\n',
    'docs/runbook.md': 'doc\n',
    'requirements/analog.txt': 'numpy\n',
    'types/stock.ts': 'export type S = 1\n',
    'package.json': '{}\n',
    'package-lock.json': '{}\n',
    'tsconfig.json': '{}\n',
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), content)
  }
  git(repo, 'init', '-q')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  const base = jpRepairRuntimeSourceTreeSha256(repo)
  const commitChange = (file: string, content: string): string => {
    fs.writeFileSync(path.join(repo, file), content)
    git(repo, 'commit', '-qam', file)
    return jpRepairRuntimeSourceTreeSha256(repo)
  }
  for (const file of ['scripts/test-repair.ts', 'scripts/test_ml.py', 'scripts/bench/test-sweep.ts',
    'app/page.tsx', 'components/chart.tsx', 'docs/runbook.md']) {
    assert.equal(commitChange(file, `${file} changed\n`), base, `${file} is not runtime; validate-only must survive`)
  }
  fs.writeFileSync(path.join(repo, 'scripts/test-repair.ts'), 'uncommitted test edit\n')
  assert.equal(jpRepairRuntimeSourceTreeSha256(repo), base, 'a dirty test file does not block validation')
  git(repo, 'checkout', '--', 'scripts/test-repair.ts')
  let previous = base
  for (const file of ['lib/repair.ts', 'scripts/batch-snapshots.ts', 'scripts/lib/helper.ts', 'scripts/ml_serving.py',
    'requirements/analog.txt', 'types/stock.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    const next = commitChange(file, `${file} changed\n`)
    assert.notEqual(next, previous, `${file} is runtime; its change must be rejected`)
    previous = next
  }
  fs.writeFileSync(path.join(repo, 'lib/repair.ts'), 'dirty runtime\n')
  assert.throws(() => jpRepairRuntimeSourceTreeSha256(repo), /exactly match the committed Git revision/)
  git(repo, 'checkout', '--', 'lib/repair.ts')
  fs.writeFileSync(path.join(repo, 'lib/untracked.ts'), 'new runtime\n')
  assert.throws(() => jpRepairRuntimeSourceTreeSha256(repo), /untracked/)
  fs.rmSync(path.join(repo, 'lib/untracked.ts'))
  assert.equal(jpRepairRuntimeSourceTreeSha256(repo), previous)
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n*.local.py\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-qm', 'ignore')
  for (const file of ['lib/generated/loader.mjs', 'scripts/stage.local.py']) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), 'shadow\n')
    assert.throws(() => jpRepairRuntimeSourceTreeSha256(repo), /ignored executable source/, file)
    fs.rmSync(path.join(repo, file))
  }
  fs.mkdirSync(path.join(repo, 'lib/generated'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'lib/generated/cache.json'), '{}\n')
  assert.equal(jpRepairRuntimeSourceTreeSha256(repo), previous, 'ignored non-source data is not executable')

  // Deploy-side build provenance: next build compiles UI too, so the whole
  // tracked tree must be clean, unlike the runtime source hash above.
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  // Non-executable files under Next build roots still change the build.
  assert.throws(() => stockboardBuildProvenance(repo), /untracked or ignored files: lib\/generated\/cache\.json/,
    'ignored JSON under lib/ can be imported by the build')
  fs.rmSync(path.join(repo, 'lib/generated'), { recursive: true })
  for (const file of ['app/strings.json', 'components/theme.css', 'types/generated/data.json', 'public/robots.txt',
    'public/generated/logo.svg']) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), 'build input\n')
    assert.throws(() => stockboardBuildProvenance(repo), /untracked or ignored files/, file)
    fs.rmSync(path.join(repo, file))
  }
  // Finder metadata and non-executable data under scripts/ are not build input.
  for (const file of ['app/.DS_Store', 'public/.DS_Store', 'scripts/generated/output.json']) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), 'inert\n')
  }
  assert.deepEqual(stockboardBuildProvenance(repo), { gitCommitSha: head, runtimeSourceTreeSha256: previous })
  fs.writeFileSync(path.join(repo, 'scripts/stage.local.py'), 'shadow\n')
  assert.throws(() => stockboardBuildProvenance(repo), /ignored executable source: scripts\/stage\.local\.py/)
  fs.rmSync(path.join(repo, 'scripts/stage.local.py'))
  for (const file of ['app/.DS_Store', 'public/.DS_Store', 'scripts/generated/output.json']) fs.rmSync(path.join(repo, file))
  fs.writeFileSync(path.join(repo, 'app/page.tsx'), 'uncommitted ui\n')
  assert.throws(() => stockboardBuildProvenance(repo), /tracked worktree or index is dirty/, 'dirty UI source')
  git(repo, 'add', 'app/page.tsx')
  assert.throws(() => stockboardBuildProvenance(repo), /tracked worktree or index is dirty/, 'staged UI source')
  git(repo, 'reset', '-q', '--hard')
  fs.writeFileSync(path.join(repo, 'components/new.tsx'), 'untracked ui\n')
  assert.throws(() => stockboardBuildProvenance(repo), /untracked executable source/, 'untracked UI source')
  fs.rmSync(path.join(repo, 'components/new.tsx'))
  fs.mkdirSync(path.join(repo, 'components/generated'))
  fs.writeFileSync(path.join(repo, 'components/generated/shadow.tsx'), 'ignored ui\n')
  assert.throws(() => stockboardBuildProvenance(repo), /untracked or ignored files: components\/generated\/shadow\.tsx/,
    'ignored UI source is still compiled by next build')
  fs.rmSync(path.join(repo, 'components/generated'), { recursive: true })
  const build = path.join(repo, '.next-live-next')
  fs.mkdirSync(build)
  fs.writeFileSync(path.join(build, 'BUILD_ID'), 'deploy-build')
  writeStockboardBuildManifest(build, stockboardBuildProvenance(repo))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(build, STOCKBOARD_BUILD_MANIFEST_NAME), 'utf8')), {
    version: 1, gitCommitSha: head, runtimeSourceTreeSha256: previous, buildId: 'deploy-build',
  }, 'the manifest is exactly the small versioned contract')
  verifyStockboardBuildManifest(build, { gitCommitSha: head, runtimeSourceTreeSha256: previous })
  assert.throws(() => writeStockboardBuildManifest(build, stockboardBuildProvenance(repo)), /EEXIST/)
}

function testCoverageSplit(): void {
  assert.deepEqual(summarizeOpenJpOhlcvCoverageIssues([
    { date: targetDate, ticker: '1447', kind: 'PROTECTED_CONFLICT', count: 1 },
    { date: targetDate, ticker: '2164', kind: 'PROTECTED_CONFLICT', count: 1 },
  ]), { fetchFailed: 0, missing: 0, protectedConflicts: 2, unexpectedProtectedConflicts: 0, newIssues: 0 })
  assert.deepEqual(summarizeOpenJpOhlcvCoverageIssues([
    { date: targetDate, ticker: '1447', kind: 'PROTECTED_CONFLICT', count: 1 },
    { date: targetDate, ticker: '2164', kind: 'PROTECTED_CONFLICT', count: 1 },
    { date: '2026-11-05', ticker: '1447', kind: 'PROTECTED_CONFLICT', count: 1 },
    { date: targetDate, ticker: '7003', kind: 'PROTECTED_CONFLICT', count: 1 },
    { date: '2026-11-05', ticker: '9999', kind: 'MISSING', count: 1 },
    { date: '2026-11-05', ticker: '*', kind: 'FETCH_FAILED', count: 1 },
  ]), { fetchFailed: 1, missing: 1, protectedConflicts: 2, unexpectedProtectedConflicts: 2, newIssues: 4 },
  'new missing rows and unapproved conflicts are counted apart from the known two')
}

type Fixture = {
  database: string
  official: string
  priceBasis: string
  approvalPath: string
  approval: JpRepairProductionApproval
  services: LaunchdRuntimeIdentity[]
  run: CommandRunner
  loaded: Set<string>
  // What `launchctl print` reports for a loaded job, when it is not the
  // approved plist/program/WorkingDirectory.
  jobs: Map<string, LoadedJobOverride>
  heads: Map<string, { gitHead: string; sourceTreeSha256: string }>
  rehearsalReceipt: string
}

type LoadedJobOverride = { path?: string; program?: string; workingDirectory?: string | null; extra?: string[] }

type RehearsalDocument = Record<string, unknown>
type RehearsalMutation = Partial<Record<'execution' | 'validation' | 'package' | 'final',
  (document: RehearsalDocument) => void>>

// Mirrors the files scripts/rehearse-jp-local-repair-derived.ts writes:
// approval-package.json, then the PASS execution receipt naming it, then the
// validation receipt naming both, then validate-only's final receipt naming all.
function writeRehearsal(directory: string, approval: Pick<JpRepairProductionApproval,
  'gitCommitSha' | 'runtimeSourceTreeSha256' | 'plan' | 'evidence'>, mutate: RehearsalMutation = {}): JpRepairProductionApproval['rehearsal'] {
  const rehearsal = path.join(directory, 'rehearsal')
  fs.mkdirSync(rehearsal, { recursive: true })
  const write = (name: string, document: RehearsalDocument, change?: (value: RehearsalDocument) => void): string => {
    change?.(document)
    fs.writeFileSync(path.join(rehearsal, name), `${JSON.stringify(document, null, 2)}\n`)
    return sha256(fs.readFileSync(path.join(rehearsal, name)))
  }
  const stages = Array.from({ length: JP_REPAIR_REHEARSAL_STAGE_COUNT }, (_, index) => ({
    name: `stage-${index}`, status: 'PASS',
  }))
  const source = { approvalSha256: approval.plan.approvalSha256, approved: 3, inserted: 3, conflictsPreserved: 2, receiptId: 1 }
  const rehearsedDatabase = { realpath: path.join(rehearsal, 'stockboard.db'), inode: 42 }
  const repairPlan = { path: path.join(rehearsal, 'repair-plan.json'), sha256: 'b'.repeat(64),
    approvalSha256: approval.plan.approvalSha256 }
  const approvalPackageSha256 = write('approval-package.json', {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    officialEvidence: { sha256: approval.evidence.officialEvidenceSha256 },
    providerContentSha256: approval.evidence.providerContentSha256,
    repairPlan: { ...repairPlan },
    sourceIdentity: source, stages,
    databaseIdentity: { database: { ...rehearsedDatabase, size: 1, mtimeMs: 1 }, wal: null },
  }, mutate.package)
  const executionReceiptSha256 = write('rehearsal-receipt.json', {
    version: 1, status: 'PASS', database: rehearsedDatabase.realpath, gitCommitSha: approval.gitCommitSha,
    sourceTreeSha256: approval.runtimeSourceTreeSha256, source, stages, approvalPackageSha256,
  }, mutate.execution)
  const databaseIdentity = { database: { ...rehearsedDatabase, size: 1, sha256: 'd'.repeat(64) }, walBytes: 0 }
  const analogIdentity = { database: { realpath: path.join(rehearsal, 'analog.db'), inode: 43, size: 1, sha256: 'a'.repeat(64) }, walBytes: 0 }
  const validationReceiptSha256 = write('validation-receipt.json', {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    executionReceiptSha256, approvalPackageSha256, source, stageCount: stages.length, sourcePhase: 'derived_complete',
    databaseIdentity: structuredClone(databaseIdentity), analogIdentity: structuredClone(analogIdentity),
  }, mutate.validation)
  const finalValidationReceiptSha256 = write(JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME, {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    repairPlan: { ...repairPlan }, executionReceiptSha256, validationReceiptSha256, approvalPackageSha256, source,
    sourcePhase: 'derived_complete', stages: structuredClone(stages),
    databaseIdentity: structuredClone(databaseIdentity), analogIdentity: structuredClone(analogIdentity),
  } satisfies JpRepairFinalValidationReceipt, mutate.final)
  return { executionReceiptSha256, validationReceiptSha256, approvalPackageSha256, finalValidationReceiptSha256 }
}

function officialRows(): JpOhlcvOfficialRow[] {
  return ['1306', '1447', '2164', '7003', '8035'].map((ticker, index) => ({
    ticker, date: targetDate, adjustmentFactor: 1,
    open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 1_000 + index,
  }))
}

function createFixture(name: string): Fixture {
  const directory = path.join(root, name)
  fs.mkdirSync(path.join(directory, 'LaunchAgents'), { recursive: true })
  const database = path.join(directory, 'stockboard.db')
  const rows = officialRows()
  const db = new DatabaseSync(database)
  db.exec(`CREATE TABLE ohlcv_daily(
    ticker TEXT NOT NULL,date TEXT NOT NULL,open REAL NOT NULL,high REAL NOT NULL,
    low REAL NOT NULL,close REAL NOT NULL,volume INTEGER NOT NULL,PRIMARY KEY(ticker,date)) WITHOUT ROWID;
    CREATE TABLE trigger_evaluations(id TEXT PRIMARY KEY, superseded_by_evaluation_id TEXT);
    CREATE TABLE trigger_evaluation_batches(id TEXT PRIMARY KEY, source TEXT NOT NULL,
      resolved_as_of TEXT NOT NULL, status TEXT NOT NULL, repair_key TEXT, supersedes_batch_id TEXT);
    CREATE TABLE notification_outbox(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, status TEXT NOT NULL);`)
  const insert = db.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)')
  insert.run('1306', targetDate, rows[0].open, rows[0].high, rows[0].low, rows[0].close, rows[0].volume)
  insert.run('1447', targetDate, 1, 1, 1, 1, 1)
  insert.run('2164', targetDate, 2, 2, 2, 2, 2)
  insert.run('1306', derivedAsOfDate, 1, 1, 1, 1, 1)
  // A DAILY batch on the repair target date is a decoy: the binding must use
  // the derived as-of date.
  db.prepare("INSERT INTO trigger_evaluation_batches(id,source,resolved_as_of,status) VALUES(?,'DAILY',?,?)")
    .run('22222222-2222-4222-8222-222222222222', targetDate, 'COMPLETED')
  db.prepare("INSERT INTO trigger_evaluation_batches(id,source,resolved_as_of,status) VALUES(?,'DAILY',?,?)")
    .run(originalBatchId, derivedAsOfDate, 'COMPLETED')
  // Terminal rows of the original batch pass; a pending row of the decoy
  // batch is out of scope.
  const outbox = db.prepare('INSERT INTO notification_outbox VALUES(?,?,?)')
  outbox.run('o-sent', originalBatchId, 'SENT')
  outbox.run('o-cancelled', originalBatchId, 'CANCELLED')
  outbox.run('o-decoy', '22222222-2222-4222-8222-222222222222', 'PENDING')
  db.close()
  const official = path.join(directory, 'official.json')
  fs.writeFileSync(official, JSON.stringify({
    date: targetDate, priceBasis: 'jquants-adjusted-ohlcv-v1',
    sourceContract: { contentSha256: 'c'.repeat(64) }, rows,
  }))
  const plan = inspect(database).plan
  const providerAudit = { corporateActionEvents: [], tickersWithCorporateActions: [], verifiedTickers: 2 }
  const priceBasis = path.join(directory, 'price-basis.json')
  fs.writeFileSync(priceBasis, JSON.stringify({
    status: 'PASS', targetDate, priceBasis: 'jquants-adjusted-ohlcv-v1', officialEvidence: official,
    classification: { approvedMissingKeysSha256: jpOhlcvValueSha256([...plan.approvedMissingKeys].sort()) },
    providerAudit,
  }))
  // Fixture plist: label, Program, WorkingDirectory, one per line.
  const services = JP_REPAIR_SERVICE_LABELS.map((label) => {
    const plistPath = path.join(directory, 'LaunchAgents', `${label}.plist`)
    const program = `/approved/${label}`
    const workingDirectory = path.join(directory, 'runtime', label)
    fs.mkdirSync(workingDirectory, { recursive: true })
    fs.writeFileSync(plistPath, `${label}\n${program}\n${workingDirectory}\n`)
    return { label, program, plistPath, definitionSha256: sha256(fs.readFileSync(plistPath)) }
  })
  // Observed Git state per WorkingDirectory; web also seals its compiled build
  // and the deploy script's build manifest inside it.
  const provenance = { gitCommitSha: 'f'.repeat(40), runtimeSourceTreeSha256: 'e'.repeat(64) }
  const heads = new Map<string, { gitHead: string; sourceTreeSha256: string }>()
  const runtimes = JP_REPAIR_TRIGGER_RUNTIME_LABELS.map((label): JpRepairRuntimeIdentity => {
    const workingDirectory = path.join(directory, 'runtime', label)
    heads.set(workingDirectory, { gitHead: provenance.gitCommitSha, sourceTreeSha256: provenance.runtimeSourceTreeSha256 })
    if (label !== 'com.stockboard.web') {
      return { label, kind: 'GIT_WORKTREE', workingDirectory, gitHead: provenance.gitCommitSha, artifacts: [] }
    }
    const tree = path.join(workingDirectory, '.next-live')
    fs.mkdirSync(path.join(tree, 'server', 'app'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'BUILD_ID'), 'build-1')
    fs.writeFileSync(path.join(tree, 'server', 'app', 'page.js'), 'compiled-1\n')
    writeStockboardBuildManifest(tree, provenance)
    return { label, kind: 'GIT_WORKTREE', workingDirectory, gitHead: provenance.gitCommitSha,
      artifacts: [{ type: 'TREE', path: tree, sha256: jpRepairCompiledTreeSha256(tree) }] }
  })
  const loaded = new Set(JP_REPAIR_SERVICE_LABELS.filter((label) => label !== 'com.stockboard.us-ml-weekly'))
  const jobs = new Map<string, LoadedJobOverride>()
  const run: CommandRunner = (file, args) => {
    if (file === '/usr/bin/plutil') {
      const lines = fs.readFileSync(args.at(-1)!, 'utf8').split('\n')
      return { status: 0, signal: null, stdout: `${lines[args[1] === 'WorkingDirectory' ? 2 : 1]}\n`, stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'print-disabled') {
      return { status: 0, signal: null, stdout: 'disabled services = {\n}\n', stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'print' && args[1] === 'gui/501') {
      const rows = ['com.apple.unrelated', ...loaded].map((label) => `\t\t      0      -   \t${label}`)
      return { status: 0, signal: null, stdout: `gui/501 = {\n\tservices = {\n${rows.join('\n')}\n\t}\n}\n`, stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'print') {
      const label = args[1].split('/').at(-1)!
      if (!loaded.has(label)) return { status: 113, signal: null, stdout: '', stderr: 'Could not find service' }
      const service = services.find((item) => item.label === label)!
      const actual = { path: service.plistPath, program: service.program,
        workingDirectory: path.join(directory, 'runtime', label), ...jobs.get(label) }
      const lines = [`${args[1]} = {`, '\tstate = waiting', `\tpath = ${actual.path}`, `\tprogram = ${actual.program}`,
        ...(actual.workingDirectory === null ? [] : [`\tworking directory = ${actual.workingDirectory}`]),
        ...(actual.extra ?? []), '}']
      return { status: 0, signal: null, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`)
  }
  const stat = fs.statSync(database)
  const bound = {
    ...provenance,
    plan: { targetDate, approvalSha256: plan.approvalSha256, preservedConflictKeys: plan.preservedConflictKeys },
    evidence: {
      providerContentSha256: 'c'.repeat(64),
      officialEvidenceSha256: sha256(fs.readFileSync(official)),
      priceBasis: 'jquants-adjusted-ohlcv-v1' as const,
      priceBasisEvidenceSha256: sha256(fs.readFileSync(priceBasis)),
      corporateActionEvidenceSha256: corporateActionEvidenceSha256({ providerAudit }),
    },
  }
  const approval: JpRepairProductionApproval = {
    version: 3,
    action: JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION,
    operator: 'yoshio',
    approvedAt: '2026-11-06T00:00:00.000Z',
    expiresAt: '2026-11-06T06:00:00.000Z',
    ...bound,
    repairKey: plan.approvalSha256,
    database: {
      realpath: fs.realpathSync(database), dev: Number(stat.dev), inode: Number(stat.ino),
      latestJpOhlcvDate: derivedAsOfDate, derivedAsOfDate,
      originalDailyBatch: { id: originalBatchId, status: 'COMPLETED', nonterminalOutboxCount: 0 },
      repairBatchPresent: false,
    },
    triggerSchema: { contract: JP_REPAIR_TRIGGER_SCHEMA_CONTRACT, initialState: 'ALREADY_PRESENT' },
    storage: { volumeUuid: 'VOLUME-UUID' },
    rehearsal: writeRehearsal(directory, bound),
    services,
    runtimes,
  }
  const approvalPath = path.join(directory, 'approval.json')
  fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2))
  return {
    database, official, priceBasis, approvalPath, approval, services, run, loaded, jobs, heads,
    rehearsalReceipt: path.join(directory, 'rehearsal', 'rehearsal-receipt.json'),
  }
}

function inspect(database: string): ReturnType<JpRepairPreflightInput['inspectDatabase']> {
  const official = JSON.parse(fs.readFileSync(path.join(path.dirname(database), 'official.json'), 'utf8')) as {
    rows: JpOhlcvOfficialRow[]
  }
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return {
      logical: inspectJpRepairDatabaseLogicalState(db),
      plan: createJpOhlcvRepairPlan({
        db, targetDate, priceBasis: 'jquants-adjusted-ohlcv-v1', providerContentSha256: 'c'.repeat(64),
        officialRows: official.rows, preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
      }),
    }
  } finally {
    db.close()
  }
}

function writeApproval(fixture: Fixture, approval: JpRepairProductionApproval): string {
  fs.writeFileSync(fixture.approvalPath, JSON.stringify(approval, null, 2))
  return sha256(fs.readFileSync(fixture.approvalPath))
}

function preflightInput(fixture: Fixture, overrides: Partial<JpRepairPreflightInput> = {}): JpRepairPreflightInput {
  return {
    approvalPath: fixture.approvalPath,
    expectedApprovalSha256: sha256(fs.readFileSync(fixture.approvalPath)),
    databasePath: fixture.database,
    officialEvidencePath: fixture.official,
    priceBasisEvidencePath: fixture.priceBasis,
    rehearsalReceiptPath: fixture.rehearsalReceipt,
    now: Date.parse('2026-11-06T01:00:00.000Z'),
    gitCommitSha: () => fixture.approval.gitCommitSha,
    runtimeSourceTreeSha256: () => fixture.approval.runtimeSourceTreeSha256,
    inspectStorageVolumeUuid: () => 'volume-uuid',
    inspectDatabase: () => inspect(fixture.database),
    createServiceObserver: (services) => createLaunchdWriterHoldDriver(services, {
      run: fixture.run, uid: 501, verifyLoadedJob: true,
    }),
    listLoadedServiceLabels: () => listLoadedLaunchdLabels(JP_REPAIR_SERVICE_LABEL_PREFIX, { run: fixture.run, uid: 501 }),
    inspectRuntime: (service) => {
      const workingDirectory = readLaunchdWorkingDirectory(service, { run: fixture.run, uid: 501 })
      const git = workingDirectory ? fixture.heads.get(workingDirectory) : undefined
      return { workingDirectory, gitHead: git?.gitHead ?? null, sourceTreeSha256: git?.sourceTreeSha256 ?? null }
    },
    ...overrides,
  }
}

async function holdReasons(input: JpRepairPreflightInput): Promise<string[]> {
  const result = await preflightJpRepairProduction(input)
  assert.equal(result.verdict, result.holdReasons.length === 0 ? 'PASS' : 'HOLD')
  assert.deepEqual(result.limitations, JP_REPAIR_PRODUCTION_LIMITATIONS)
  return result.holdReasons.map((reason) => reason.split(':')[0]!)
}

async function testPreflight(): Promise<void> {
  const fixture = createFixture('preflight')
  const pass = await preflightJpRepairProduction(preflightInput(fixture))
  assert.deepEqual(pass.holdReasons, [])
  assert.equal(pass.verdict, 'PASS')
  assert.equal(pass.services.length, JP_REPAIR_SERVICE_LABELS.length)
  assert.equal(pass.services.find((item) => item.label === 'com.stockboard.us-ml-weekly')?.loaded, false)

  // Only the preflight action exists; an execute-style approval is invalid.
  const executeSha = writeApproval(fixture, {
    ...fixture.approval, action: 'EXECUTE_JP_LOCAL_REPAIR' as unknown as typeof JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION,
  })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: executeSha })),
    ['APPROVAL_INVALID'])
  // v2 predates the build manifest contract and is never accepted.
  const v2Sha = writeApproval(fixture, { ...fixture.approval, version: 2 as unknown as 3 })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: v2Sha })),
    ['APPROVAL_INVALID'], 'an old v2 approval')
  writeApproval(fixture, fixture.approval)

  // Expiry and an over-long validity window.
  assert.deepEqual(await holdReasons(preflightInput(fixture, { now: Date.parse('2026-11-06T06:00:00.000Z') })),
    ['APPROVAL_EXPIRED'])
  const longSha = writeApproval(fixture, { ...fixture.approval, expiresAt: '2026-11-07T06:00:00.000Z' })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: longSha })), ['APPROVAL_EXPIRED'])
  writeApproval(fixture, fixture.approval)

  // Revision and runtime binding.
  assert.deepEqual(await holdReasons(preflightInput(fixture, { gitCommitSha: () => '0'.repeat(40) })),
    ['GIT_REVISION_MISMATCH'])
  assert.deepEqual(await holdReasons(preflightInput(fixture, { runtimeSourceTreeSha256: () => {
    throw new Error('repair runtime source files must exactly match the committed Git revision')
  } })), ['RUNTIME_SOURCE_MISMATCH'])

  // DB bundle identity: a different file at the approved path is rejected.
  const swapped = createFixture('swapped')
  assert.deepEqual(await holdReasons(preflightInput(fixture, { databasePath: swapped.database })),
    ['DATABASE_IDENTITY_MISMATCH'])
  fs.symlinkSync(path.join(root, 'elsewhere-wal'), `${fixture.database}-wal`)
  fs.writeFileSync(path.join(root, 'elsewhere-wal'), '')
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_IDENTITY_MISMATCH'])
  fs.rmSync(`${fixture.database}-wal`)
  // Hard links (main or companion) would let another path alias the bundle.
  fs.writeFileSync(`${fixture.database}-shm`, '')
  assert.deepEqual(await holdReasons(preflightInput(fixture)), [], 'a single-link companion passes')
  fs.linkSync(`${fixture.database}-shm`, path.join(root, 'shm-alias'))
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_IDENTITY_MISMATCH'])
  fs.rmSync(path.join(root, 'shm-alias'))
  fs.rmSync(`${fixture.database}-shm`)
  fs.linkSync(fixture.database, path.join(root, 'db-alias'))
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_IDENTITY_MISMATCH'])
  fs.rmSync(path.join(root, 'db-alias'))

  // Logical binding at the derived as-of date (not the repair target date).
  const logical = (sql: string, ...args: string[]) => {
    const db = new DatabaseSync(fixture.database)
    db.prepare(sql).run(...args)
    db.close()
  }
  logical("UPDATE trigger_evaluation_batches SET status='FAILED' WHERE id=?", originalBatchId)
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_LOGICAL_DRIFT'])
  logical("UPDATE trigger_evaluation_batches SET status='COMPLETED' WHERE id=?", originalBatchId)
  logical("INSERT INTO trigger_evaluation_batches(id,source,resolved_as_of,status) VALUES('r','DAILY_REPAIR',?,'RUNNING')",
    derivedAsOfDate)
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_LOGICAL_DRIFT'])
  logical("DELETE FROM trigger_evaluation_batches WHERE id='r'")
  logical("INSERT INTO ohlcv_daily VALUES('1306','2026-11-06',1,1,1,1,1)")
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['DATABASE_LOGICAL_DRIFT'], 'a newer OHLCV date drifts')
  logical("DELETE FROM ohlcv_daily WHERE date='2026-11-06'")
  const targetBoundSha = writeApproval(fixture, {
    ...fixture.approval,
    database: {
      ...fixture.approval.database, derivedAsOfDate: targetDate,
      originalDailyBatch: { id: '22222222-2222-4222-8222-222222222222', status: 'COMPLETED', nonterminalOutboxCount: 0 },
    },
  })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: targetBoundSha })),
    ['DATABASE_LOGICAL_DRIFT'], 'the Trigger batch is never looked up on the repair target date')
  writeApproval(fixture, fixture.approval)
  assert.deepEqual(await holdReasons(preflightInput(fixture)), [])

  // Storage Guard.
  assert.deepEqual(await holdReasons(preflightInput(fixture, { inspectStorageVolumeUuid: () => 'OTHER' })),
    ['STORAGE_GUARD'])
  assert.deepEqual(await holdReasons(preflightInput(fixture, { inspectStorageVolumeUuid: () => {
    throw new Error('VOLUME_NOT_MOUNTED')
  } })), ['STORAGE_GUARD'])

  // Evidence hashes: Official, Price Basis, and corporate-action audit.
  const originalPriceBasis = fs.readFileSync(fixture.priceBasis, 'utf8')
  fs.writeFileSync(fixture.priceBasis, originalPriceBasis.replace('"verifiedTickers":2', '"verifiedTickers":3'))
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['EVIDENCE_MISMATCH'])
  fs.writeFileSync(fixture.priceBasis, originalPriceBasis)
  const caSha = writeApproval(fixture, {
    ...fixture.approval,
    evidence: { ...fixture.approval.evidence, corporateActionEvidenceSha256: '0'.repeat(64) },
  })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: caSha })), ['EVIDENCE_MISMATCH'])
  writeApproval(fixture, fixture.approval)

  // Plan drift: the live database changed after approval.
  const drift = new DatabaseSync(fixture.database)
  drift.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)').run('7003', targetDate, 103, 104, 102, 103.5, 1003)
  drift.close()
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['PLAN_DRIFT'])
  const undo = new DatabaseSync(fixture.database)
  undo.prepare("DELETE FROM ohlcv_daily WHERE ticker='7003'").run()
  undo.close()
  assert.deepEqual(await holdReasons(preflightInput(fixture)), [])

  // Service set: web-health first, readers, the weekly backup writers, then
  // us-earnings (a writer outside the weekly list) and dev-capacity-monitor.
  assert.deepEqual([...JP_REPAIR_SERVICE_LABELS], [
    'com.stockboard.web-health', 'com.stockboard.web', 'com.stockboard.analog-search',
    'com.stockboard.friend-readonly-gateway', ...WEEKLY_BACKUP_WRITER_LABELS, 'com.stockboard.us-earnings',
    'com.stockboard.dev-capacity-monitor',
  ])

  // Service identity: a replaced plist and a reordered list.
  const schemaFixture = createFixture('services')
  const reordered = [...schemaFixture.approval.services]
  ;[reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!]
  const reorderedSha = writeApproval(schemaFixture, { ...schemaFixture.approval, services: reordered })
  assert.deepEqual(await holdReasons(preflightInput(schemaFixture, { expectedApprovalSha256: reorderedSha })),
    ['SERVICE_SET_MISMATCH'])
  writeApproval(schemaFixture, schemaFixture.approval)
  const plist = schemaFixture.services[3]!.plistPath
  fs.appendFileSync(plist, '<!-- changed -->\n')
  assert.deepEqual(await holdReasons(preflightInput(schemaFixture)), ['SERVICE_IDENTITY_MISMATCH'])
}

function rewrite(fixture: Fixture, change: (approval: JpRepairProductionApproval) => JpRepairProductionApproval): string {
  return writeApproval(fixture, change(structuredClone(fixture.approval)))
}

async function testContractBindings(): Promise<void> {
  const fixture = createFixture('contract')
  const expect = async (expectedApprovalSha256: string | undefined, codes: string[], note: string) => {
    assert.deepEqual(await holdReasons(preflightInput(fixture, expectedApprovalSha256 ? { expectedApprovalSha256 } : {})),
      codes, note)
    writeApproval(fixture, fixture.approval)
  }

  // An unverified approval is never used to build the launchd observer, read
  // a plist, list launchd, or read artifacts / receipts it names.
  const calls: string[] = []
  writeApproval(fixture, { ...fixture.approval, operator: 'attacker' })
  assert.deepEqual(await holdReasons(preflightInput(fixture, {
    expectedApprovalSha256: sha256(JSON.stringify(fixture.approval)),
    createServiceObserver: () => { calls.push('observer'); throw new Error('built') },
    listLoadedServiceLabels: () => { calls.push('list'); return [] },
    inspectRuntime: () => { calls.push('runtime'); throw new Error('read') },
    inspectDatabase: () => { calls.push('database'); throw new Error('read') },
  })), ['APPROVAL_TAMPERED'])
  assert.equal(calls.length, 0)
  writeApproval(fixture, fixture.approval)

  // A hash-matching file that is not a JSON object is never an approval.
  for (const text of ['null', 'false', '0', '""', '[]', '"approval"', '{"version":3', '']) {
    fs.writeFileSync(fixture.approvalPath, text)
    const result = await preflightJpRepairProduction(preflightInput(fixture, {
      createServiceObserver: () => { calls.push('observer'); throw new Error('built') },
      listLoadedServiceLabels: () => { calls.push('list'); return [] },
      inspectRuntime: () => { calls.push('runtime'); throw new Error('read') },
      inspectDatabase: () => { calls.push('database'); throw new Error('read') },
    }))
    assert.equal(result.verdict, 'HOLD', JSON.stringify(text))
    assert.deepEqual(result.holdReasons.map((reason) => reason.split(':')[0]), ['APPROVAL_INVALID'], JSON.stringify(text))
    assert.equal(result.approval, null)
  }
  assert.equal(calls.length, 0)
  writeApproval(fixture, fixture.approval)

  // The loaded launchd job itself must be the approved plist, program, and
  // WorkingDirectory; a verified plist file on disk is not enough.
  const analog = fixture.services.find((service) => service.label === 'com.stockboard.analog-search')!
  const loadedJob = async (label: string, job: LoadedJobOverride, codes: string[], note: string) => {
    fixture.jobs.set(label, job)
    await expect(undefined, codes, note)
    fixture.jobs.delete(label)
  }
  await loadedJob(analog.label, { path: path.join(root, 'shadow', `${analog.label}.plist`) },
    ['SERVICE_IDENTITY_MISMATCH'], 'a job loaded from another plist')
  await loadedJob(analog.label, { program: '/tmp/shadow-node' }, ['SERVICE_IDENTITY_MISMATCH'],
    'a job running another program')
  await loadedJob(analog.label, { extra: [`\tprogram = ${analog.program}`] }, ['SERVICE_IDENTITY_MISMATCH'],
    'a repeated program key is ambiguous')
  await loadedJob(analog.label, { path: '' }, ['SERVICE_IDENTITY_MISMATCH'], 'an empty path is ambiguous')
  await loadedJob(analog.label, { extra: ['\tsockets = {', `\t\tpath = /tmp/elsewhere`, `\t\tprogram = /tmp/x`, '\t}'] },
    [], 'nested keys are not the job identity')
  await loadedJob('com.stockboard.web', { program: '/tmp/shadow-node' },
    ['SERVICE_IDENTITY_MISMATCH', 'RUNTIME_IDENTITY_MISMATCH'], 'an unverified runtime is never inspected')
  await loadedJob('com.stockboard.update-latest', { workingDirectory: path.join(root, 'other-worktree') },
    ['RUNTIME_IDENTITY_MISMATCH'], 'the actual job runs in another WorkingDirectory')
  await loadedJob('com.stockboard.update-latest', { workingDirectory: null },
    ['RUNTIME_IDENTITY_MISMATCH'], 'the actual job has no WorkingDirectory')
  // A path-less print for a loaded job (unparseable identity) holds.
  const pathless = (file: string, args: readonly string[], timeoutMs: number) => {
    const result = fixture.run(file, args, timeoutMs)
    return file === '/bin/launchctl' && args[0] === 'print' && args[1]!.endsWith('/com.stockboard.data-freshness-guard')
      ? { ...result, stdout: result.stdout.replace(/^\tpath = .*\n/m, '') } : result
  }
  assert.deepEqual(await holdReasons(preflightInput(fixture, {
    createServiceObserver: (services) => createLaunchdWriterHoldDriver(services, { run: pathless, uid: 501, verifyLoadedJob: true }),
    inspectRuntime: (service) => {
      const workingDirectory = readLaunchdWorkingDirectory(service, { run: pathless, uid: 501 })
      const git = workingDirectory ? fixture.heads.get(workingDirectory) : undefined
      return { workingDirectory, gitHead: git?.gitHead ?? null, sourceTreeSha256: git?.sourceTreeSha256 ?? null }
    },
  })), ['SERVICE_IDENTITY_MISMATCH', 'RUNTIME_IDENTITY_MISMATCH'], 'a loaded job without a path holds')
  await expect(undefined, [], 'the approved loaded jobs pass')

  // Loaded launchd labels: any unknown com.stockboard.* label holds.
  fixture.loaded.add('com.stockboard.new-db-writer')
  await expect(undefined, ['UNKNOWN_LOADED_SERVICE'], 'an unknown loaded label holds')
  fixture.loaded.delete('com.stockboard.new-db-writer')
  // Loaded dev-capacity-monitor passes only because the approval seals it.
  for (const label of ['com.stockboard.us-earnings', 'com.stockboard.dev-capacity-monitor']) {
    assert.ok(fixture.loaded.has(label))
    await expect(rewrite(fixture, (approval) => ({
      ...approval, services: approval.services.filter((service) => service.label !== label),
    })), ['SERVICE_SET_MISMATCH', 'UNKNOWN_LOADED_SERVICE'], `${label} must be stopped by the approval`)
  }

  // Runtime identity: HEAD, source tree, WorkingDirectory, artifacts, and set.
  assert.deepEqual([...JP_REPAIR_TRIGGER_RUNTIME_LABELS],
    ['com.stockboard.web', 'com.stockboard.update-latest', 'com.stockboard.data-freshness-guard'])
  const [web, updateLatest] = fixture.approval.runtimes
  const observed = fixture.heads.get(updateLatest!.workingDirectory!)!
  fixture.heads.set(web!.workingDirectory!, { ...observed, gitHead: 'b'.repeat(40) })
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'another HEAD in the web worktree')
  fixture.heads.set(web!.workingDirectory!, observed)
  // A runtime whose approved and observed HEAD agree is still not the
  // approved commit.
  fixture.heads.set(updateLatest!.workingDirectory!, { ...observed, gitHead: 'b'.repeat(40) })
  await expect(rewrite(fixture, (approval) => {
    (approval.runtimes[1] as { gitHead: string }).gitHead = 'b'.repeat(40)
    return approval
  }), ['RUNTIME_IDENTITY_MISMATCH'], 'runtime.gitHead differs from the approved gitCommitSha')
  fixture.heads.set(updateLatest!.workingDirectory!, observed)
  fixture.heads.set(updateLatest!.workingDirectory!, { ...observed, sourceTreeSha256: '0'.repeat(64) })
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'runtime source drift at the same HEAD')
  fixture.heads.set(updateLatest!.workingDirectory!, observed)
  await expect(undefined, [], 'a runtime without its own artifacts passes on source tree identity')
  assert.deepEqual(await holdReasons(preflightInput(fixture, { inspectRuntime: () => {
    throw new Error('repair runtime source tree has untracked files')
  } })), Array(3).fill('RUNTIME_IDENTITY_MISMATCH'), 'a dirty or untracked runtime tree holds')
  await expect(rewrite(fixture, (approval) => {
    approval.runtimes[1]!.workingDirectory = path.join(root, 'other-worktree')
    return approval
  }), ['RUNTIME_IDENTITY_MISMATCH'], 'another WorkingDirectory')
  // web's whole compiled .next-live tree is sealed, not just BUILD_ID.
  const tree = web!.artifacts[0]!.path
  const page = path.join(tree, 'server', 'app', 'page.js')
  fs.writeFileSync(page, 'compiled-2\n')
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'a nested compiled file tampered at the same BUILD_ID')
  fs.writeFileSync(page, 'compiled-1\n')
  fs.renameSync(page, `${page}.bak`)
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'a renamed compiled file')
  fs.renameSync(`${page}.bak`, page)
  fs.symlinkSync(page, path.join(tree, 'link.js'))
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'a symlink inside the compiled tree')
  assert.throws(() => jpRepairCompiledTreeSha256(tree), /not a regular file or directory/)
  fs.rmSync(path.join(tree, 'link.js'))
  // A hard link (inside or outside the tree) is a writable alias path.
  for (const alias of [path.join(root, 'page-alias.js'), path.join(tree, 'page-alias.js')]) {
    fs.linkSync(page, alias)
    assert.throws(() => jpRepairCompiledTreeSha256(tree), /hard links/, alias)
    await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], `a hard-linked compiled file (${alias})`)
    fs.rmSync(alias)
  }
  await expect(undefined, [], 'the restored compiled tree passes')
  const buildId = path.join(tree, 'BUILD_ID')

  // The sealed tree must carry the deploy build manifest naming the approved
  // commit, runtime source tree, and its own BUILD_ID. Each case re-seals the
  // tree in the approval, so only the manifest check can hold.
  const manifestPath = path.join(tree, STOCKBOARD_BUILD_MANIFEST_NAME)
  const manifestText = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText) as Record<string, unknown>
  const resealed = async (change: () => void, reason: RegExp) => {
    change()
    const expectedApprovalSha256 = rewrite(fixture, (approval) => {
      approval.runtimes[0]!.artifacts = [{ ...web!.artifacts[0]!, sha256: jpRepairCompiledTreeSha256(tree) }]
      return approval
    })
    const result = await preflightJpRepairProduction(preflightInput(fixture, { expectedApprovalSha256 }))
    assert.equal(result.holdReasons.length, 1, reason.source)
    assert.match(result.holdReasons[0]!, new RegExp(`^RUNTIME_IDENTITY_MISMATCH:.*${STOCKBOARD_BUILD_MANIFEST_NAME}: .*${reason.source}`))
    fs.writeFileSync(buildId, 'build-1')
    fs.writeFileSync(manifestPath, manifestText)
    writeApproval(fixture, fixture.approval)
  }
  const writeManifest = (change: Record<string, unknown>) => () =>
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...change })}\n`)
  await resealed(() => fs.rmSync(manifestPath), /ENOENT/)
  await resealed(writeManifest({ version: 2 }), /unsupported build manifest version/)
  await resealed(writeManifest({ gitCommitSha: '0'.repeat(40) }), /not compiled from the approved commit/)
  await resealed(writeManifest({ runtimeSourceTreeSha256: '0'.repeat(64) }), /not compiled from the approved runtime source tree/)
  await resealed(writeManifest({ buildId: 'build-0' }), /another BUILD_ID/)
  await resealed(() => fs.writeFileSync(buildId, 'build-2'), /another BUILD_ID/)
  await resealed(writeManifest({ extra: true }), /not canonical/)
  await expect(undefined, [], 'the restored manifest passes')

  for (const artifact of [{ type: 'FILE', path: buildId, sha256: sha256('build-1') }, { path: buildId,
    sha256: sha256('build-1') }, { type: 'FILE', path: tree, sha256: web!.artifacts[0]!.sha256 }]) {
    await expect(rewrite(fixture, (approval) => {
      approval.runtimes[0]!.artifacts = [artifact as JpRepairRuntimeIdentity['artifacts'][number]]
      return approval
    }), ['RUNTIME_IDENTITY_MISMATCH'], `${JSON.stringify(artifact)} does not seal the compiled tree`)
  }
  // An identical copy elsewhere is not the approved WorkingDirectory/.next-live,
  // and neither is a .next-live symlink to an identical tree.
  const copy = path.join(root, 'copy', '.next-live')
  fs.cpSync(tree, copy, { recursive: true })
  assert.equal(jpRepairCompiledTreeSha256(copy), web!.artifacts[0]!.sha256, 'the digest is path-independent')
  await expect(rewrite(fixture, (approval) => {
    approval.runtimes[0]!.artifacts = [{ ...web!.artifacts[0]!, path: copy }]
    return approval
  }), ['RUNTIME_IDENTITY_MISMATCH'], 'an identical copy does not satisfy the web tree')
  fs.renameSync(tree, `${tree}.real`)
  fs.symlinkSync(copy, tree)
  await expect(undefined, ['RUNTIME_IDENTITY_MISMATCH'], 'a symlinked .next-live')
  fs.unlinkSync(tree)
  fs.renameSync(`${tree}.real`, tree)
  await expect(rewrite(fixture, (approval) => {
    approval.runtimes[2] = { label: approval.runtimes[2]!.label, kind: 'IMMUTABLE',
      workingDirectory: approval.runtimes[2]!.workingDirectory, artifacts: [] }
    return approval
  }), ['RUNTIME_IDENTITY_MISMATCH'], 'an immutable runtime without artifacts is unbound')
  await expect(rewrite(fixture, (approval) => ({ ...approval, runtimes: approval.runtimes.slice(1) })),
    ['RUNTIME_SET_MISMATCH'], 'every Trigger-interpreting runtime is bound')

  // Pending notifications of the original batch are never silently skipped.
  const db = (sql: string) => {
    const handle = new DatabaseSync(fixture.database)
    handle.exec(sql)
    handle.close()
  }
  db(`INSERT INTO notification_outbox VALUES('o-pending','${originalBatchId}','PENDING')`)
  await expect(undefined, ['NOTIFICATION_OUTBOX_PENDING'], 'a PENDING outbox row holds')
  db("UPDATE notification_outbox SET status='DELIVERY_UNKNOWN' WHERE id='o-pending'")
  await expect(undefined, ['NOTIFICATION_OUTBOX_PENDING'], 'DELIVERY_UNKNOWN is not terminal')
  db("DELETE FROM notification_outbox WHERE id='o-pending'")
  await expect(rewrite(fixture, (approval) => {
    (approval.database.originalDailyBatch as { nonterminalOutboxCount: number }).nonterminalOutboxCount = 1
    return approval
  }), ['NOTIFICATION_OUTBOX_PENDING'], 'an approval cannot accept pending notifications')

  // repairKey is the plan hash.
  await expect(rewrite(fixture, (approval) => ({ ...approval, repairKey: '0'.repeat(64) })),
    ['REPAIR_KEY_MISMATCH'], 'repairKey must equal plan.approvalSha256')

  // Trigger DDL: all present + ALREADY_PRESENT, all missing + APPLY_ALL_MISSING.
  const applyAll = (approval: JpRepairProductionApproval) => {
    approval.triggerSchema.initialState = 'APPLY_ALL_MISSING'
    return approval
  }
  await expect(rewrite(fixture, applyAll), ['SCHEMA_CONTRACT_MISMATCH'], 'present columns cannot be applied again')
  await expect(rewrite(fixture, (approval) => {
    (approval.triggerSchema as { contract: string }).contract = 'jp-repair-trigger-columns-v0'
    return approval
  }), ['SCHEMA_CONTRACT_MISMATCH'], 'another contract version')
  db('ALTER TABLE trigger_evaluation_batches DROP COLUMN repair_key')
  await expect(undefined, ['SCHEMA_CONTRACT_MISMATCH'], 'a partially applied schema holds')
  await expect(rewrite(fixture, applyAll), ['SCHEMA_CONTRACT_MISMATCH'], 'partial is never APPLY_ALL_MISSING')
  db(`ALTER TABLE trigger_evaluation_batches DROP COLUMN supersedes_batch_id;
    ALTER TABLE trigger_evaluations DROP COLUMN superseded_by_evaluation_id`)
  await expect(rewrite(fixture, applyAll), [], 'all missing with APPLY_ALL_MISSING passes')
  await expect(undefined, ['SCHEMA_CONTRACT_MISMATCH'], 'all missing with ALREADY_PRESENT holds')
}

async function testRehearsalReceipts(): Promise<void> {
  const fixture = createFixture('rehearsal')
  const directory = path.dirname(path.dirname(fixture.rehearsalReceipt))
  const rebind = async (mutate: RehearsalMutation, codes: string[], note: string) => {
    const rehearsal = writeRehearsal(directory, fixture.approval, mutate)
    const expectedApprovalSha256 = writeApproval(fixture, { ...fixture.approval, rehearsal })
    assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256 })), codes, note)
    writeRehearsal(directory, fixture.approval)
    writeApproval(fixture, fixture.approval)
  }
  await rebind({}, [], 'a rewritten but identical rehearsal passes')
  const mismatch = ['REHEARSAL_RECEIPT_MISMATCH']

  // Byte tamper or a missing file without re-approval.
  const validation = path.join(path.dirname(fixture.rehearsalReceipt), 'validation-receipt.json')
  fs.appendFileSync(validation, ' ')
  assert.deepEqual(await holdReasons(preflightInput(fixture)), mismatch, 'tampered validation receipt')
  fs.rmSync(validation)
  assert.deepEqual(await holdReasons(preflightInput(fixture)), mismatch, 'missing validation receipt')
  writeRehearsal(directory, fixture.approval)

  // Re-approved but internally wrong receipts.
  await rebind({ validation: (document) => { document.gitCommitSha = '0'.repeat(40) } }, mismatch, 'old revision')
  await rebind({ package: (document) => { document.sourceTreeSha256 = '0'.repeat(64) } }, mismatch, 'old source tree')
  await rebind({ execution: (document) => {
    (document.stages as Array<{ status: string }>)[27]!.status = 'FAIL'
  } }, mismatch, 'a failed stage')
  await rebind({ execution: (document) => { (document.stages as unknown[]).pop() } }, mismatch, '27 stages')
  await rebind({ execution: (document) => { document.status = 'DERIVED_PENDING' } }, mismatch, 'not PASS')
  await rebind({ validation: (document) => { document.status = 'UNKNOWN' } }, mismatch, 'UNKNOWN validation')
  await rebind({ validation: (document) => { document.executionReceiptSha256 = '0'.repeat(64) } }, mismatch,
    'validation does not reference the execution receipt')
  await rebind({ execution: (document) => { document.approvalPackageSha256 = '0'.repeat(64) } }, mismatch,
    'execution does not reference the approval package')
  await rebind({ package: (document) => { document.repairPlan = { approvalSha256: '0'.repeat(64) } } }, mismatch,
    'another plan')
  await rebind({ package: (document) => {
    (document.databaseIdentity as { database: { inode: number } }).database.inode = 7
  } }, mismatch, 'DB identity disagrees between receipts')
  await rebind({ validation: (document) => { delete document.analogIdentity } }, mismatch, 'missing analog identity')
  const production = fs.realpathSync(fixture.database)
  await rebind({
    package: (document) => {
      (document.databaseIdentity as { database: { realpath: string } }).database.realpath = production
    },
    validation: (document) => {
      (document.databaseIdentity as { database: { realpath: string } }).database.realpath = production
    },
    final: (document) => {
      (document.databaseIdentity as { database: { realpath: string } }).database.realpath = production
    },
  }, mismatch, 'a rehearsal on the production database is not isolated')

  // The execution receipt carries the commit captured at initialization.
  await rebind({ execution: (document) => { delete document.gitCommitSha } }, mismatch, 'execution without a commit')
  await rebind({ execution: (document) => { document.gitCommitSha = '0'.repeat(40) } }, mismatch,
    'execution at another commit')
  await rebind({ package: (document) => {
    (document.repairPlan as { sha256: string }).sha256 = '0'.repeat(64)
  } }, mismatch, 'a swapped plan hash in the approval package')

  // The final validation receipt: byte tamper, missing, or unbound by v3.
  const final = path.join(path.dirname(fixture.rehearsalReceipt), JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME)
  fs.appendFileSync(final, ' ')
  assert.deepEqual(await holdReasons(preflightInput(fixture)), mismatch, 'tampered final validation receipt')
  fs.rmSync(final)
  assert.deepEqual(await holdReasons(preflightInput(fixture)), mismatch, 'missing final validation receipt')
  writeRehearsal(directory, fixture.approval)
  await expect(rewrite(fixture, (approval) => {
    delete (approval.rehearsal as Partial<JpRepairProductionApproval['rehearsal']>).finalValidationReceiptSha256
    return approval
  }), 'an approval that does not bind the final validation receipt')

  // Re-approved but substituted final receipts.
  const finalCases: Array<[(document: RehearsalDocument) => void, string]> = [
    [(document) => { document.gitCommitSha = '0'.repeat(40) }, 'final at another revision'],
    [(document) => { document.sourceTreeSha256 = '0'.repeat(64) }, 'final from another source tree'],
    [(document) => { document.status = 'HOLD' }, 'final not PASS'],
    [(document) => { document.version = 2 }, 'final of another version'],
    [(document) => { document.executionReceiptSha256 = '0'.repeat(64) }, 'final names another execution receipt'],
    [(document) => { document.validationReceiptSha256 = '0'.repeat(64) }, 'final names another validation receipt'],
    [(document) => { document.approvalPackageSha256 = '0'.repeat(64) }, 'final names another approval package'],
    [(document) => { (document.repairPlan as { sha256: string }).sha256 = '0'.repeat(64) }, 'final swapped plan hash'],
    [(document) => { (document.repairPlan as { path: string }).path = path.join(root, 'other-plan.json') },
      'final names another plan path'],
    [(document) => { (document.repairPlan as { approvalSha256: string }).approvalSha256 = '0'.repeat(64) },
      'final names another plan approval'],
    [(document) => { (document.source as { receiptId: number }).receiptId = 2 }, 'final from another source run'],
    [(document) => { document.sourcePhase = 'derived_pending' }, 'final not derived_complete'],
    [(document) => { (document.stages as unknown[]).pop() }, 'final with 27 stages'],
    [(document) => { (document.stages as Array<{ name: string }>)[0]!.name = 'other' }, 'final with other stages'],
    [(document) => {
      (document.databaseIdentity as { database: { sha256: string } }).database.sha256 = '0'.repeat(64)
    }, 'final with another database'],
    [(document) => {
      (document.analogIdentity as { database: { inode: number } }).database.inode = 7
    }, 'final with another analog database'],
  ]
  for (const [change, note] of finalCases) await rebind({ final: change }, mismatch, note)

  async function expect(expectedApprovalSha256: string, note: string): Promise<void> {
    assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256 })), mismatch, note)
    writeApproval(fixture, fixture.approval)
  }
}

// Rehearsal-side contracts used by resume and validate-only.
function testRehearsalContracts(): void {
  const commit = 'f'.repeat(40)
  assert.equal(assertJpRepairExecutionCommit({ gitCommitSha: commit }, commit), commit)
  assert.throws(() => assertJpRepairExecutionCommit({}, commit), /no captured Git commit/, 'legacy receipt')
  assert.throws(() => assertJpRepairExecutionCommit({ gitCommitSha: 'HEAD' }, commit), /no captured Git commit/)
  assert.throws(() => assertJpRepairExecutionCommit({ gitCommitSha: commit }, '0'.repeat(40)), /HEAD differs/,
    'resume or validate-only at another revision')

  const directory = path.join(root, 'contracts')
  fs.mkdirSync(directory, { recursive: true })
  const planPath = path.join(directory, 'repair-plan.json')
  const approvalSha256 = '1'.repeat(64)
  fs.writeFileSync(planPath, `${JSON.stringify({ approvalSha256, approvedMissingKeys: [] })}\n`)
  const bound = { path: planPath, sha256: sha256(fs.readFileSync(planPath)), approvalSha256 }
  assert.deepEqual(verifyJpRepairPlanBinding(planPath, bound, approvalSha256).binding, bound)
  for (const [binding, expected, note] of [
    [{ ...bound, sha256: '0'.repeat(64) }, approvalSha256, 'swapped plan hash'],
    [{ ...bound, path: path.join(directory, 'other.json') }, approvalSha256, 'another plan path'],
    [{ ...bound, approvalSha256: '0'.repeat(64) }, approvalSha256, 'another plan approval in the package'],
    [bound, '0'.repeat(64), 'plan of another source repair'],
    [undefined, approvalSha256, 'package without a plan binding'],
  ] as const) {
    assert.throws(() => verifyJpRepairPlanBinding(planPath, binding, expected), /not the plan bound/, note)
  }
  fs.writeFileSync(planPath, `${JSON.stringify({ approvalSha256, approvedMissingKeys: ['x'] })}\n`)
  assert.throws(() => verifyJpRepairPlanBinding(planPath, bound, approvalSha256), /not the plan bound/,
    'a rewritten plan with the same approvalSha256')

  const receipt: JpRepairFinalValidationReceipt = {
    version: 1, status: 'PASS', gitCommitSha: commit, sourceTreeSha256: 'e'.repeat(64), repairPlan: bound,
    executionReceiptSha256: '2'.repeat(64), validationReceiptSha256: '3'.repeat(64), approvalPackageSha256: '4'.repeat(64),
    source: { approvalSha256 }, sourcePhase: 'derived_complete',
    stages: [{ name: 'snapshots', status: 'PASS' }], databaseIdentity: { walBytes: 0 }, analogIdentity: { walBytes: 0 },
  }
  const finalPath = path.join(directory, JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME)
  assert.equal(verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), false, 'missing is written once')
  fs.writeFileSync(finalPath, `${JSON.stringify(receipt, null, 2)}\n`)
  assert.equal(verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), true, 'an identical rerun verifies')
  for (const [other, note] of [
    [{ ...receipt, gitCommitSha: '0'.repeat(40) }, 'another revision'],
    [{ ...receipt, databaseIdentity: { walBytes: 1 } }, 'another database'],
    [{ ...receipt, executionReceiptSha256: '0'.repeat(64) }, 'another execution receipt'],
  ] as const) {
    assert.throws(() => verifyExistingJpRepairFinalValidationReceipt(finalPath, other), /changed or substituted/, note)
  }
  fs.appendFileSync(finalPath, ' ')
  assert.throws(() => verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), /changed or substituted/,
    'a tampered existing receipt is never overwritten')
  fs.rmSync(finalPath)
  fs.writeFileSync(path.join(directory, 'elsewhere.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  fs.symlinkSync(path.join(directory, 'elsewhere.json'), finalPath)
  assert.throws(() => verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), /not a regular file/,
    'a symlinked receipt is a substitution')
}

// Drives the rehearsal's own validate-only wiring (not a copy of it) over a
// completed rehearsal directory, then tampers with one artifact per case.
function testValidateOnlyWiring(): void {
  const commit = 'a'.repeat(40)
  const sourceTree = 'b'.repeat(64)
  const approvalSha256 = 'c'.repeat(64)
  const source = { receiptId: 1, approvalSha256, approved: 1 }
  const stages = [{ name: 'snapshots', status: 'PASS' }, { name: 'analog', status: 'PASS' }]
  const identity = { database: { realpath: '/tmp/rehearsal.sqlite', inode: 1 }, walBytes: 0 }
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  let count = 0

  const completed = () => {
    const directory = path.join(root, `validate-only-${count++}`)
    fs.mkdirSync(directory, { recursive: true })
    const files = {
      database: path.join(directory, 'stockboard.sqlite'),
      receipt: path.join(directory, 'rehearsal-receipt.json'),
      plan: path.join(directory, 'repair-plan.json'),
      package: path.join(directory, 'approval-package.json'),
      validation: path.join(directory, 'validation-receipt.json'),
      final: path.join(directory, JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME),
    }
    fs.writeFileSync(files.plan, `${JSON.stringify({ approvalSha256, approvedMissingKeys: ['1301:2026-07-17'] })}\n`)
    const approvalPackage = {
      version: 1, status: 'PASS', gitCommitSha: commit, sourceTreeSha256: sourceTree,
      repairPlan: { path: files.plan, sha256: sha256(fs.readFileSync(files.plan)), approvalSha256 },
      sourceIdentity: source, stages,
    }
    fs.writeFileSync(files.package, json(approvalPackage))
    const execution = {
      status: 'PASS', gitCommitSha: commit, sourceTreeSha256: sourceTree, source, stages,
      approvalPackageSha256: sha256(fs.readFileSync(files.package)),
    }
    fs.writeFileSync(files.receipt, json(execution))
    fs.writeFileSync(files.validation, json({
      version: 1, status: 'PASS', gitCommitSha: commit, sourceTreeSha256: sourceTree,
      executionReceiptSha256: sha256(fs.readFileSync(files.receipt)),
      approvalPackageSha256: execution.approvalPackageSha256, source, stageCount: stages.length,
      sourcePhase: 'derived_complete', databaseIdentity: identity, analogIdentity: identity,
    }))
    const bind = (head = commit) => bindValidateOnlyReceipts({
      database: files.database, receipt: files.receipt, gitHeadSha: head, sourceTreeSha256: sourceTree,
    })
    return { files, approvalPackage, execution, bind }
  }

  // Control: the untampered rehearsal binds, writes its final receipt once,
  // and a rerun reproduces it.
  const control = completed()
  const bound = control.bind()
  assert.equal(bound.gitCommitSha, commit)
  assert.equal(fs.existsSync(control.files.final), false, 'binding alone writes nothing')
  persistFinalValidationReceipt(bound.finalValidationPath, bound.finalValidation)
  persistFinalValidationReceipt(bound.finalValidationPath, bound.finalValidation)
  assert.equal(fs.readFileSync(control.files.final, 'utf8'), json(bound.finalValidation))
  assert.equal(control.bind().finalValidationPath, control.files.final, 'an identical rerun binds')
  assert.equal(fs.readdirSync(path.dirname(control.files.final)).some((file) => file.endsWith('.tmp')), false,
    'no temporary receipt remains')

  const head = completed()
  assert.throws(() => head.bind('d'.repeat(40)), /HEAD differs/, 'validate-only at another HEAD')

  const plan = completed()
  fs.writeFileSync(plan.files.plan, `${JSON.stringify({ approvalSha256, approvedMissingKeys: ['1332:2026-07-17'] })}\n`)
  assert.throws(() => plan.bind(), /not the plan bound/, 'plan bytes changed under the same approvalSha256')

  const substituted = completed()
  fs.writeFileSync(substituted.files.package, json({ ...substituted.approvalPackage, createdAt: 'other' }))
  assert.throws(() => substituted.bind(), /approval package changed/, 'substituted approval package')
  // Rebinding the execution receipt to a substitute still fails on content.
  for (const [change, note] of [
    [{ version: 2 }, 'package of another version'],
    [{ sourceIdentity: { ...source, receiptId: 2 } }, 'package from another source run'],
    [{ gitCommitSha: 'd'.repeat(40) }, 'package at another revision'],
  ] as const) {
    const rebound = completed()
    fs.writeFileSync(rebound.files.package, json({ ...rebound.approvalPackage, ...change }))
    fs.writeFileSync(rebound.files.receipt, json({
      ...rebound.execution, approvalPackageSha256: sha256(fs.readFileSync(rebound.files.package)),
    }))
    assert.throws(() => rebound.bind(), /another revision or source run/, note)
  }
  const validation = completed()
  const document = JSON.parse(fs.readFileSync(validation.files.validation, 'utf8')) as { version: number }
  fs.writeFileSync(validation.files.validation, json({ ...document, version: 2 }))
  assert.throws(() => validation.bind(), /does not bind the completed execution/, 'validation of another version')

  const final = completed()
  const finalBound = final.bind()
  persistFinalValidationReceipt(finalBound.finalValidationPath, finalBound.finalValidation)
  const finalBytes = fs.readFileSync(final.files.final)
  finalBytes[finalBytes.length - 2] ^= 1
  fs.writeFileSync(final.files.final, finalBytes)
  assert.throws(() => final.bind(), /changed or substituted/, 'one byte of the existing final receipt changed')
  assert.throws(() => persistFinalValidationReceipt(finalBound.finalValidationPath, finalBound.finalValidation),
    /changed or substituted/, 'a changed final receipt is never overwritten')
  assert.deepEqual(fs.readFileSync(final.files.final), finalBytes)
  fs.rmSync(final.files.final)
  fs.symlinkSync(path.join(root, 'elsewhere.json'), final.files.final)
  assert.throws(() => persistFinalValidationReceipt(finalBound.finalValidationPath, finalBound.finalValidation),
    /not a regular file/, 'a dangling symlink is never written through')
  assert.equal(fs.existsSync(path.join(root, 'elsewhere.json')), false)

  const legacy = completed()
  const { gitCommitSha: _omitted, ...withoutCommit } = legacy.execution
  fs.writeFileSync(legacy.files.receipt, json(withoutCommit))
  assert.throws(() => legacy.bind(), /no captured Git commit/, 'execution receipt from before gitCommitSha')
}

async function main(): Promise<void> {
  try {
    testRuntimeManifest()
    testCoverageSplit()
    await testPreflight()
    await testContractBindings()
    await testRehearsalReceipts()
    testRehearsalContracts()
    testValidateOnlyWiring()
    console.log('JP local repair production readiness tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
