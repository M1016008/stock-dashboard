import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  assertSyntheticEnvironment, createOwcDevelopmentRuntime, syntheticChildEnv, type SyntheticRuntime,
} from '../lib/synthetic-isolation'
import {
  assertDevelopmentArtifactRoot, assertSqliteQuickCheck, cloneDatabase, fileSha256, fileSizeMb,
  fixtureKey, fixtureRoot, masterFixturePath, stableStringify, type FixtureSpec,
} from './lib/fixture-utils'
import type { BenchScenario, ScenarioModule, Tree } from './lib/scenario'
import { round, summarize, type Summary } from './lib/stats'
import type { DigestRecord, WorkerJob, WorkerResult } from './worker'

/**
 * Reproducible search-route benchmark driver.
 *
 *   tsx scripts/bench/run-search-bench.ts --scenarios scripts/bench/scenarios/<file>.ts[,<file>…]
 *        [--only <regex>] [--trees baseline,after] [--baseline-root /tmp/sb-xcheck/baseline]
 *        [--after-root <worktree>] [--cold N] [--warm N] [--concurrency 1,4,8] [--out <dir>]
 *        [--quick] [--list] [--keep-prepared] [--no-plans]
 *
 * Every process runs under the synthetic isolation envelope. Samples of the two
 * trees are interleaved (A B / B A / …) so drift hits both equally.
 */

const workerFile = path.resolve(__dirname, 'worker.ts')
const defaultAfterRoot = path.resolve(__dirname, '..', '..')
const activeWorkers = new Set<ChildProcess>()

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function stopActiveWorkers(): void {
  for (const child of activeWorkers) killProcessGroup(child, 'SIGTERM')
  const timer = setTimeout(() => {
    for (const child of activeWorkers) killProcessGroup(child, 'SIGKILL')
  }, 5_000)
  timer.unref()
}

process.once('SIGINT', stopActiveWorkers)
process.once('SIGTERM', stopActiveWorkers)

