import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
  JP_REPAIR_ANALOG_CONTRACT,
  assertJpRepairAnalogMeta,
  jpRepairStageEnvironment,
} from '@/lib/jp-ohlcv-repair-stage-environment'
import {
  assertLaunchdServiceAbsent,
  createLaunchdWriterHoldDriver,
  listLoadedLaunchdLabels,
  readLaunchdWorkingDirectory,
  type CommandRunner,
  type LaunchdRuntimeIdentity,
} from '@/lib/storage/launchd-writer-hold-driver'
import {
  quarantineInSameDirectory,
  restoreFromSameDirectoryQuarantine,
} from '@/lib/storage/same-directory-quarantine'
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
  analog: string
  servingCache: string
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
  heads: Map<string, { gitHead: string; sourceTreeSha256: string; nodeModulesLockSha256: string }>
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
  'gitCommitSha' | 'runtimeSourceTreeSha256' | 'nodeModulesLockSha256' | 'plan' | 'evidence'>,
mutate: RehearsalMutation = {}): JpRepairProductionApproval['rehearsal'] {
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
  const rehearsedAnalog = { realpath: path.join(rehearsal, JP_REPAIR_ANALOG_CONTRACT.basename), inode: 43 }
  const rehearsedServingCache = { realpath: path.join(rehearsal, 'stockboard-serving-cache.db'), inode: 44 }
  const repairPlan = { path: path.join(rehearsal, 'repair-plan.json'), sha256: 'b'.repeat(64),
    approvalSha256: approval.plan.approvalSha256 }
  const approvalPackageSha256 = write('approval-package.json', {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    nodeModulesLockSha256: approval.nodeModulesLockSha256,
    officialEvidence: { sha256: approval.evidence.officialEvidenceSha256 },
    providerContentSha256: approval.evidence.providerContentSha256,
    repairPlan: { ...repairPlan },
    sourceIdentity: source, stages,
    databaseIdentity: { database: { ...rehearsedDatabase, size: 1, mtimeMs: 1 }, wal: null },
    analogIdentity: { database: { ...rehearsedAnalog, size: 1, mtimeMs: 1 }, wal: null },
    servingCacheIdentity: { database: { ...rehearsedServingCache, size: 1, mtimeMs: 1 }, wal: null },
    analogContract: { ...JP_REPAIR_ANALOG_CONTRACT },
  }, mutate.package)
  const executionReceiptSha256 = write('rehearsal-receipt.json', {
    version: 1, status: 'PASS', database: rehearsedDatabase.realpath, gitCommitSha: approval.gitCommitSha,
    sourceTreeSha256: approval.runtimeSourceTreeSha256,
    nodeModulesLockSha256: approval.nodeModulesLockSha256, source, stages, approvalPackageSha256,
  }, mutate.execution)
  const databaseIdentity = { database: { ...rehearsedDatabase, size: 1, sha256: 'd'.repeat(64) }, walBytes: 0 }
  const analogIdentity = { database: { ...rehearsedAnalog, size: 1, sha256: 'a'.repeat(64) }, walBytes: 0 }
  const servingCacheIdentity = { database: { ...rehearsedServingCache, size: 1, sha256: '5'.repeat(64) }, walBytes: 0 }
  const analogContract = { ...JP_REPAIR_ANALOG_CONTRACT }
  const validationReceiptSha256 = write('validation-receipt.json', {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    nodeModulesLockSha256: approval.nodeModulesLockSha256,
    executionReceiptSha256, approvalPackageSha256, source, stageCount: stages.length, sourcePhase: 'derived_complete',
    databaseIdentity: structuredClone(databaseIdentity), analogIdentity: structuredClone(analogIdentity),
    servingCacheIdentity: structuredClone(servingCacheIdentity), analogContract: structuredClone(analogContract),
  }, mutate.validation)
  const finalValidationReceiptSha256 = write(JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME, {
    version: 1, status: 'PASS', gitCommitSha: approval.gitCommitSha, sourceTreeSha256: approval.runtimeSourceTreeSha256,
    nodeModulesLockSha256: approval.nodeModulesLockSha256,
    repairPlan: { ...repairPlan }, executionReceiptSha256, validationReceiptSha256, approvalPackageSha256, source,
    sourcePhase: 'derived_complete', stages: structuredClone(stages),
    databaseIdentity: structuredClone(databaseIdentity), analogIdentity: structuredClone(analogIdentity),
    servingCacheIdentity: structuredClone(servingCacheIdentity), analogContract: structuredClone(analogContract),
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
  const analog = path.join(directory, JP_REPAIR_ANALOG_CONTRACT.basename)
  const analogDb = new DatabaseSync(analog)
  analogDb.exec(`CREATE TABLE analog_sequence_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO analog_sequence_meta VALUES('version','2'),('completed','1'),('source_date','2026-11-06');`)
  analogDb.close()
  const servingCache = path.join(directory, 'stockboard-serving-cache.db')
  const cacheDb = new DatabaseSync(servingCache)
  cacheDb.exec('CREATE TABLE api_serving_cache(namespace TEXT NOT NULL, cache_key TEXT NOT NULL)')
  cacheDb.close()
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
  const nodeModulesLockSha256 = '9'.repeat(64)
  const heads = new Map<string, { gitHead: string; sourceTreeSha256: string; nodeModulesLockSha256: string }>()
  const runtimes = JP_REPAIR_TRIGGER_RUNTIME_LABELS.map((label): JpRepairRuntimeIdentity => {
    const workingDirectory = path.join(directory, 'runtime', label)
    heads.set(workingDirectory, { gitHead: provenance.gitCommitSha, sourceTreeSha256: provenance.runtimeSourceTreeSha256,
      nodeModulesLockSha256 })
    if (label !== 'com.stockboard.web') {
      return { label, kind: 'GIT_WORKTREE', workingDirectory, gitHead: provenance.gitCommitSha, nodeModulesLockSha256,
        artifacts: [] }
    }
    const tree = path.join(workingDirectory, '.next-live')
    fs.mkdirSync(path.join(tree, 'server', 'app'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'BUILD_ID'), 'build-1')
    fs.writeFileSync(path.join(tree, 'server', 'app', 'page.js'), 'compiled-1\n')
    writeStockboardBuildManifest(tree, provenance)
    return { label, kind: 'GIT_WORKTREE', workingDirectory, gitHead: provenance.gitCommitSha, nodeModulesLockSha256,
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
    nodeModulesLockSha256: '8'.repeat(64),
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
    version: 4,
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
    analog: { ...fileBinding(analog), metaVersion: JP_REPAIR_ANALOG_CONTRACT.metaVersion },
    servingCache: fileBinding(servingCache),
    triggerSchema: { contract: JP_REPAIR_TRIGGER_SCHEMA_CONTRACT, initialState: 'ALREADY_PRESENT' },
    storage: { volumeUuid: 'VOLUME-UUID' },
    rehearsal: writeRehearsal(directory, bound),
    services,
    runtimes,
  }
  const approvalPath = path.join(directory, 'approval.json')
  fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2))
  return {
    database, analog, servingCache, official, priceBasis, approvalPath, approval, services, run, loaded, jobs, heads,
    rehearsalReceipt: path.join(directory, 'rehearsal', 'rehearsal-receipt.json'),
  }
}

function fileBinding(file: string): { realpath: string; dev: number; inode: number } {
  const stat = fs.statSync(file)
  return { realpath: fs.realpathSync(file), dev: Number(stat.dev), inode: Number(stat.ino) }
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
    analogPath: fixture.analog,
    servingCachePath: fixture.servingCache,
    officialEvidencePath: fixture.official,
    priceBasisEvidencePath: fixture.priceBasis,
    rehearsalReceiptPath: fixture.rehearsalReceipt,
    now: Date.parse('2026-11-06T01:00:00.000Z'),
    gitCommitSha: () => fixture.approval.gitCommitSha,
    runtimeSourceTreeSha256: () => fixture.approval.runtimeSourceTreeSha256,
    nodeModulesLockSha256: () => '8'.repeat(64),
    inspectStorageVolumeUuid: () => 'volume-uuid',
    inspectDatabase: () => inspect(fixture.database),
    createServiceObserver: (services) => createLaunchdWriterHoldDriver(services, {
      run: fixture.run, uid: 501, verifyLoadedJob: true,
    }),
    assertServiceAbsent: (service) => assertLaunchdServiceAbsent(service, { run: fixture.run, uid: 501 }),
    listLoadedServiceLabels: () => listLoadedLaunchdLabels(JP_REPAIR_SERVICE_LABEL_PREFIX, { run: fixture.run, uid: 501 }),
    inspectRuntime: (service) => observedRuntime(fixture, service, fixture.run),
    ...overrides,
  }
}

function observedRuntime(fixture: Fixture, service: LaunchdRuntimeIdentity, run: CommandRunner) {
  const workingDirectory = readLaunchdWorkingDirectory(service, { run, uid: 501 })
  const git = workingDirectory ? fixture.heads.get(workingDirectory) : undefined
  return { workingDirectory, gitHead: git?.gitHead ?? null, sourceTreeSha256: git?.sourceTreeSha256 ?? null,
    nodeModulesLockSha256: git?.nodeModulesLockSha256 ?? null }
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
  // v2 predates the build manifest contract and v3 the absent-service and
  // dependency contract; neither is accepted.
  for (const version of [2, 3]) {
    const oldSha = writeApproval(fixture, { ...fixture.approval, version: version as unknown as 4 })
    assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: oldSha })),
      ['APPROVAL_INVALID'], `an old v${version} approval`)
  }
  writeApproval(fixture, fixture.approval)

  // Installed dependencies: the preflight checkout and each Git runtime.
  assert.deepEqual(await holdReasons(preflightInput(fixture, { nodeModulesLockSha256: () => '0'.repeat(64) })),
    ['RUNTIME_DEPENDENCY_MISMATCH'])
  assert.deepEqual(await holdReasons(preflightInput(fixture, { nodeModulesLockSha256: () => {
    throw new Error('ENOENT: node_modules/.package-lock.json')
  } })), ['RUNTIME_DEPENDENCY_MISMATCH'])
  const lockless = writeApproval(fixture, { ...fixture.approval, nodeModulesLockSha256: undefined as unknown as string })
  assert.deepEqual(await holdReasons(preflightInput(fixture, { expectedApprovalSha256: lockless })),
    ['RUNTIME_DEPENDENCY_MISMATCH', 'REHEARSAL_RECEIPT_MISMATCH'],
    'an approval without dependency evidence')
  writeApproval(fixture, fixture.approval)
  const runtimeDirectory = fixture.approval.runtimes[1]!.workingDirectory!
  const runtimeHead = fixture.heads.get(runtimeDirectory)!
  fixture.heads.set(runtimeDirectory, { ...runtimeHead, nodeModulesLockSha256: '0'.repeat(64) })
  assert.deepEqual(await holdReasons(preflightInput(fixture)), ['RUNTIME_IDENTITY_MISMATCH'],
    'a runtime reinstalled other dependencies')
  fixture.heads.set(runtimeDirectory, runtimeHead)

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

  // Approval version 4 is reused: the runtime parser has no schema, and the
  // analog and serving cache fields are required by the preflight checks. An
  // approval written before they existed holds instead of being accepted.
  for (const field of ['analog', 'servingCache'] as const) {
    const legacy = structuredClone(fixture.approval) as unknown as Record<string, unknown>
    delete legacy[field]
    const legacySha256 = writeApproval(fixture, legacy as unknown as JpRepairProductionApproval)
    const reasons = await holdReasons(preflightInput(fixture, { expectedApprovalSha256: legacySha256 }))
    assert.ok(reasons.includes(field === 'analog' ? 'ANALOG_IDENTITY_MISMATCH' : 'SERVING_CACHE_IDENTITY_MISMATCH'),
      `an approval v4 without ${field} holds: ${reasons}`)
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
    inspectRuntime: (service) => observedRuntime(fixture, service, pathless),
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
  await rebind({ validation: (document) => { delete document.servingCacheIdentity } }, mismatch,
    'missing serving cache identity')
  await rebind({ validation: (document) => { (document.servingCacheIdentity as { walBytes: number }).walBytes = 8 } },
    mismatch, 'an unsealed serving cache WAL')
  await rebind({ final: (document) => { delete document.servingCacheIdentity } }, mismatch,
    'final without a serving cache identity')
  await rebind({ final: (document) => {
    (document.servingCacheIdentity as { database: { sha256: string } }).database.sha256 = '0'.repeat(64)
  } }, mismatch, 'final with another serving cache content')
  await rebind({ final: (document) => {
    (document.servingCacheIdentity as { database: { inode: number } }).database.inode = 7
  } }, mismatch, 'final with another serving cache inode')
  await rebind({ package: (document) => {
    (document.servingCacheIdentity as { database: { inode: number } }).database.inode = 7
  } }, mismatch, 'package and validation disagree on the serving cache')
  await rebind({ package: (document) => { delete document.analogIdentity } }, mismatch, 'package without analog identity')
  await rebind({ validation: (document) => { (document.analogContract as { metaVersion: number }).metaVersion = 3 } },
    mismatch, 'validation of an analog v3 contract')
  await rebind({ final: (document) => { delete document.analogContract } }, mismatch, 'final without an analog contract')
  await rebind({ package: (document) => { delete document.analogContract } }, mismatch, 'package without an analog contract')
  await rebind({ package: (document) => { (document.analogContract as { metaVersion: number }).metaVersion = 3 } },
    mismatch, 'package of an analog v3 contract')
  await rebind({ final: (document) => {
    (document.analogContract as { basename: string }).basename = 'analog-sequence-jp-v3.db'
  } }, mismatch, 'final of another analog path')
  const otherRole = (document: RehearsalDocument, field: string, basename: string) => {
    const identity = document[field] as { database: { realpath: string } }
    identity.database.realpath = path.join(path.dirname(identity.database.realpath), basename)
  }
  await rebind({
    validation: (document) => otherRole(document, 'analogIdentity', 'analog-sequence-jp-v3.db'),
    final: (document) => otherRole(document, 'analogIdentity', 'analog-sequence-jp-v3.db'),
    package: (document) => otherRole(document, 'analogIdentity', 'analog-sequence-jp-v3.db'),
  }, mismatch, 'an analog identity on the v3 path')
  await rebind({
    validation: (document) => otherRole(document, 'servingCacheIdentity', 'analog-sequence-jp-v2.db'),
    final: (document) => otherRole(document, 'servingCacheIdentity', 'analog-sequence-jp-v2.db'),
    package: (document) => otherRole(document, 'servingCacheIdentity', 'analog-sequence-jp-v2.db'),
  }, mismatch, 'a serving cache identity that is the analog database')
  const sameFile = (document: RehearsalDocument) => {
    (document.servingCacheIdentity as { database: { inode: number } }).database.inode = 43
  }
  await rebind({ validation: sameFile, final: sameFile, package: sameFile }, mismatch,
    'serving cache and analog share an inode')
  const productionCache = fs.realpathSync(fixture.servingCache)
  const onProduction = (document: RehearsalDocument) => {
    (document.servingCacheIdentity as { database: { realpath: string } }).database.realpath = productionCache
  }
  await rebind({ validation: onProduction, final: onProduction, package: onProduction }, mismatch,
    'a rehearsal that ran on the production serving cache')
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
    [(document) => { document.nodeModulesLockSha256 = '0'.repeat(64) }, 'final from another dependency set'],
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

// Main, Analog, and Serving Cache are each bound by realpath, role basename,
// device, inode, and (analog) the deployed meta version.
async function testDatabaseIdentityBindings(): Promise<void> {
  assert.deepEqual(await holdReasons(preflightInput(createFixture('identity-control'))), [])
  const copyOver = (file: string) => {
    const copy = `${file}.copy`
    fs.copyFileSync(file, copy)
    fs.renameSync(copy, file)
  }
  const cases: Array<[string, (fixture: Fixture) => Promise<string[]> | string[], string[]]> = [
    ['analog meta version 3 in the file', (fixture) => {
      sql(fixture.analog, "UPDATE analog_sequence_meta SET value='3' WHERE key='version'")
      return holdReasons(preflightInput(fixture))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['analog meta not completed', (fixture) => {
      sql(fixture.analog, "UPDATE analog_sequence_meta SET value='0' WHERE key='completed'")
      return holdReasons(preflightInput(fixture))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['approval names analog meta version 3', (fixture) => holdReasons(preflightInput(fixture, {
      expectedApprovalSha256: rewrite(fixture, (approval) => { approval.analog.metaVersion = 3; return approval }),
    })), ['ANALOG_IDENTITY_MISMATCH', 'REHEARSAL_RECEIPT_MISMATCH']],
    ['analog path is the v3 file', (fixture) => {
      const v3 = path.join(path.dirname(fixture.analog), 'analog-sequence-jp-v3.db')
      fs.copyFileSync(fixture.analog, v3)
      sql(v3, "UPDATE analog_sequence_meta SET value='3' WHERE key='version'")
      return holdReasons(preflightInput(fixture, { analogPath: v3 }))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['approval binds the v3 analog path', (fixture) => {
      const v3 = path.join(path.dirname(fixture.analog), 'analog-sequence-jp-v3.db')
      fs.copyFileSync(fixture.analog, v3)
      return holdReasons(preflightInput(fixture, {
        analogPath: v3,
        expectedApprovalSha256: rewrite(fixture, (approval) => {
          approval.analog = { ...fileBinding(v3), metaVersion: 2 }
          return approval
        }),
      }))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['the repair-only analog-jp.db path', (fixture) => {
      const old = path.join(path.dirname(fixture.analog), 'analog-jp.db')
      fs.copyFileSync(fixture.analog, old)
      return holdReasons(preflightInput(fixture, {
        analogPath: old,
        expectedApprovalSha256: rewrite(fixture, (approval) => {
          approval.analog = { ...fileBinding(old), metaVersion: 2 }
          return approval
        }),
      }))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['analog identity missing from the approval', (fixture) => holdReasons(preflightInput(fixture, {
      expectedApprovalSha256: rewrite(fixture, (approval) => {
        delete (approval as Partial<JpRepairProductionApproval>).analog
        return approval
      }),
    })), ['ANALOG_IDENTITY_MISMATCH', 'REHEARSAL_RECEIPT_MISMATCH']],
    ['serving cache identity missing from the approval', (fixture) => holdReasons(preflightInput(fixture, {
      expectedApprovalSha256: rewrite(fixture, (approval) => {
        delete (approval as Partial<JpRepairProductionApproval>).servingCache
        return approval
      }),
    })), ['SERVING_CACHE_IDENTITY_MISMATCH']],
    ['analog replaced by a new inode', (fixture) => {
      copyOver(fixture.analog)
      return holdReasons(preflightInput(fixture))
    }, ['ANALOG_IDENTITY_MISMATCH']],
    ['serving cache replaced by a new inode', (fixture) => {
      copyOver(fixture.servingCache)
      return holdReasons(preflightInput(fixture))
    }, ['SERVING_CACHE_IDENTITY_MISMATCH']],
    ['main database replaced by a new inode', (fixture) => {
      copyOver(fixture.database)
      return holdReasons(preflightInput(fixture))
    }, ['DATABASE_IDENTITY_MISMATCH']],
    ['serving cache path substituted', (fixture) => {
      const other = path.join(path.dirname(fixture.servingCache), 'other', 'stockboard-serving-cache.db')
      fs.mkdirSync(path.dirname(other))
      fs.copyFileSync(fixture.servingCache, other)
      return holdReasons(preflightInput(fixture, { servingCachePath: other }))
    }, ['SERVING_CACHE_IDENTITY_MISMATCH']],
    ['serving cache path is the analog database', (fixture) => holdReasons(preflightInput(fixture, {
      servingCachePath: fixture.analog,
    })), ['SERVING_CACHE_IDENTITY_MISMATCH']],
    ['serving cache and analog are one file', (fixture) => holdReasons(preflightInput(fixture, {
      servingCachePath: fixture.analog,
      expectedApprovalSha256: rewrite(fixture, (approval) => {
        approval.servingCache = { ...approval.analog }
        return approval
      }),
    })), ['SERVING_CACHE_IDENTITY_MISMATCH', 'DATABASE_SET_MISMATCH']],
    ['analog is a symlink to the approved file', (fixture) => {
      const link = path.join(path.dirname(fixture.analog), 'analog-sequence-jp-v2.db.link')
      fs.symlinkSync(fixture.analog, link)
      // realpath resolves to the approved file, so this is the same identity.
      return holdReasons(preflightInput(fixture, { analogPath: link }))
    }, []],
  ]
  for (const [note, run, codes] of cases) {
    assert.deepEqual(await run(createFixture(`identity-${note.replace(/\W+/g, '-')}`)), codes, note)
  }
  // The meta reader the rehearsal uses accepts only the deployed contract.
  const fixture = createFixture('identity-meta')
  assert.equal(assertJpRepairAnalogMeta(fixture.analog).version, 2)
  sql(fixture.analog, "UPDATE analog_sequence_meta SET value='3' WHERE key='version'")
  assert.throws(() => assertJpRepairAnalogMeta(fixture.analog), /completed version 2; found version 3/)
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
    nodeModulesLockSha256: 'f'.repeat(64),
    executionReceiptSha256: '2'.repeat(64), validationReceiptSha256: '3'.repeat(64), approvalPackageSha256: '4'.repeat(64),
    source: { approvalSha256 }, sourcePhase: 'derived_complete',
    stages: [{ name: 'snapshots', status: 'PASS' }], databaseIdentity: { walBytes: 0 }, analogIdentity: { walBytes: 0 },
    servingCacheIdentity: { walBytes: 0 }, analogContract: { ...JP_REPAIR_ANALOG_CONTRACT },
  }
  const finalPath = path.join(directory, JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME)
  assert.equal(verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), false, 'missing is written once')
  fs.writeFileSync(finalPath, `${JSON.stringify(receipt, null, 2)}\n`)
  assert.equal(verifyExistingJpRepairFinalValidationReceipt(finalPath, receipt), true, 'an identical rerun verifies')
  for (const [other, note] of [
    [{ ...receipt, gitCommitSha: '0'.repeat(40) }, 'another revision'],
    [{ ...receipt, nodeModulesLockSha256: '0'.repeat(64) }, 'another installed dependency set'],
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
  const nodeModulesLockSha256 = 'd'.repeat(64)
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
      nodeModulesLockSha256,
      repairPlan: { path: files.plan, sha256: sha256(fs.readFileSync(files.plan)), approvalSha256 },
      sourceIdentity: source, stages,
    }
    fs.writeFileSync(files.package, json(approvalPackage))
    const execution = {
      status: 'PASS', gitCommitSha: commit, sourceTreeSha256: sourceTree, source, stages,
      nodeModulesLockSha256,
      approvalPackageSha256: sha256(fs.readFileSync(files.package)),
    }
    fs.writeFileSync(files.receipt, json(execution))
    fs.writeFileSync(files.validation, json({
      version: 1, status: 'PASS', gitCommitSha: commit, sourceTreeSha256: sourceTree,
      nodeModulesLockSha256,
      executionReceiptSha256: sha256(fs.readFileSync(files.receipt)),
      approvalPackageSha256: execution.approvalPackageSha256, source, stageCount: stages.length,
      sourcePhase: 'derived_complete', databaseIdentity: identity, analogIdentity: identity,
      servingCacheIdentity: identity, analogContract: { ...JP_REPAIR_ANALOG_CONTRACT },
    }))
    const bind = (head = commit) => bindValidateOnlyReceipts({
      database: files.database, receipt: files.receipt, gitHeadSha: head, sourceTreeSha256: sourceTree,
      nodeModulesLockSha256,
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

const US_EARNINGS = 'com.stockboard.us-earnings'

function sql(database: string, statement: string): void {
  const db = new DatabaseSync(database)
  try { db.exec(statement) } finally { db.close() }
}

function usEarningsPlist(fixture: Fixture): string {
  return fixture.services.find((service) => service.label === US_EARNINGS)!.plistPath
}

// us-earnings is not installed: it stays in the required list as an approved
// absence bound to its exact expected plist path.
function approveUsEarningsAbsent(fixture: Fixture): void {
  const plistPath = usEarningsPlist(fixture)
  fs.rmSync(plistPath)
  fixture.loaded.delete(US_EARNINGS)
  fixture.approval.services = fixture.approval.services.map((service) => service.label === US_EARNINGS
    ? { label: US_EARNINGS, absent: true as const, plistPath } : service)
  writeApproval(fixture, fixture.approval)
}

async function testApprovedAbsentService(): Promise<void> {
  const fixture = createFixture('absent')
  const expect = async (expectedApprovalSha256: string | undefined, codes: string[], note: string) => {
    assert.deepEqual(await holdReasons(preflightInput(fixture, expectedApprovalSha256 ? { expectedApprovalSha256 } : {})),
      codes, note)
    writeApproval(fixture, fixture.approval)
  }
  const plist = usEarningsPlist(fixture)
  fs.renameSync(plist, `${plist}.moved`)
  fixture.loaded.delete(US_EARNINGS)
  await expect(undefined, ['SERVICE_IDENTITY_MISMATCH'], 'a missing service approved as present is never skipped')
  fs.renameSync(`${plist}.moved`, plist)
  approveUsEarningsAbsent(fixture)
  await expect(undefined, [], 'an approved absence with no plist and no loaded job passes')
  assert.equal(JP_REPAIR_SERVICE_LABELS.includes(US_EARNINGS), true, 'us-earnings stays in the required contract')
  await expect(rewrite(fixture, (approval) => ({
    ...approval, services: approval.services.filter((service) => service.label !== US_EARNINGS),
  })), ['SERVICE_SET_MISMATCH'], 'dropping the service is not an absence approval')

  // The definition appears (file or dangling symlink) or the label loads.
  fs.writeFileSync(plist, 'reinstalled\n')
  await expect(undefined, ['APPROVED_ABSENT_SERVICE_PRESENT'], 'the plist appeared')
  fs.rmSync(plist)
  fs.symlinkSync(path.join(root, 'nowhere.plist'), plist)
  await expect(undefined, ['APPROVED_ABSENT_SERVICE_PRESENT'], 'a dangling symlink at the plist path')
  fs.unlinkSync(plist)
  assert.equal(fs.lstatSync(plist, { throwIfNoEntry: false }), undefined)
  fixture.loaded.add(US_EARNINGS)
  await expect(undefined, ['UNKNOWN_LOADED_SERVICE', 'APPROVED_ABSENT_SERVICE_PRESENT'], 'the absent label is loaded')
  fixture.loaded.delete(US_EARNINGS)
  fixture.loaded.add('com.stockboard.new-db-writer')
  await expect(undefined, ['UNKNOWN_LOADED_SERVICE'], 'an unknown loaded label still holds')
  fixture.loaded.delete('com.stockboard.new-db-writer')

  // The exact expected path: basename, LaunchAgents directory, absolute.
  const relocated = (plistPath: string) => rewrite(fixture, (approval) => {
    approval.services = approval.services.map((service) => service.label === US_EARNINGS
      ? { label: US_EARNINGS, absent: true as const, plistPath } : service)
    return approval
  })
  for (const [other, note] of [
    [path.join(path.dirname(plist), 'com.stockboard.other.plist'), 'another basename'],
    [path.join(root, 'elsewhere', `${US_EARNINGS}.plist`), 'another directory'],
    [`LaunchAgents/${US_EARNINGS}.plist`, 'a relative path'],
  ] as const) {
    await expect(relocated(other), ['APPROVED_ABSENT_SERVICE_PRESENT'], note)
  }
  // Absence is approvable for us-earnings only, and only as `absent: true`.
  const monitor = 'com.stockboard.dev-capacity-monitor'
  await expect(rewrite(fixture, (approval) => {
    approval.services = approval.services.map((service) => service.label === monitor
      ? { label: monitor, absent: true as const, plistPath: (service as LaunchdRuntimeIdentity).plistPath } : service)
    return approval
  }), ['SERVICE_SET_MISMATCH', 'UNKNOWN_LOADED_SERVICE', 'APPROVED_ABSENT_SERVICE_PRESENT'], 'absence of another label')
  await expect(rewrite(fixture, (approval) => {
    approval.services = approval.services.map((service) => service.label === US_EARNINGS
      ? { label: US_EARNINGS, absent: 'yes', plistPath: plist } as unknown as LaunchdRuntimeIdentity : service)
    return approval
  }), ['SERVICE_IDENTITY_MISMATCH'], 'a non-boolean absent flag is a present service')
  const denied: CommandRunner = (file, args, timeoutMs) => file === '/bin/launchctl' && args[0] === 'print'
    ? { status: 5, signal: null, stdout: '', stderr: 'Operation not permitted' } : fixture.run(file, args, timeoutMs)
  assert.throws(() => assertLaunchdServiceAbsent({ label: US_EARNINGS, plistPath: plist }, { run: denied, uid: 501 }),
    /LAUNCHCTL_PRINT_FAILED/, 'an unreadable launchd state is not absence')
}

function testQuarantinePrimitive(): void {
  const directory = path.join(root, 'quarantine')
  fs.mkdirSync(directory)
  const original = path.join(directory, 'stockboard.db')
  sql(original, "CREATE TABLE t(v TEXT); INSERT INTO t VALUES('sealed')")
  const stat = fs.statSync(original)
  const identity = { originalPath: original, quarantinedPath: path.join(directory, '.stockboard.db.q'),
    dev: Number(stat.dev), inode: Number(stat.ino) }
  const before = sha256(fs.readFileSync(original))
  const replaceWithCopy = (file: string) => {
    fs.copyFileSync(file, `${file}.copy`)
    fs.renameSync(`${file}.copy`, file)
  }

  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.writeFileSync(`${original}${suffix}`, '')
    assert.throws(() => quarantineInSameDirectory(identity), /QUARANTINE_COMPANION_PRESENT/, suffix)
    fs.rmSync(`${original}${suffix}`)
  }
  assert.throws(() => quarantineInSameDirectory({ ...identity, quarantinedPath: path.join(root, '.elsewhere') }),
    /QUARANTINE_NOT_SAME_DIRECTORY/)
  fs.symlinkSync(directory, path.join(root, 'quarantine-link'))
  assert.throws(() => quarantineInSameDirectory({ ...identity,
    originalPath: path.join(root, 'quarantine-link', 'stockboard.db'),
    quarantinedPath: path.join(root, 'quarantine-link', '.stockboard.db.q') }), /QUARANTINE_DIRECTORY_NOT_REALPATH/)
  assert.throws(() => quarantineInSameDirectory({ ...identity, inode: identity.inode + 1 }), /QUARANTINE_IDENTITY_MISMATCH/)
  fs.linkSync(original, path.join(directory, 'alias.db'))
  assert.throws(() => quarantineInSameDirectory(identity), /QUARANTINE_LINK_COUNT_MISMATCH/, 'a hard-linked database')
  fs.rmSync(path.join(directory, 'alias.db'))
  fs.writeFileSync(identity.quarantinedPath, 'occupied')
  assert.throws(() => quarantineInSameDirectory(identity), /EEXIST/, 'an existing target is never replaced')
  assert.equal(fs.readFileSync(identity.quarantinedPath, 'utf8'), 'occupied')
  fs.rmSync(identity.quarantinedPath)
  assert.equal(sha256(fs.readFileSync(original)), before, 'refused quarantines changed nothing')

  const quarantine = quarantineInSameDirectory(identity)
  assert.equal(fs.existsSync(original), false)
  assert.equal(fs.statSync(identity.quarantinedPath).ino, stat.ino)
  assert.throws(() => restoreFromSameDirectoryQuarantine({
    ...quarantine,
    originalPath: path.join(root, 'other', 'stockboard.db'),
  }), /QUARANTINE_NOT_SAME_DIRECTORY/, 'restore revalidates the same-directory contract')
  fs.writeFileSync(`${identity.quarantinedPath}-wal`, '')
  assert.throws(() => restoreFromSameDirectoryQuarantine(quarantine), /QUARANTINE_COMPANION_PRESENT/)
  fs.rmSync(`${identity.quarantinedPath}-wal`)
  sql(original, 'SELECT 1')
  assert.throws(() => restoreFromSameDirectoryQuarantine(quarantine), /EEXIST/, 'a recreated original path')
  assert.equal(sha256(fs.readFileSync(identity.quarantinedPath)), before, 'the refused restore changed nothing')
  fs.rmSync(original)
  restoreFromSameDirectoryQuarantine(quarantine)
  assert.equal(sha256(fs.readFileSync(original)), before)
  assert.equal(fs.statSync(original).ino, stat.ino)
  assert.equal(fs.existsSync(identity.quarantinedPath), false)

  const drifted = quarantineInSameDirectory(identity)
  replaceWithCopy(drifted.quarantinedPath)
  assert.throws(() => restoreFromSameDirectoryQuarantine(drifted), /QUARANTINE_IDENTITY_MISMATCH/, 'inode drift')
  assert.equal(fs.existsSync(original), false, 'a refused restore is not retried or forced')
}

function testStageEnvironment(): void {
  const directory = path.join(root, 'stage-env')
  fs.mkdirSync(directory)
  const paths = {
    database: path.join(directory, 'stockboard.db'),
    servingCache: path.join(directory, 'stockboard-serving-cache.db'),
    analog: path.join(directory, 'analog-sequence-jp-v2.db'),
    analogMetaVersion: 2,
  }
  const caller: NodeJS.ProcessEnv = {
    ...process.env, LOCAL_DB_PATH: '/Volumes/production/stockboard.db',
    US_ANALYTICS_DB_PATH: '/Volumes/production/stockboard-us.db', STOCKBOARD_DB_PATH: '/Volumes/production/stockboard.db',
    SERVING_CACHE_DB_PATH: '/Volumes/production/stockboard-serving-cache.db',
    ANALOG_JP_DB_PATH: '/Volumes/production/analog-sequence-jp-v2.db',
    ANALOG_US_DB_PATH: '/Volumes/production/analog-us.db',
    MA_TRAJECTORY_SHADOW_DB_PATH: '/Volumes/production/ma-trajectory-shadow.db',
    MA_TRAJECTORY_SHADOW_DB_PATH_JP: '/Volumes/production/ma-trajectory-shadow-jp.db',
    STOCKBOARD_SOURCE_DB_PATH: '/Volumes/production/source.db',
    READONLY_SQLITE_DB_PATH: '/Volumes/production/readonly.db',
    PHASE16D_SOURCE_FIXTURE_DB: '/Volumes/production/phase16d.db',
    STOCKBOARD_DB_ROLE: 'us-analytics',
    TURSO_DATABASE_URL: 'libsql://production.example.invalid',
    TURSO_AUTH_TOKEN: 'secret',
  }
  const env = jpRepairStageEnvironment(caller, paths)
  assert.deepEqual([env.STOCKBOARD_DB_PATH, env.SERVING_CACHE_DB_PATH, env.ANALOG_JP_DB_PATH, env.USE_LOCAL_DB,
    env.JP_REPAIR_ANALOG_META_VERSION], [paths.database, paths.servingCache, paths.analog, '1', '2'])
  for (const name of ['LOCAL_DB_PATH', 'US_ANALYTICS_DB_PATH', 'ANALOG_US_DB_PATH', 'MA_TRAJECTORY_SHADOW_DB_PATH',
    'MA_TRAJECTORY_SHADOW_DB_PATH_JP', 'STOCKBOARD_SOURCE_DB_PATH', 'READONLY_SQLITE_DB_PATH',
    'PHASE16D_SOURCE_FIXTURE_DB', 'STOCKBOARD_DB_ROLE', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
    assert.equal(name in env, false, `leaked ${name} is removed`)
  }
  assert.equal(caller.LOCAL_DB_PATH, '/Volumes/production/stockboard.db', 'the caller environment is not mutated')
  for (const [change, note] of [
    [{ analog: path.join(directory, 'analog-jp.sqlite') }, 'the old analog basename'],
    [{ analog: path.join(directory, 'analog-jp.db') }, 'the repair-only v1 analog basename'],
    [{ analog: path.join(directory, 'analog-sequence-jp-v3.db') }, 'the v3 analog path'],
    [{ analogMetaVersion: 3 }, 'analog meta version 3'],
    [{ servingCache: path.join(directory, 'api-serving-cache.sqlite') }, 'the old serving cache basename'],
    [{ database: 'stockboard.db' }, 'a relative database path'],
  ] as const) {
    assert.throws(() => jpRepairStageEnvironment(caller, { ...paths, ...change }), /production basenames/, note)
  }
  // What the stage libraries actually resolve under that environment.
  const resolved = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const load = async (file, name) => { const module = await import(file); return module[name] ?? module.default[name] }
    const localDbPath = await load('./lib/db/client.ts', 'localDbPath')
    const servingCache = await load('./lib/api/serving-cache.ts', 'resolveServingCacheDbPath')
    const analog = await load('./lib/db/analog-sequence-index.ts', 'resolveAnalogSequenceIndexPath')
    console.log(JSON.stringify([localDbPath, servingCache(), analog('JP')]))
  `], { cwd: process.cwd(), env: { ...env, SKIP_SCHEMA_ENSURE: '1' }, encoding: 'utf8' })
  assert.equal(resolved.status, 0, resolved.stderr)
  assert.deepEqual(JSON.parse(resolved.stdout.trim().split('\n').at(-1)!),
    [paths.database, paths.servingCache, paths.analog].map((file) => fs.realpathSync(path.dirname(file)) + path.sep
      + path.basename(file)))
  // The rehearsal uses it for every child and re-checks the revision per stage.
  const rehearsal = fs.readFileSync(path.resolve('scripts/rehearse-jp-local-repair-derived.ts'), 'utf8')
  assert.doesNotMatch(rehearsal, /api-serving-cache\.sqlite|analog-jp\.sqlite/)
  assert.match(rehearsal, /const common = \{\n {4}\.\.\.stageEnvironment,/)
  assert.match(rehearsal,
    /if \(item\.status === 'PASS'\)[\s\S]*assertRevisionUnchanged\(gitCommitSha, sourceTree, nodeModulesLockSha256\)[\s\S]*recordJpRepairStage\(cli\.receipt, receipt, item\)/)
  // Every stage command runs between the in-flight mark and its receipt, after the hold hook.
  assert.match(rehearsal, /await hooks\.beforeStage\?\.\(stage\.name\)[\s\S]*beginJpRepairStage\(cli\.receipt, receipt, stage\.name\)\n {4}for \(const \[index, execution\] of executions\.entries\(\)\)/)
}

async function main(): Promise<void> {
  try {
    testRuntimeManifest()
    testCoverageSplit()
    await testPreflight()
    await testContractBindings()
    await testRehearsalReceipts()
    await testDatabaseIdentityBindings()
    testRehearsalContracts()
    testValidateOnlyWiring()
    await testApprovedAbsentService()
    testQuarantinePrimitive()
    testStageEnvironment()
    console.log('JP local repair production readiness tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
