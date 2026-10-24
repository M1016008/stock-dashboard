import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  assertSyntheticEnvironment, createSyntheticRuntime, syntheticChildEnv, type SyntheticRuntime,
} from '../lib/synthetic-isolation'
import {
  assertDevelopmentArtifactRoot, cloneDatabase, fileSizeMb, fixtureKey, fixtureRoot, masterFixturePath, type FixtureSpec,
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
  const env = syntheticChildEnv(runtime, { NODE_OPTIONS: '--max-old-space-size=8192' }, 'test')
  assertSyntheticEnvironment(env)
  const tsx = path.join(codeRoot, 'node_modules', '.bin', 'tsx')
  const child = spawn(tsx, ['--tsconfig', path.join(codeRoot, 'tsconfig.json'), workerFile, jobPath], {
    cwd: codeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-8_000) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000) })
  const timer = setTimeout(() => child.kill('SIGTERM'), args.workerTimeoutMs)
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  if (!fs.existsSync(resultPath)) {
    throw new Error(`worker (${job.mode}/${job.tree}) produced no result; exit=${exitCode}\n${stderr.slice(-2_000)}`)
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as WorkerResult
  if (result.error) throw new Error(`worker (${job.mode}/${job.tree}) failed: ${result.error}\n${stderr.slice(-1_500)}`)
  return { result, stdout, stderr, exitCode }
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
  if (fs.existsSync(master)) {
    log(`fixture ${fixtureKey(spec, version)} reused (${fileSizeMb(master)} MB)`)
    return master
  }
  log(`fixture ${fixtureKey(spec, version)} building…`)
  const started = performance.now()
  const runtime = createSyntheticRuntime('fixture')
  try {
    await runWorker(args, {
      mode: 'fixture', tree: 'baseline', fixtureModule: modulePath, fixtureParams: { ...spec.params },
    }, runtime)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${runtime.dbPath}${suffix}`, { force: true })
    fs.mkdirSync(path.dirname(master), { recursive: true })
    const staging = `${master}.partial`
    moveAcrossVolumes(runtime.dbPath, staging)
    fs.renameSync(staging, master)
    fs.writeFileSync(path.join(path.dirname(master), 'meta.json'), JSON.stringify({
      spec, version, builtAt: new Date().toISOString(), buildMs: Math.round(performance.now() - started), sizeMb: fileSizeMb(master),
    }, null, 2))
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
  const runtime = createSyntheticRuntime('prepare')
  try {
    cloneDatabase(master, runtime.dbPath)
    await runWorker(args, { mode: 'prepare', tree, scenarioFile: file, scenarioId: scenario.id }, runtime)
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
  return { status: entries.every((entry) => entry.equal) ? 'EQUAL' : 'DIFFERENT', keys: entries }
}

function fmt(summary: Summary | undefined, digits = 1): string {
  if (!summary || summary.n === 0) return '-'
  return `${round(summary.p50, digits)}/${round(summary.p95, digits)}/${round(summary.p99, digits)}`
}

function markdown(reports: ScenarioReport[], meta: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push('# Search benchmark results', '', '```json', JSON.stringify(meta, null, 2), '```', '')
  lines.push('Percentiles are nearest-rank (p50/p95/p99, ms). Cold = fresh process, DB ready, application caches empty, OS page cache not purged.', '')
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
      const flagged = (report.trees[tree]?.plans ?? []).filter((plan) => plan.flags.length > 0)
      if (flagged.length === 0) continue
      lines.push(`Plan flags (${tree}):`)
      for (const plan of flagged.slice(0, 8)) lines.push(`- [${plan.flags.join(',')}] ${plan.sql.slice(0, 160)}`)
      lines.push('')
    }
    if (report.equivalence?.status === 'DIFFERENT') {
      lines.push('**EQUIVALENCE DIFFERENCES**', '')
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
  if (process.env.STOCKBOARD_BENCH_RESULTS_ROOT?.trim()) {
    assertDevelopmentArtifactRoot(process.env.STOCKBOARD_BENCH_RESULTS_ROOT)
  }
  if (process.env.STOCKBOARD_BENCH_FIXTURE_ROOT?.trim()) {
    assertDevelopmentArtifactRoot(process.env.STOCKBOARD_BENCH_FIXTURE_ROOT)
  }
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
          const runtime = createSyntheticRuntime('measure')
          try {
            cloneDatabase(preparedByTree.get(tree)!, runtime.dbPath)
            const bodyPath = path.join(runtime.root, 'bodies.json')
            const { result } = await runWorker(args, {
              mode: 'measure', tree, scenarioFile: file, scenarioId: scenario.id, warmPerProcess,
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

  const meta = {
    startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    trees: Object.fromEntries(args.trees.map((tree) => [tree, rootOf(args, tree)])),
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