interface Args {
  scenarioFiles: string[]
  only: RegExp | null
  trees: Tree[]
  baselineRoot: string
  afterRoot: string
  cold: number | null
  warm: number | null
  concurrency: number[] | null
  out: string
  quick: boolean
  list: boolean
  keepPrepared: boolean
  plans: boolean
  workerTimeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { values.set(name, next); index += 1 } else flags.add(name)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trees = (values.get('trees') ?? 'baseline,after').split(',').map((item) => item.trim()) as Tree[]
  for (const tree of trees) if (tree !== 'baseline' && tree !== 'after') throw new Error(`unknown tree ${tree}`)
  const scenarioFiles = (values.get('scenarios') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (scenarioFiles.length === 0 && !flags.has('help')) throw new Error('--scenarios <file[,file…]> is required')
  return {
    scenarioFiles: scenarioFiles.map((file) => path.resolve(file)),
    only: values.has('only') ? new RegExp(values.get('only')!) : null,
    trees,
    baselineRoot: fs.realpathSync(path.resolve(values.get('baseline-root') ?? '/tmp/sb-xcheck/baseline')),
    afterRoot: fs.realpathSync(path.resolve(values.get('after-root') ?? defaultAfterRoot)),
    cold: values.has('cold') ? Number(values.get('cold')) : null,
    warm: values.has('warm') ? Number(values.get('warm')) : null,
    concurrency: values.has('concurrency') ? values.get('concurrency')!.split(',').map(Number) : null,
    out: path.resolve(values.get('out') ?? path.join(
      process.env.STOCKBOARD_BENCH_RESULTS_ROOT?.trim() || '/tmp/sb-xcheck/perf/results',
      stamp,
    )),
    quick: flags.has('quick'),
    list: flags.has('list'),
    keepPrepared: flags.has('keep-prepared'),
    plans: !flags.has('no-plans'),
    workerTimeoutMs: Number(values.get('worker-timeout-ms') ?? 45 * 60_000),
  }
}

function log(message: string): void {
  console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function moveAcrossVolumes(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const staging = `${destination}.partial-${process.pid}`
    fs.copyFileSync(source, staging)
    fs.renameSync(staging, destination)
    fs.rmSync(source, { force: true })
  }
}

function rootOf(args: Args, tree: Tree): string {
  return tree === 'baseline' ? args.baselineRoot : args.afterRoot
}

function createBenchRuntime(args: Args, label: string): SyntheticRuntime {
  return createOwcDevelopmentRuntime(label, path.join(args.out, '.runtime'))
}

async function runWorker(
  args: Args,
  job: Omit<WorkerJob, 'runtime' | 'resultPath' | 'codeRoot'>,
  runtime: SyntheticRuntime,
): Promise<{ result: WorkerResult; stdout: string; stderr: string; exitCode: number | null }> {
  const codeRoot = rootOf(args, job.tree)
  const resultPath = path.join(runtime.root, `result-${job.mode}.json`)
  const jobPath = path.join(runtime.root, `job-${job.mode}.json`)
  const fullJob: WorkerJob = {
    ...job,
    codeRoot,
    resultPath,
    runtime: {
      root: runtime.root, dbPath: runtime.dbPath, servingCachePath: runtime.servingCachePath,
      usAnalyticsDbPath: runtime.usAnalyticsDbPath, incidentDir: runtime.incidentDir,
    },
  }
  fs.writeFileSync(jobPath, JSON.stringify(fullJob))
  let pathAliasRoot: string | null = null
  let pathAlias: string | null = null
  const pathOverrides: Record<string, string> = {}
  if (runtime.root.startsWith('/Volumes/')) {
    pathAliasRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'sb-bench-'))
    pathAlias = path.join(pathAliasRoot, 'runtime')
    fs.symlinkSync(runtime.root, pathAlias, 'dir')
    for (const [name, value] of Object.entries(runtime.env)) {
      if (value === runtime.root || value.startsWith(`${runtime.root}${path.sep}`)) {
        pathOverrides[name] = path.join(pathAlias, path.relative(runtime.root, value))
      }
    }
  }
  const env = syntheticChildEnv(runtime, {
    ...pathOverrides,
    NODE_OPTIONS: '--max-old-space-size=8192',
    STOCKBOARD_BENCH_FIXTURE_PARAMS: JSON.stringify(job.fixtureParams ?? {}),
  }, 'test')
  assertSyntheticEnvironment(env, runtime.root)
  const tsx = path.join(codeRoot, 'node_modules', '.bin', 'tsx')
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn(tsx, ['--tsconfig', path.join(codeRoot, 'tsconfig.json'), workerFile, jobPath], {
      cwd: codeRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    activeWorkers.add(child)
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-8_000) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000) })
    let killTimer: NodeJS.Timeout | null = null
    const timer = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5_000)
      killTimer.unref()
    }, args.workerTimeoutMs)
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    activeWorkers.delete(child)
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    if (!fs.existsSync(resultPath)) {
      throw new Error(`worker (${job.mode}/${job.tree}) produced no result; exit=${exitCode}\n${stderr.slice(-2_000)}`)
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as WorkerResult
    if (result.error) throw new Error(`worker (${job.mode}/${job.tree}) failed: ${result.error}\n${stderr.slice(-1_500)}`)
    return { result, stdout, stderr, exitCode }
  } finally {
    for (const child of [...activeWorkers]) {
      if (child.exitCode !== null || child.signalCode !== null) activeWorkers.delete(child)
    }
    if (pathAliasRoot) fs.rmSync(pathAliasRoot, { recursive: true, force: true })
  }
}

function command(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20_000 })
}

function treeFingerprint(root: string): Record<string, unknown> {
  const head = command(root, ['rev-parse', 'HEAD']).trim()
  const status = command(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  const hash = createHash('sha256')
  hash.update(command(root, ['diff', '--binary', 'HEAD', '--']))
  const untracked = command(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).sort()
  for (const relative of untracked) {
    hash.update(`\0${relative}\0`)
    const file = path.join(root, relative)
    if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file))
  }
  return {
    root,
    head,
    dirty: status.length > 0,
    statusSha256: createHash('sha256').update(status).digest('hex'),
    contentDiffSha256: hash.digest('hex'),
    changedPaths: status.split('\n').filter(Boolean).length,
  }
}

