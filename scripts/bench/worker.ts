import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { assertSyntheticEnvironment, type SyntheticRuntime } from '../lib/synthetic-isolation'
import {
  explainShapes, installSqlProbe, resetSqlProbe, snapshotSqlProbe,
  type PlanFlag, type SqlShapeStats,
} from './lib/sql-probe'
import {
  importFromRoot, type BenchScenario, type CallRouteOptions, type RouteResponse,
  type ScenarioModule, type Tree, type WorkerContext,
} from './lib/scenario'
import { stableStringify } from './lib/fixture-utils'

/**
 * One benchmark worker = one fresh Node process = one cold-start sample.
 * All configuration arrives through a job file; the isolation envelope has been
 * applied by the driver and is re-verified here before any application import.
 */

export interface WorkerRuntimePaths {
  readonly root: string
  readonly dbPath: string
  readonly servingCachePath: string
  readonly usAnalyticsDbPath: string
  readonly incidentDir: string
}

export interface WorkerJob {
  readonly mode: 'fixture' | 'prepare' | 'measure' | 'cold-concurrency'
  readonly tree: Tree
  readonly codeRoot: string
  readonly runtime: WorkerRuntimePaths
  readonly resultPath: string
  /** mode=fixture */
  readonly fixtureModule?: string
  readonly fixtureParams?: Record<string, number | string | boolean>
  /** mode=prepare|measure */
  readonly scenarioFile?: string
  readonly scenarioId?: string
  readonly bodyPath?: string
  readonly warmPerProcess?: number
  readonly concurrency?: readonly number[]
  readonly concurrencyRounds?: number
  readonly coldConcurrency?: number
  readonly capturePlans?: boolean
}

export interface ShapeSummary {
  readonly sql: string
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
  readonly rows: number
}

export interface TimedSample {
  readonly ms: number
  readonly sqlMs: number
  readonly sqlStatements: number
  readonly bytes: number
  readonly status: number
}

export interface ConcurrencyRound {
  readonly wallMs: number
  readonly latenciesMs: readonly number[]
  readonly sqlStatements: number
  readonly sqlMs: number
  readonly consistent: boolean
}

export interface ConcurrencyResult {
  readonly c: number
  readonly rounds: readonly ConcurrencyRound[]
}

export interface DigestRecord {
  readonly status: number
  readonly bytes: number
  readonly rawSha: string
  readonly normSha: string
  readonly described?: Record<string, unknown>
}

export interface WorkerResult {
  readonly mode: WorkerJob['mode']
  readonly tree: Tree
  readonly pid: number
  readonly node: string
  readonly loadAvgStart: readonly number[]
  readonly importMs: number
  readonly ensureReadyMs: number
  readonly cold?: TimedSample & {
    readonly topShapes: readonly ShapeSummary[]
    readonly rssBeforeMb: number
    readonly rssAfterMb: number
  }
  readonly warm?: readonly TimedSample[]
  readonly concurrency?: readonly ConcurrencyResult[]
  readonly coldConcurrency?: ConcurrencyRound & { readonly c: number }
  readonly digests?: Record<string, DigestRecord>
  readonly digestStable?: boolean
  readonly plans?: readonly PlanFlag[]
  readonly rss?: { readonly startMb: number; readonly afterColdMb: number; readonly afterWarmMb: number; readonly maxMb: number }
  readonly error?: string
  readonly notes?: readonly string[]
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 ** 2) * 10) / 10
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function summarizeShapes(shapes: readonly SqlShapeStats[], limit = 10): ShapeSummary[] {
  return shapes.slice(0, limit).map((shape) => ({
    sql: shape.sql.slice(0, 400),
    count: shape.count,
    totalMs: Math.round(shape.totalMs * 100) / 100,
    maxMs: Math.round(shape.maxMs * 100) / 100,
    rows: shape.rows,
  }))
}