interface LoadedScenario {
  readonly scenario: BenchScenario
  readonly file: string
}

async function loadScenarios(args: Args): Promise<LoadedScenario[]> {
  const loaded: LoadedScenario[] = []
  const seen = new Set<string>()
  for (const file of args.scenarioFiles) {
    const module = await import(pathToFileURL(file).href) as ScenarioModule
    for (const scenario of module.scenarios) {
      if (seen.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}`)
      seen.add(scenario.id)
      if (args.only && !args.only.test(scenario.id)) continue
      loaded.push({ scenario, file })
    }
  }
  return loaded
}

async function generatorOf(spec: FixtureSpec): Promise<{ modulePath: string; version: number }> {
  const modulePath = path.resolve(__dirname, 'fixtures', `${spec.id}.ts`)
  const module = await import(pathToFileURL(modulePath).href) as { version: number }
  if (!Number.isInteger(module.version)) throw new Error(`fixture ${spec.id} must export an integer version`)
  return { modulePath, version: module.version }
}

async function ensureFixture(args: Args, spec: FixtureSpec): Promise<string> {
  const { modulePath, version } = await generatorOf(spec)
  const master = masterFixturePath(spec, version)
  const metaPath = path.join(path.dirname(master), 'meta.json')
  if (fs.existsSync(master)) {
    if (!fs.existsSync(metaPath)) throw new Error(`fixture ${master} has no integrity metadata; refuse reuse`)
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      spec?: FixtureSpec; version?: number; bytes?: number; sha256?: string; quickCheck?: string
    }
    if (metadata.version !== version || stableStringify(metadata.spec) !== stableStringify(spec)) {
      throw new Error(`fixture ${master} metadata does not match the requested generator contract`)
    }
    const bytes = fs.statSync(master).size
    if (metadata.bytes !== undefined && metadata.bytes !== bytes) throw new Error(`fixture ${master} size mismatch`)
    assertSqliteQuickCheck(master)
    const sha256 = fileSha256(master)
    if (metadata.sha256 && metadata.sha256 !== sha256) throw new Error(`fixture ${master} SHA-256 mismatch`)
    if (!metadata.sha256 || metadata.quickCheck !== 'ok' || metadata.bytes !== bytes) {
      fs.writeFileSync(metaPath, `${JSON.stringify({ ...metadata, spec, version, bytes, sha256, quickCheck: 'ok' }, null, 2)}\n`)
    }
    log(`fixture ${fixtureKey(spec, version)} reused (${fileSizeMb(master)} MB)`)
    return master
  }
  log(`fixture ${fixtureKey(spec, version)} building…`)
  const started = performance.now()
  const runtime = createBenchRuntime(args, 'fixture')
  try {
    await runWorker(args, {
      mode: 'fixture', tree: 'baseline', fixtureModule: modulePath, fixtureParams: { ...spec.params },
    }, runtime)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${runtime.dbPath}${suffix}`, { force: true })
    fs.mkdirSync(path.dirname(master), { recursive: true })
    const staging = `${master}.partial`
    try {
      moveAcrossVolumes(runtime.dbPath, staging)
      assertSqliteQuickCheck(staging)
      const bytes = fs.statSync(staging).size
      const sha256 = fileSha256(staging)
      fs.renameSync(staging, master)
      fs.writeFileSync(metaPath, `${JSON.stringify({
      spec, version, builtAt: new Date().toISOString(), buildMs: Math.round(performance.now() - started),
        sizeMb: fileSizeMb(master), bytes, sha256, quickCheck: 'ok',
      }, null, 2)}\n`)
    } finally {
      fs.rmSync(staging, { force: true })
    }
  } finally {
    runtime.cleanup()
  }
  log(`fixture built in ${Math.round((performance.now() - started) / 1000)} s (${fileSizeMb(master)} MB)`)
  return master
}

async function ensurePrepared(
  args: Args,
  prepared: Map<string, string>,
  preparedDir: string,
  master: string,
  scenario: BenchScenario,
  file: string,
  tree: Tree,
  specKey: string,
): Promise<string> {
  const key = `${specKey}:${tree}:${scenario.prepareKey ?? 'default'}`
  const existing = prepared.get(key)
  if (existing) return existing
  log(`prepare ${tree} :: ${scenario.prepareKey ?? 'default'}`)
  const started = performance.now()
  const runtime = createBenchRuntime(args, 'prepare')
  try {
    cloneDatabase(master, runtime.dbPath)
    await runWorker(args, {
      mode: 'prepare', tree, scenarioFile: file, scenarioId: scenario.id,
      fixtureParams: { ...scenario.fixture.params },
    }, runtime)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${runtime.dbPath}${suffix}`, { force: true })
    fs.mkdirSync(preparedDir, { recursive: true })
    const target = path.join(preparedDir, `${prepared.size}-${tree}.db`)
    moveAcrossVolumes(runtime.dbPath, target)
    prepared.set(key, target)
    log(`prepared in ${Math.round((performance.now() - started) / 1000)} s (${fileSizeMb(target)} MB)`)
    return target
  } finally {
    runtime.cleanup()
  }
}

interface TreeAggregate {
  tree: Tree
  processes: number
  cold: Summary
  coldSql: Summary
  coldStatements: Summary
  warm: Summary
  warmSql: Summary
  warmStatements: Summary
  payloadBytes: Record<string, number>
  statuses: number[]
  ensureReadyMs: Summary
  importMs: Summary
  rssAfterColdMb: Summary
  rssMaxMb: number
  concurrency: Array<{
    c: number
    wallMs: Summary
    latencyMs: Summary
    sqlStatements: Summary
    consistent: boolean
  }>
  coldConcurrency: Array<{
    c: number
    wallMs: Summary
    latencyMs: Summary
    sqlStatements: Summary
    consistent: boolean
  }>
  plans: WorkerResult['plans']
  topShapes: NonNullable<WorkerResult['cold']>['topShapes'] | null
  digests: Record<string, DigestRecord>
  digestsStableWithinTree: boolean
  loadAvgStartMax: number
}

function aggregate(tree: Tree, results: WorkerResult[], bodies: Record<string, string> | null): TreeAggregate & { bodies: Record<string, string> | null } {
  const colds = results.map((item) => item.cold!).filter(Boolean)
  const warms = results.flatMap((item) => item.warm ?? [])
  const full = results.find((item) => item.concurrency || item.plans) ?? results[0]
  const digestsByKey = new Map<string, Set<string>>()
  for (const item of results) {
    for (const [key, digest] of Object.entries(item.digests ?? {})) {
      const set = digestsByKey.get(key) ?? new Set<string>()
      set.add(`${digest.status}:${digest.normSha}`)
      digestsByKey.set(key, set)
    }
  }
  const concurrency: TreeAggregate['concurrency'] = []
  for (const entry of full.concurrency ?? []) {
    concurrency.push({
      c: entry.c,
      wallMs: summarize(entry.rounds.map((round) => round.wallMs)),
      latencyMs: summarize(entry.rounds.flatMap((round) => [...round.latenciesMs])),
      sqlStatements: summarize(entry.rounds.map((round) => round.sqlStatements)),
      consistent: entry.rounds.every((round) => round.consistent),
    })
  }
  const coldConcurrency: TreeAggregate['coldConcurrency'] = []
  const coldLevels = [...new Set(results.map((item) => item.coldConcurrency?.c).filter((value): value is number => value !== undefined))]
  for (const c of coldLevels) {
    const rounds = results.map((item) => item.coldConcurrency).filter((item): item is NonNullable<WorkerResult['coldConcurrency']> => item?.c === c)
    coldConcurrency.push({
      c,
      wallMs: summarize(rounds.map((round) => round.wallMs)),
      latencyMs: summarize(rounds.flatMap((round) => [...round.latenciesMs])),
      sqlStatements: summarize(rounds.map((round) => round.sqlStatements)),
      consistent: rounds.every((round) => round.consistent),
    })
  }
  return {
    tree,
    processes: results.length,
    cold: summarize(colds.map((item) => item.ms)),
    coldSql: summarize(colds.map((item) => item.sqlMs)),
    coldStatements: summarize(colds.map((item) => item.sqlStatements)),
    warm: summarize(warms.map((item) => item.ms)),
    warmSql: summarize(warms.map((item) => item.sqlMs)),
    warmStatements: summarize(warms.map((item) => item.sqlStatements)),
    payloadBytes: Object.fromEntries(Object.entries(full.digests ?? {}).map(([key, digest]) => [key, digest.bytes])),
    statuses: [...new Set([...colds.map((item) => item.status), ...warms.map((item) => item.status)])].sort(),
    ensureReadyMs: summarize(results.map((item) => item.ensureReadyMs)),
    importMs: summarize(results.map((item) => item.importMs)),
    rssAfterColdMb: summarize(results.map((item) => item.rss?.afterColdMb ?? Number.NaN).filter(Number.isFinite)),
    rssMaxMb: Math.max(...results.map((item) => item.rss?.maxMb ?? 0)),
    concurrency,
    coldConcurrency,
    plans: full.plans,
    topShapes: full.cold?.topShapes ?? null,
    digests: full.digests ?? {},
    digestsStableWithinTree: results.every((item) => item.digestStable !== false)
      && [...digestsByKey.values()].every((set) => set.size === 1),
    loadAvgStartMax: Math.max(...results.map((item) => item.loadAvgStart[0] ?? 0)),
    bodies,
  }
}

interface Difference {
  readonly path: string
  readonly baseline: unknown
  readonly after: unknown
}

function diffJson(left: unknown, right: unknown, at: string, out: Difference[], limit = 25): void {
  if (out.length >= limit) return
  if (left === right) return
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') {
    const bothNaN = typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)
    if (!bothNaN) out.push({ path: at, baseline: truncate(left), after: truncate(right) })
    return
  }
  if (Array.isArray(left) !== Array.isArray(right)) { out.push({ path: at, baseline: truncate(left), after: truncate(right) }); return }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push({ path: `${at}.length`, baseline: left.length, after: right.length })
    for (let index = 0; index < Math.min(left.length, right.length) && out.length < limit; index += 1) {
      diffJson(left[index], right[index], `${at}[${index}]`, out, limit)
    }
    return
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
    if (out.length >= limit) return
    if (!(key in leftRecord)) out.push({ path: `${at}.${key}`, baseline: '<absent>', after: truncate(rightRecord[key]) })
    else if (!(key in rightRecord)) out.push({ path: `${at}.${key}`, baseline: truncate(leftRecord[key]), after: '<absent>' })
    else diffJson(leftRecord[key], rightRecord[key], `${at}.${key}`, out, limit)
  }
}

function truncate(value: unknown): unknown {
  const text = JSON.stringify(value)
  return text && text.length > 160 ? `${text.slice(0, 157)}…` : value
}

interface ScenarioReport {
  id: string
  title: string
  priority: 'A' | 'B'
  market: string
  fixture: FixtureSpec
  trees: Partial<Record<Tree, TreeAggregate>>
  equivalence?: {
    status: 'EQUAL' | 'DIFFERENT' | 'NOT_COMPARED'
    stableBaseline?: boolean
    stableAfter?: boolean
    keys: Array<{ key: string; baselineSha?: string; afterSha?: string; equal: boolean; statusBaseline?: number; statusAfter?: number; differences?: Difference[] }>
  }
  notes?: string
  normalizeNotes?: string
}

function treeDigestsEqual(report: ScenarioReport, baselineBodies: Record<string, string> | null, afterBodies: Record<string, string> | null, scenario: BenchScenario): ScenarioReport['equivalence'] {
  const baseline = report.trees.baseline
  const after = report.trees.after
  if (!baseline || !after) return { status: 'NOT_COMPARED', keys: [] }
  const keys = [...new Set([...Object.keys(baseline.digests), ...Object.keys(after.digests)])].sort()
  const entries: NonNullable<ScenarioReport['equivalence']>['keys'] = []
  for (const key of keys) {
    const left = baseline.digests[key]
    const right = after.digests[key]
    const equal = Boolean(left && right && left.normSha === right.normSha && left.status === right.status)
    const entry: NonNullable<ScenarioReport['equivalence']>['keys'][number] = {
      key, baselineSha: left?.normSha.slice(0, 16), afterSha: right?.normSha.slice(0, 16), equal,
      statusBaseline: left?.status, statusAfter: right?.status,
    }
    if (!equal && baselineBodies?.[key] && afterBodies?.[key]) {
      try {
        const differences: Difference[] = []
        const parse = (text: string) => {
          const parsed = JSON.parse(text) as unknown
          return scenario.normalize ? scenario.normalize(parsed) : parsed
        }
        diffJson(parse(baselineBodies[key]), parse(afterBodies[key]), '$', differences)
        entry.differences = differences
      } catch { /* non-JSON bodies are not diffed structurally */ }
    }
    entries.push(entry)
  }
  const stable = baseline.digestsStableWithinTree && after.digestsStableWithinTree
  return {
    status: stable && entries.length > 0 && entries.every((entry) => entry.equal) ? 'EQUAL' : 'DIFFERENT',
    stableBaseline: baseline.digestsStableWithinTree,
    stableAfter: after.digestsStableWithinTree,
    keys: entries,
  }
}

function fmt(summary: Summary | undefined, digits = 1): string {
  if (!summary || summary.n === 0) return '-'
  const p95 = summary.n >= 20 ? String(round(summary.p95, digits)) : 'N/A'
  const p99 = summary.n >= 100 ? String(round(summary.p99, digits)) : 'N/A'
  return `${round(summary.p50, digits)}/${p95}/${p99}`
}

function markdown(reports: ScenarioReport[], meta: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push('# Search benchmark results', '', '```json', JSON.stringify(meta, null, 2), '```', '')
  lines.push('Percentiles are nearest-rank (p50/p95/p99, ms). p95 requires n>=20 and p99 requires n>=100; smaller samples are reported as N/A. Cold = fresh process, DB ready, application caches empty, OS page cache not purged.', '')
  lines.push('| scenario | pri | tree | n cold | cold p50/p95/p99 | n warm | warm p50/p95/p99 | cold SQL ms p50 | cold SQL stmts | payload KB | RSS MB (after cold) | status | equivalence |')
  lines.push('| --- | --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |')
  for (const report of reports) {
    for (const tree of ['baseline', 'after'] as const) {
      const item = report.trees[tree]
      if (!item) continue
      const payload = Object.values(item.payloadBytes).reduce((sum, value) => sum + value, 0) / Math.max(1, Object.keys(item.payloadBytes).length)
      lines.push(`| ${report.id} | ${report.priority} | ${tree} | ${item.cold.n} | ${fmt(item.cold)} | ${item.warm.n} | ${fmt(item.warm, 2)} | ${round(item.coldSql.p50, 1)} | ${round(item.coldStatements.p50, 0)} | ${round(payload / 1024, 1)} | ${round(item.rssAfterColdMb.p50, 0)} | ${item.statuses.join(',')} | ${tree === 'after' ? (report.equivalence?.status ?? '-') : ''} |`)
    }
  }
  lines.push('')
  for (const report of reports) {
    lines.push(`## ${report.id}`, '', report.title, '')
    if (report.notes) lines.push(report.notes, '')
    if (report.normalizeNotes) lines.push(`Normalization: ${report.normalizeNotes}`, '')
    for (const tree of ['baseline', 'after'] as const) {
      const item = report.trees[tree]
      if (!item || item.concurrency.length === 0) continue
      lines.push(`Concurrency (${tree}): ` + item.concurrency.map((entry) =>
        `c=${entry.c} wall p50 ${round(entry.wallMs.p50, 1)} ms, latency p50/p95/p99 ${fmt(entry.latencyMs)}, SQL stmts p50 ${round(entry.sqlStatements.p50, 0)}${entry.consistent ? '' : ' INCONSISTENT'}`).join(' | '))
      lines.push('')
    }
    for (const tree of ['baseline', 'after'] as const) {
      const item = report.trees[tree]
      if (!item || item.coldConcurrency.length === 0) continue
      lines.push(`Cold-miss concurrency (${tree}, one fresh process per sample): ` + item.coldConcurrency.map((entry) =>
        `c=${entry.c} wall p50/p95/p99 ${fmt(entry.wallMs)}, latency p50/p95/p99 ${fmt(entry.latencyMs)}, SQL stmts p50 ${round(entry.sqlStatements.p50, 0)}${entry.consistent ? '' : ' INCONSISTENT'}`).join(' | '))
      lines.push('')
    }
    for (const tree of ['baseline', 'after'] as const) {
      const flagged = (report.trees[tree]?.plans ?? []).filter((plan) => plan.flags.length > 0)
      if (flagged.length === 0) continue
      lines.push(`Plan flags (${tree}):`)
      for (const plan of flagged.slice(0, 8)) lines.push(`- [${plan.flags.join(',')}] ${plan.sql.slice(0, 160)}`)
      lines.push('')
    }
    if (report.equivalence?.status === 'DIFFERENT') {
      lines.push('**EQUIVALENCE DIFFERENCES**', '')
      if (report.equivalence.stableBaseline === false || report.equivalence.stableAfter === false) {
        lines.push(`- output instability: baseline=${report.equivalence.stableBaseline}, after=${report.equivalence.stableAfter}`)
      }
      for (const entry of report.equivalence.keys.filter((item) => !item.equal)) {
        lines.push(`- key \`${entry.key}\`: status ${entry.statusBaseline}→${entry.statusAfter}`)
        for (const difference of entry.differences ?? []) lines.push(`  - ${difference.path}: ${JSON.stringify(difference.baseline)} → ${JSON.stringify(difference.after)}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const fixtureDirectory = process.env.STOCKBOARD_BENCH_FIXTURE_ROOT?.trim()
  if (!fixtureDirectory) throw new Error('STOCKBOARD_BENCH_FIXTURE_ROOT must pin the OWC benchmark fixture directory')
  assertDevelopmentArtifactRoot(fixtureDirectory)
  assertDevelopmentArtifactRoot(args.out)
  assertSyntheticEnvironment({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv)
  const scenarios = await loadScenarios(args)
  if (args.list) {
    for (const { scenario } of scenarios) console.log(`${scenario.priority}\t${scenario.market}\t${scenario.id}\t${scenario.title}`)
    return
  }
  if (scenarios.length === 0) throw new Error('no scenarios selected')
  for (const tree of args.trees) {
    if (!fs.existsSync(path.join(rootOf(args, tree), 'package.json'))) throw new Error(`${tree} root ${rootOf(args, tree)} is not a code tree`)
  }
  fs.mkdirSync(args.out, { recursive: true })
  const preparedDir = path.join(fixtureRoot(), 'prepared', path.basename(args.out))
  const prepared = new Map<string, string>()
  const reports: ScenarioReport[] = []
  const startedAt = new Date().toISOString()

  try {
    for (const { scenario, file } of scenarios) {
      const master = await ensureFixture(args, scenario.fixture)
      const { version } = await generatorOf(scenario.fixture)
      const specKey = fixtureKey(scenario.fixture, version)
      const preparedByTree = new Map<Tree, string>()
      for (const tree of args.trees) {
        preparedByTree.set(tree, await ensurePrepared(args, prepared, preparedDir, master, scenario, file, tree, specKey))
      }

      const coldSamples = args.cold ?? (args.quick ? 2 : (scenario.coldSamples ?? 8))
      const warmPerProcess = args.warm ?? (args.quick ? 3 : (scenario.warmPerProcess ?? 10))
      const concurrency = args.concurrency ?? (args.quick ? [2] : [...(scenario.concurrency ?? [1, 4, 8])])
      const results = new Map<Tree, WorkerResult[]>(args.trees.map((tree) => [tree, []]))
      const bodies = new Map<Tree, Record<string, string> | null>(args.trees.map((tree) => [tree, null]))

      log(`measure ${scenario.id}: ${coldSamples} cold × ${warmPerProcess} warm, concurrency [${concurrency.join(',')}]`)
      for (let round = 0; round < coldSamples; round += 1) {
        const order = round % 2 === 0 ? args.trees : [...args.trees].reverse()
        for (const tree of order) {
          const runtime = createBenchRuntime(args, 'measure')
          try {
            cloneDatabase(preparedByTree.get(tree)!, runtime.dbPath)
            const bodyPath = path.join(runtime.root, 'bodies.json')
            const { result } = await runWorker(args, {
              mode: 'measure', tree, scenarioFile: file, scenarioId: scenario.id, warmPerProcess,
              fixtureParams: { ...scenario.fixture.params },
              concurrency: round === 0 ? concurrency : [], concurrencyRounds: 3,
              capturePlans: round === 0 && args.plans, bodyPath: round === 0 ? bodyPath : undefined,
            }, runtime)
            results.get(tree)!.push(result)
            if (round === 0 && fs.existsSync(bodyPath)) bodies.set(tree, JSON.parse(fs.readFileSync(bodyPath, 'utf8')) as Record<string, string>)
          } finally {
            runtime.cleanup()
          }
        }
      }

      for (const c of concurrency.filter((value) => value > 1)) {
        for (const tree of args.trees) {
          const runtime = createBenchRuntime(args, 'cold-concurrency')
          try {
            cloneDatabase(preparedByTree.get(tree)!, runtime.dbPath)
            const { result } = await runWorker(args, {
              mode: 'cold-concurrency', tree, scenarioFile: file, scenarioId: scenario.id,
              fixtureParams: { ...scenario.fixture.params }, coldConcurrency: c,
            }, runtime)
            results.get(tree)!.push(result)
          } finally {
            runtime.cleanup()
          }
        }
      }

      const report: ScenarioReport = {
        id: scenario.id, title: scenario.title, priority: scenario.priority, market: scenario.market,
        fixture: scenario.fixture, trees: {}, notes: scenario.notes, normalizeNotes: scenario.normalizeNotes,
      }
      for (const tree of args.trees) {
        const { bodies: _ignored, ...rest } = aggregate(tree, results.get(tree)!, bodies.get(tree) ?? null)
        report.trees[tree] = rest
      }
      report.equivalence = treeDigestsEqual(report, bodies.get('baseline') ?? null, bodies.get('after') ?? null, scenario)
      reports.push(report)
      const after = report.trees.after
      const base = report.trees.baseline
      log(`done ${scenario.id}: baseline cold ${fmt(base?.cold)} warm ${fmt(base?.warm, 2)} | after cold ${fmt(after?.cold)} warm ${fmt(after?.warm, 2)} | equivalence ${report.equivalence?.status}`)
      fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify({ startedAt, reports }, null, 2))
    }
  } finally {
    if (!args.keepPrepared) fs.rmSync(preparedDir, { recursive: true, force: true })
  }

  const fixtureContracts = await Promise.all([...new Map(reports.map((report) => [
    stableStringify(report.fixture), report.fixture,
  ])).values()].map(async (spec) => {
    const generator = await generatorOf(spec)
    const master = masterFixturePath(spec, generator.version)
    const metadataPath = path.join(path.dirname(master), 'meta.json')
    return {
      spec,
      generatorVersion: generator.version,
      generatorPath: generator.modulePath,
      generatorSha256: fileSha256(generator.modulePath),
      fixturePath: master,
      fixtureSha256: fileSha256(master),
      fixtureMetadataSha256: fileSha256(metadataPath),
    }
  }))
  const meta = {
    startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    argv: process.argv.slice(2),
    trees: Object.fromEntries(args.trees.map((tree) => [tree, treeFingerprint(rootOf(args, tree))])),
    scenarioFiles: args.scenarioFiles.map((file) => ({ path: file, sha256: fileSha256(file) })),
    fixtureContracts,
    scenarios: reports.length,
  }
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify({ meta, reports }, null, 2))
  fs.writeFileSync(path.join(args.out, 'summary.md'), markdown(reports, meta))
  log(`results: ${args.out}`)
  const different = reports.filter((report) => report.equivalence?.status === 'DIFFERENT')
  if (different.length > 0) {
    log(`EQUIVALENCE FAILED for: ${different.map((report) => report.id).join(', ')}`)
    process.exitCode = 2
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