function toRuntime(paths: WorkerRuntimePaths): SyntheticRuntime {
  return { ...paths, env: {}, cleanup() { /* the driver owns cleanup */ } }
}

function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate)
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute)
  return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
}

async function main(): Promise<void> {
  const jobPath = process.argv[2]
  if (!jobPath) throw new Error('usage: worker.ts <job.json>')
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as WorkerJob
  assertSyntheticEnvironment(process.env, job.runtime.root)
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(job.codeRoot)) {
    throw new Error(`worker cwd ${process.cwd()} must equal the tree under test ${job.codeRoot}`)
  }

  const result: { -readonly [K in keyof WorkerResult]?: WorkerResult[K] } = {
    mode: job.mode, tree: job.tree, pid: process.pid, node: process.version, loadAvgStart: os.loadavg(),
  }
  const writeResult = () => fs.writeFileSync(job.resultPath, JSON.stringify(result))

  try {
    await installSqlProbe()
    const runtime = toRuntime(job.runtime)
    const importStarted = performance.now()
    const dbClient = await importFromRoot<{
      ensureReady(): Promise<void>
      closeLocalClientBeforeExternalWriter?: () => Promise<void>
      localDbPath: string
    }>(job.codeRoot, 'lib/db/client.ts')
    if (canonicalPath(dbClient.localDbPath) !== canonicalPath(runtime.dbPath)) {
      throw new Error('tree resolved a database path different from the synthetic runtime')
    }
    result.importMs = performance.now() - importStarted

    const context: WorkerContext = {
      tree: job.tree,
      codeRoot: job.codeRoot,
      runtime,
      importFromRoot: <T,>(relativePath: string) => importFromRoot<T>(job.codeRoot, relativePath),
      callRoute: (routeFile, url, options) => callRoute(job.codeRoot, routeFile, url, options),
    }

    if (job.mode === 'fixture') {
      const started = performance.now()
      await dbClient.ensureReady()
      result.ensureReadyMs = performance.now() - started
      await dbClient.closeLocalClientBeforeExternalWriter?.()
      const generator = await import(pathToFileURL(path.resolve(job.fixtureModule!)).href) as {
        build(options: { dbPath: string; params: Record<string, number | string | boolean>; log(message: string): void }): Promise<void>
      }
      await generator.build({
        dbPath: runtime.dbPath,
        params: job.fixtureParams ?? {},
        log: (message) => console.error(`[fixture] ${message}`),
      })
      writeResult()
      return
    }

    const scenarioModule = await import(pathToFileURL(path.resolve(job.scenarioFile!)).href) as ScenarioModule
    const scenario = scenarioModule.scenarios.find((candidate) => candidate.id === job.scenarioId)
    if (!scenario) throw new Error(`scenario ${job.scenarioId} not found in ${job.scenarioFile}`)

    if (job.mode === 'prepare') {
      const started = performance.now()
      await dbClient.ensureReady()
      result.ensureReadyMs = performance.now() - started
      await scenario.prepare?.(context)
      const { client } = await importFromRoot<{ client: { execute(sql: string): Promise<unknown> } }>(job.codeRoot, 'lib/db/client.ts')
      await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      await dbClient.closeLocalClientBeforeExternalWriter?.()
      writeResult()
      return
    }

    // ---- measure ----
    const ensureStarted = performance.now()
    await dbClient.ensureReady()
    result.ensureReadyMs = performance.now() - ensureStarted
    await scenario.setup?.(context)
    // Pre-load the module graph so import cost is not charged to the cold request.
    resetSqlProbe()

    const digests = new Map<string, DigestRecord[]>()
    const bodies = new Map<string, string>()
    const assertExpectedStatus = (response: RouteResponse): void => {
      const expected = scenario.expectedStatuses
      if (!expected || expected.includes(response.status)) return
      throw new Error(
        `${scenario.id} returned HTTP ${response.status}; expected ${expected.join(', ')}: ${response.bodyText.slice(0, 800)}`,
      )
    }
    const normalizeResponse = (
      response: RouteResponse,
      scenarioUnderTest: BenchScenario,
    ): { bytes: number; normalizedText: string; described?: Record<string, unknown> } => {
      const bytes = Buffer.byteLength(response.bodyText)
      let normalizedText = response.bodyText
      let described: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(response.bodyText) as unknown
        const normalized = scenarioUnderTest.normalize ? scenarioUnderTest.normalize(parsed) : parsed
        normalizedText = stableStringify(normalized)
        described = scenarioUnderTest.describe?.(parsed)
      } catch { /* non-JSON bodies are compared as raw text */ }
      return { bytes, normalizedText, described }
    }

    const record = (response: RouteResponse, scenarioUnderTest: BenchScenario, captureBody: boolean): number => {
      const key = response.key ?? 'default'
      const { bytes, normalizedText, described } = normalizeResponse(response, scenarioUnderTest)
      const entry: DigestRecord = {
        status: response.status, bytes, rawSha: sha(response.bodyText), normSha: sha(normalizedText), described,
      }
      const list = digests.get(key) ?? []
      list.push(entry)
      digests.set(key, list)
      if (captureBody && !bodies.has(key)) bodies.set(key, response.bodyText)
      return bytes
    }

    const timed = async (iteration: number, captureBody: boolean): Promise<TimedSample> => {
      resetSqlProbe()
      const started = performance.now()
      const response = await scenario.request(context, iteration)
      assertExpectedStatus(response)
      const ms = performance.now() - started
      const snapshot = snapshotSqlProbe()
      const bytes = record(response, scenario, captureBody)
      return { ms, sqlMs: snapshot.totalMs, sqlStatements: snapshot.statements, bytes, status: response.status }
    }

    if (job.mode === 'cold-concurrency') {
      const c = job.coldConcurrency ?? 0
      if (!Number.isInteger(c) || c < 2) throw new Error('cold-concurrency requires coldConcurrency >= 2')
      resetSqlProbe()
      const started = performance.now()
      const latenciesMs: number[] = []
      const responses = await Promise.all(Array.from({ length: c }, async (_, index) => {
        const requestStarted = performance.now()
        const response = await scenario.request(context, 50_000 + index)
        assertExpectedStatus(response)
        latenciesMs.push(performance.now() - requestStarted)
        return response
      }))
      const snapshot = snapshotSqlProbe()
      const byKey = new Map<string, Set<string>>()
      for (const response of responses) {
        const key = response.key ?? 'default'
        const set = byKey.get(key) ?? new Set<string>()
        set.add(sha(normalizeResponse(response, scenario).normalizedText))
        byKey.set(key, set)
        record(response, scenario, false)
      }
      result.coldConcurrency = {
        c,
        wallMs: performance.now() - started,
        latenciesMs,
        sqlStatements: snapshot.statements,
        sqlMs: snapshot.totalMs,
        consistent: [...byKey.values()].every((set) => set.size === 1),
      }
      result.digests = Object.fromEntries([...digests].map(([key, values]) => [key, values[0]]))
      result.digestStable = [...digests.values()].every((values) => (
        values.every((entry) => entry.normSha === values[0].normSha && entry.status === values[0].status)
      ))
      writeResult()
      return
    }

    const startRss = process.memoryUsage().rss
    resetSqlProbe()
    const coldStarted = performance.now()
    const coldResponse = await scenario.request(context, 0)
    assertExpectedStatus(coldResponse)
    const coldMs = performance.now() - coldStarted
    const coldSnapshot = snapshotSqlProbe()
    const coldBytes = record(coldResponse, scenario, true)
    const afterColdRss = process.memoryUsage().rss
    result.cold = {
      ms: coldMs, sqlMs: coldSnapshot.totalMs, sqlStatements: coldSnapshot.statements,
      bytes: coldBytes, status: coldResponse.status,
      topShapes: summarizeShapes(coldSnapshot.shapes), rssBeforeMb: mb(startRss), rssAfterMb: mb(afterColdRss),
    }

    const warm: TimedSample[] = []
    for (let iteration = 1; iteration <= (job.warmPerProcess ?? 0); iteration += 1) {
      warm.push(await timed(iteration, false))
    }
    result.warm = warm
    const afterWarmRss = process.memoryUsage().rss

    const concurrencyResults: ConcurrencyResult[] = []
    for (const c of job.concurrency ?? []) {
      const rounds: ConcurrencyRound[] = []
      for (let round = 0; round < (job.concurrencyRounds ?? 3); round += 1) {
        resetSqlProbe()
        const started = performance.now()
        const latencies: number[] = []
        const responses = await Promise.all(Array.from({ length: c }, async (_, index) => {
          const requestStarted = performance.now()
          const response = await scenario.request(context, 1000 + round * c + index)
          assertExpectedStatus(response)
          latencies.push(performance.now() - requestStarted)
          return response
        }))
        const wallMs = performance.now() - started
        const snapshot = snapshotSqlProbe()
        const byKey = new Map<string, Set<string>>()
        for (const response of responses) {
          const key = response.key ?? 'default'
          const set = byKey.get(key) ?? new Set<string>()
          set.add(sha(normalizeResponse(response, scenario).normalizedText))
          byKey.set(key, set)
          record(response, scenario, false)
        }
        rounds.push({
          wallMs, latenciesMs: latencies, sqlStatements: snapshot.statements, sqlMs: snapshot.totalMs,
          consistent: [...byKey.values()].every((set) => set.size === 1),
        })
      }
      concurrencyResults.push({ c, rounds })
    }
    if (concurrencyResults.length > 0) result.concurrency = concurrencyResults

    const digestRecord: Record<string, DigestRecord> = {}
    let stable = true
    for (const [key, list] of digests) {
      digestRecord[key] = list[0]
      if (list.some((entry) => entry.normSha !== list[0].normSha || entry.status !== list[0].status)) stable = false
    }
    result.digests = digestRecord
    result.digestStable = stable
    result.rss = {
      startMb: mb(startRss), afterColdMb: mb(afterColdRss), afterWarmMb: mb(afterWarmRss),
      maxMb: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10,
    }

    if (job.capturePlans) {
      const planPath = scenario.planDatabase === 'usAnalytics'
        ? runtime.usAnalyticsDbPath
        : scenario.planDatabase === 'analogJp'
          ? path.join(runtime.root, 'analog-jp.db')
          : scenario.planDatabase === 'analogUs'
            ? path.join(runtime.root, 'analog-us.db')
            : runtime.dbPath
      result.plans = fs.existsSync(planPath) ? explainShapes(planPath, coldSnapshot) : []
    }
    if (job.bodyPath && bodies.size > 0) {
      fs.writeFileSync(job.bodyPath, JSON.stringify(Object.fromEntries(bodies)))
    }
    writeResult()
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}`.slice(0, 4000) : String(error)
    writeResult()
    process.exitCode = 1
  }
}

async function callRoute(
  codeRoot: string,
  routeFile: string,
  url: string,
  options: CallRouteOptions = {},
): Promise<RouteResponse> {
  const { NextRequest } = await import('next/server')
  const module = await importFromRoot<Record<string, unknown>>(codeRoot, routeFile)
  const method = options.method ?? 'GET'
  const handler = module[method] as ((request: unknown, context: unknown) => Promise<Response>) | undefined
  if (typeof handler !== 'function') throw new Error(`${routeFile} does not export ${method}`)
  const hasBody = options.body !== undefined && method !== 'GET'
  const request = new NextRequest(url, {
    method,
    headers: hasBody ? { 'content-type': 'application/json', ...options.headers } : options.headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  })
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) })
  const bodyText = await response.text()
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => { headers[name] = value })
  return { status: response.status, bodyText, headers, key: options.key }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
