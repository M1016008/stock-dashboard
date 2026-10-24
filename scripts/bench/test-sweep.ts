/**
 * Isolated sweep of every scripts/test-*.ts harness.
 *
 *   nice -n 10 npx tsx scripts/bench/test-sweep.ts --out /tmp/sweep-worktree.json
 *   nice -n 10 npx tsx scripts/bench/test-sweep.ts --root /tmp/sb-xcheck/baseline --out /tmp/sweep-baseline.json
 *   npx tsx scripts/bench/test-sweep.ts --list
 *
 * Contract
 *  - Each test runs in its own fresh SyntheticRuntime (scripts/lib/synthetic-isolation.ts of THIS
 *    checkout, even when --root points at another tree) with an allowlisted child environment:
 *    every database/cache/artifact path lives under the internal temp root, production storage
 *    identity and every credential are absent, NODE_ENV is never `production`.
 *  - `.env*` files are never read and `--env-file*` flags found in package.json scripts are dropped.
 *    Only NON-path, non-secret env assignments from the matching package.json script are carried
 *    over (for example NODE_ENV=test or tuning variables); path-valued variables are re-bound to
 *    the runtime.
 *  - HOME is re-bound to an empty directory inside the runtime so no test can read or write real
 *    user configuration (LaunchAgents, keychains, ~/.claude, ...).
 *  - A preload (written into the runtime directory) refuses every non-loopback TCP connection and DNS
 *    lookup, so no test can reach a paid or external service. Attempts are logged and reported.
 *  - Tests whose source drives the physical backup volume / mounts disk images are NOT executed
 *    (static safety pre-scan) and are reported ENV_BLOCKED.
 *  - Python tests (scripts/test_*.py, scripts/test-*.py) are listed as NOT_TESTED.
 *
 * Status: PASS (exit 0) | FAIL (non-zero exit in a valid isolated env) | TIMEOUT |
 *         ENV_BLOCKED (credentials / network / real DB content / external binary / safety deny) |
 *         NOT_TESTED. A timed-out or env-blocked test is never counted as PASS.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FORBIDDEN_ENVIRONMENT_VARIABLES,
  PATH_ENVIRONMENT_VARIABLES,
  assertSyntheticEnvironment,
  createSyntheticRuntime,
  internalScratchRoots,
  isSyntheticPath,
  syntheticChildEnv,
  type SyntheticRuntime,
} from '../lib/synthetic-isolation'

type Status = 'PASS' | 'FAIL' | 'TIMEOUT' | 'ENV_BLOCKED' | 'NOT_TESTED'

interface Options {
  root: string
  out: string | null
  concurrency: number
  timeoutMs: number
  filter: RegExp | null
  list: boolean
  triage: string | null
  resume: boolean
  applyTriage: boolean
  label: string | null
  keepLogs: string | null
}

interface NpmReference {
  npmScript: string
  env: Record<string, string>
  flags: string[]
  args: string[]
}

interface DroppedItem { name: string; reason: string }

interface TestResult {
  name: string
  script: string
  kind: 'ts' | 'py'
  npmScripts: string[]
  status: Status
  statusAuto: Status
  triaged: boolean
  reason: string
  executed: boolean
  exitCode: number | null
  signal: string | null
  durationMs: number
  nodeEnv: 'test' | 'development'
  carriedEnv: Record<string, string>
  droppedEnv: DroppedItem[]
  droppedFlags: string[]
  args: string[]
  skipSignal: boolean
  networkAttempts: Array<{ kind: string; host: string; port: number | null }>
  outputBytes: number
  outputTruncated: boolean
  tail: string[]
  logPath: string | null
  startedAt: string
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SECRETISH_OR_PATHISH_NAME = /(_PATH|_DIR|_FILE|_ROOT|_URL|_URI|_KEY|_TOKEN|_SECRET|_PASSWORD|_UUID|_BIN|_HOME|_LEDGER)$/
const NEVER_CARRY_NAMES = new Set(['HOME', 'PATH', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'NODE_OPTIONS'])
const SKIP_SIGNAL = /(^|\W)(skip(ped|ping)?|not run|nothing to test)(\W|$)/i

/** Static safety pre-scan: tests matching these are never executed. */
const SAFETY_DENY: Array<{ id: string; test: (source: string) => boolean; reason: string }> = [
  {
    id: 'backup-volume',
    test: (source) => /\/Volumes\/StockBoard Backup/.test(source) && /(diskutil|hdiutil|statfsSync\(\s*MOUNT)/.test(source),
    reason: 'SAFETY_DENY: drives the physical backup volume (/Volumes/StockBoard Backup, diskutil/statfs); forbidden for the sweep',
  },
  {
    id: 'hdiutil',
    test: (source) => /['"`]\/usr\/bin\/hdiutil['"`]|\bhdiutil\b\s*['"`,]/.test(source),
    reason: 'SAFETY_DENY: mounts disk images under /Volumes (hdiutil); forbidden for the sweep',
  },
  {
    id: 'launchctl',
    test: (source) => /(spawn|exec)\w*\(\s*['"`][^'"`]*launchctl/.test(source),
    reason: 'SAFETY_DENY: executes launchctl; forbidden for the sweep',
  },
  {
    id: 'installer',
    test: (source) => /(spawn|exec)\w*\([^)]*(install-local-|deploy-local-web-server)/.test(source),
    reason: 'SAFETY_DENY: executes an install-local-* / deploy installer; forbidden for the sweep',
  },
  {
    id: 'next-start',
    test: (source) => /(spawn|exec)\w*\([^)]*['"`]next['"`]\s*,\s*\[\s*['"`]start['"`]/.test(source),
    reason: 'SAFETY_DENY: starts a production Next server; forbidden for the sweep',
  },
]

/** Output-based environment blockers (applied only to non-zero exits without an assertion failure). */
const ENV_BLOCK_RULES: Array<{ id: string; test: RegExp; reason: string }> = [
  { id: 'network', test: /NETWORK_BLOCKED_BY_SWEEP/, reason: 'needs network access (refused by the sweep preload)' },
  {
    id: 'credentials',
    test: /(JQUANTS_API_KEY|TIINGO_API_KEY|FINNHUB_API_KEY|EDINET_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|TURSO_AUTH_TOKEN|TURSO_DATABASE_URL|LARGE_HOLDER_ADMIN_TOKEN)[^\n]{0,80}(not set|missing|required|undefined|not configured|is empty)/i,
    reason: 'needs credentials that are intentionally absent from the isolated environment',
  },
  {
    id: 'external-binary',
    test: /(ENOENT[^\n]{0,160}(sqlite3|sqlite3_rsync|python3?|\.venv|tailscale|chrome|ffmpeg)|stockboard-sqlite-tools)/i,
    reason: 'needs an external binary that is not present',
  },
]

const NET_BLOCK_PRELOAD = String.raw`'use strict'
// Written by scripts/bench/test-sweep.ts. Refuses every non-loopback TCP connection and DNS lookup.
const fs = require('fs')
const net = require('net')
const dns = require('dns')
const logPath = process.env.SWEEP_NET_LOG
function isLoopback(host) {
  if (host === undefined || host === null || host === '') return true
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\./.test(h) || h.endsWith('.localhost')
}
function record(kind, host, port) {
  try {
    if (logPath) fs.appendFileSync(logPath, JSON.stringify({ kind, host: String(host), port: port == null ? null : Number(port) }) + '\n')
  } catch (error) { /* logging must never break the test */ }
}
function targetOf(args) {
  let a = args[0]
  if (Array.isArray(a)) a = a[0]
  if (a && typeof a === 'object') {
    if (a.path) return { local: true }
    return { host: a.host || 'localhost', port: a.port }
  }
  if (typeof a === 'string' && Number.isNaN(Number(a))) return { local: true }
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: a }
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const target = targetOf(args)
  if (!target.local && !isLoopback(target.host)) {
    record('tcp', target.host, target.port)
    const error = new Error('NETWORK_BLOCKED_BY_SWEEP: connect to ' + target.host + ':' + target.port + ' refused')
    error.code = 'ECONNREFUSED'
    process.nextTick(() => this.destroy(error))
    return this
  }
  return originalConnect.apply(this, args)
}
const originalLookup = dns.lookup
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (!isLoopback(hostname)) {
    record('dns', hostname, null)
    const error = new Error('NETWORK_BLOCKED_BY_SWEEP: dns lookup ' + hostname + ' refused')
    error.code = 'ENOTFOUND'
    process.nextTick(callback, error)
    return {}
  }
  return originalLookup.call(this, hostname, options, callback)
}
if (dns.promises && dns.promises.lookup) {
  const originalPromiseLookup = dns.promises.lookup
  dns.promises.lookup = function (hostname, options) {
    if (!isLoopback(hostname)) {
      record('dns', hostname, null)
      const error = new Error('NETWORK_BLOCKED_BY_SWEEP: dns lookup ' + hostname + ' refused')
      error.code = 'ENOTFOUND'
      return Promise.reject(error)
    }
    return originalPromiseLookup.call(this, hostname, options)
  }
}
`

function usage(): never {
  console.error([
    'Usage: tsx scripts/bench/test-sweep.ts [--root <dir>] [--out <json>] [--concurrency N] [--timeout-ms N]',
    '                                       [--filter <regex>] [--list] [--triage <json>] [--resume] [--label <text>]',
    '                                       [--keep-logs <dir>] [--apply-triage (re-apply --triage to the existing --out and exit)]',
  ].join('\n'))
  process.exit(2)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    root: process.cwd(), out: null, concurrency: 2, timeoutMs: 300_000, filter: null,
    list: false, triage: null, resume: false, applyTriage: false, label: null, keepLogs: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) usage()
      index += 1
      return next
    }
    if (arg === '--root') options.root = path.resolve(value())
    else if (arg === '--out') options.out = path.resolve(value())
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Math.floor(Number(value())) || 1)
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(1000, Math.floor(Number(value())) || 300_000)
    else if (arg === '--filter') options.filter = new RegExp(value())
    else if (arg === '--triage') options.triage = path.resolve(value())
    else if (arg === '--label') options.label = value()
    else if (arg === '--keep-logs') options.keepLogs = path.resolve(value())
    else if (arg === '--list') options.list = true
    else if (arg === '--resume') options.resume = true
    else if (arg === '--apply-triage') options.applyTriage = true
    else usage()
  }
  return options
}

// ---------------------------------------------------------------- package.json parsing

function shellTokens(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  const flush = () => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < input.length) { index += 1; current += input[index] }
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/\s/.test(char)) { flush(); continue }
    if ((char === '&' && input[index + 1] === '&') || (char === '|' && input[index + 1] === '|')) {
      flush(); tokens.push(char + char); index += 1; continue
    }
    if (char === ';' || char === '|') { flush(); tokens.push(char); continue }
    current += char
    started = true
  }
  flush()
  return tokens
}

function indexNpmScripts(root: string): Map<string, NpmReference[]> {
  const byScript = new Map<string, NpmReference[]>()
  const packagePath = path.join(root, 'package.json')
  if (!fs.existsSync(packagePath)) return byScript
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> }
  for (const [npmScript, command] of Object.entries(parsed.scripts ?? {})) {
    const segments: string[][] = [[]]
    for (const token of shellTokens(command)) {
      if (token === '&&' || token === '||' || token === ';' || token === '|') segments.push([])
      else segments[segments.length - 1].push(token)
    }
    for (const segment of segments) {
      const env: Record<string, string> = {}
      let cursor = 0
      while (cursor < segment.length && ENV_ASSIGNMENT.test(segment[cursor])) {
        const eq = segment[cursor].indexOf('=')
        env[segment[cursor].slice(0, eq)] = segment[cursor].slice(eq + 1)
        cursor += 1
      }
      const rest = segment.slice(cursor)
      const targetIndex = rest.findIndex((token) => /(^|\/)scripts\/[^\s]+\.(ts|py)$/.test(token))
      if (targetIndex < 0) continue
      const target = path.basename(rest[targetIndex])
      const flags = rest.slice(0, targetIndex).filter((token) => token.startsWith('--'))
      const args = rest.slice(targetIndex + 1)
      const list = byScript.get(target) ?? []
      list.push({ npmScript, env, flags, args })
      byScript.set(target, list)
    }
  }
  return byScript
}

// ---------------------------------------------------------------- environment policy

interface EnvPlan {
  nodeEnv: 'test' | 'development'
  carried: Record<string, string>
  dropped: DroppedItem[]
  droppedFlags: string[]
  args: string[]
}

function planEnvironment(references: NpmReference[]): EnvPlan {
  const carried: Record<string, string> = {}
  const dropped: DroppedItem[] = []
  const droppedFlags: string[] = []
  let nodeEnv: 'test' | 'development' = 'test'
  const first = references[0]
  if (!first) return { nodeEnv, carried, dropped, droppedFlags, args: [] }
  for (const flag of first.flags) {
    if (/^--env-file(-if-exists)?(=|$)/.test(flag)) droppedFlags.push(flag)
    else droppedFlags.push(`${flag} (unsupported flag not forwarded)`)
  }
  for (const [name, value] of Object.entries(first.env)) {
    if (name === 'NODE_ENV') {
      if (value === 'test' || value === 'development') nodeEnv = value
      else dropped.push({ name, reason: `NODE_ENV=${value} is never forwarded` })
      continue
    }
    if (FORBIDDEN_ENVIRONMENT_VARIABLES.includes(name)) { dropped.push({ name, reason: 'forbidden production identity / credential' }); continue }
    if (PATH_ENVIRONMENT_VARIABLES.includes(name)) { dropped.push({ name, reason: 'path variable re-bound to the synthetic runtime' }); continue }
    if (NEVER_CARRY_NAMES.has(name)) { dropped.push({ name, reason: 'process-level variable is controlled by the sweep' }); continue }
    if (SECRETISH_OR_PATHISH_NAME.test(name)) { dropped.push({ name, reason: 'path/secret-valued variable name' }); continue }
    if (value.includes('/') || value.startsWith('~') || value.startsWith('.')) { dropped.push({ name, reason: 'value looks like a path' }); continue }
    carried[name] = value
  }
  const args: string[] = []
  for (const arg of first.args) {
    if (arg.includes('/') || arg.startsWith('~')) dropped.push({ name: `arg:${arg}`, reason: 'path-valued argument is not forwarded' })
    else args.push(arg)
  }
  return { nodeEnv, carried, dropped, droppedFlags, args }
}

// ---------------------------------------------------------------- execution

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

function lastLines(text: string, count: number): string[] {
  const lines = stripAnsi(text).split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).filter((line) => line.length > 0)
  return lines.slice(-count).map((line) => (line.length > 500 ? `${line.slice(0, 500)}...` : line))
}

const activeChildren = new Set<ChildProcess>()
const activeRuntimes = new Set<SyntheticRuntime>()

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}

const MAX_CAPTURED_BYTES = 8 * 1024 * 1024

interface RunOutcome {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  output: string
  truncated: boolean
  bytes: number
  durationMs: number
  networkAttempts: Array<{ kind: string; host: string; port: number | null }>
}

async function runOne(
  options: Options,
  tsxBinary: string,
  scriptPath: string,
  plan: EnvPlan,
  runtime: SyntheticRuntime,
): Promise<RunOutcome> {
  const homeDir = path.join(runtime.root, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  const preloadPath = path.join(runtime.root, 'sweep-net-block.cjs')
  fs.writeFileSync(preloadPath, NET_BLOCK_PRELOAD)
  const netLog = path.join(runtime.root, 'sweep-net-attempts.ndjson')
  const env = syntheticChildEnv(runtime, {
    ...plan.carried,
    HOME: homeDir,
    NODE_OPTIONS: `--require=${preloadPath}`,
    SWEEP_NET_LOG: netLog,
  }, plan.nodeEnv)
  assertSyntheticEnvironment(env)

  const started = Date.now()
  return new Promise<RunOutcome>((resolve) => {
    const chunks: string[] = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    const child = spawn(tsxBinary, [scriptPath, ...plan.args], {
      cwd: options.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    activeChildren.add(child)
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes - chunk.length >= MAX_CAPTURED_BYTES) { truncated = true; return }
      chunks.push(chunk.toString('utf8'))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref()
    }, options.timeoutMs)
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      clearTimeout(timer)
      activeChildren.delete(child)
      // Reap any stragglers left in the process group.
      killGroup(child, 'SIGKILL')
      let attempts: RunOutcome['networkAttempts'] = []
      try {
        attempts = fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch { /* no attempts logged */ }
      let output = chunks.join('')
      if (spawnError) output += `\n[sweep] spawn error: ${spawnError.message}\n`
      resolve({
        exitCode, signal, timedOut, output, truncated, bytes,
        durationMs: Date.now() - started, networkAttempts: attempts,
      })
    }
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function classify(outcome: RunOutcome): { status: Status; reason: string } {
  if (outcome.timedOut) return { status: 'TIMEOUT', reason: 'killed by the sweep after exceeding the timeout; never counted as PASS' }
  if (outcome.exitCode === 0 && outcome.signal === null) return { status: 'PASS', reason: 'exit 0' }
  const text = stripAnsi(outcome.output)
  const hasAssertion = /AssertionError|ERR_ASSERTION/.test(text)
  if (!hasAssertion) {
    for (const rule of ENV_BLOCK_RULES) {
      if (rule.test.test(text)) return { status: 'ENV_BLOCKED', reason: `${rule.id}: ${rule.reason}` }
    }
  }
  const why = outcome.signal ? `terminated by ${outcome.signal}` : `exit code ${outcome.exitCode}`
  return { status: 'FAIL', reason: hasAssertion ? `assertion failure (${why})` : `non-zero exit (${why})` }
}

function readTriage(file: string | null): Record<string, { status: Status; reason: string }> {
  if (!file || !fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { status: Status; reason: string }>
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function applyTriage(result: TestResult, triage: Record<string, { status: Status; reason: string }>): void {
  const override = triage[result.name] ?? triage[result.script]
  if (override) {
    result.status = override.status
    result.reason = override.reason
    result.triaged = true
  } else {
    result.status = result.statusAuto
    result.triaged = false
  }
}

function totalsOf(results: TestResult[]): Record<string, number> {
  const totals: Record<string, number> = { PASS: 0, FAIL: 0, TIMEOUT: 0, ENV_BLOCKED: 0, NOT_TESTED: 0 }
  for (const result of results) totals[result.status] = (totals[result.status] ?? 0) + 1
  totals.total = results.length
  return totals
}

function assertRootAllowed(root: string): void {
  const real = fs.realpathSync(root)
  const hereRoot = fs.realpathSync(path.resolve(typeof __dirname !== 'undefined' ? __dirname : path.dirname(process.argv[1]), '..', '..'))
  if (real === hereRoot) return
  if (isSyntheticPath(real, internalScratchRoots())) return
  throw new Error(`Refusing --root ${real}: only this checkout or a tree under the internal scratch roots may be swept`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  try { os.setPriority(10) } catch { /* best effort; callers also wrap with nice -n 10 */ }
  if (!fs.existsSync(path.join(options.root, 'scripts'))) throw new Error(`No scripts/ directory under ${options.root}`)
  options.root = fs.realpathSync(options.root)
  assertRootAllowed(options.root)

  const scriptsDir = path.join(options.root, 'scripts')
  const tsxBinary = path.join(options.root, 'node_modules', '.bin', 'tsx')
  if (!options.list && !options.applyTriage && !fs.existsSync(tsxBinary)) throw new Error(`Missing ${tsxBinary}`)
  const npmIndex = indexNpmScripts(options.root)
  const triage = readTriage(options.triage)

  if (options.applyTriage) {
    // Re-apply the manual triage map to an existing sweep file without running anything.
    if (!options.out || !fs.existsSync(options.out)) throw new Error('--apply-triage needs an existing --out file')
    const document = JSON.parse(fs.readFileSync(options.out, 'utf8')) as { results: TestResult[]; totals: Record<string, number>; options?: Record<string, unknown> }
    for (const result of document.results) applyTriage(result, triage)
    document.totals = totalsOf(document.results)
    document.options = { ...(document.options ?? {}), triage: options.triage }
    atomicWrite(options.out, document)
    console.error(`triage applied: ${JSON.stringify(document.totals)}`)
    return
  }

  const entries = fs.readdirSync(scriptsDir).sort()
  const tsTests = entries.filter((name) => /^test-.*\.ts$/.test(name))
  const pyTests = entries.filter((name) => /^test[-_].*\.py$/.test(name))
  const matches = (name: string) => !options.filter || options.filter.test(name) || options.filter.test(name.replace(/\.(ts|py)$/, ''))

  const results: TestResult[] = []
  const previous = new Map<string, TestResult>()
  if (options.resume && options.out && fs.existsSync(options.out)) {
    const prior = JSON.parse(fs.readFileSync(options.out, 'utf8')) as { results?: TestResult[] }
    for (const result of prior.results ?? []) previous.set(result.script, result)
  }

  const baseResult = (name: string, kind: 'ts' | 'py'): TestResult => {
    const references = npmIndex.get(name) ?? []
    const plan = planEnvironment(references)
    return {
      name: name.replace(/\.(ts|py)$/, ''),
      script: name,
      kind,
      npmScripts: [...new Set(references.map((reference) => reference.npmScript))],
      status: 'NOT_TESTED',
      statusAuto: 'NOT_TESTED',
      triaged: false,
      reason: '',
      executed: false,
      exitCode: null,
      signal: null,
      durationMs: 0,
      nodeEnv: plan.nodeEnv,
      carriedEnv: plan.carried,
      droppedEnv: plan.dropped,
      droppedFlags: plan.droppedFlags,
      args: plan.args,
      skipSignal: false,
      networkAttempts: [],
      outputBytes: 0,
      outputTruncated: false,
      tail: [],
      logPath: null,
      startedAt: new Date().toISOString(),
    }
  }

  const queue: Array<{ name: string; preDenied: string | null }> = []
  for (const name of tsTests.filter(matches)) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8')
    const denied = SAFETY_DENY.find((rule) => rule.test(source))
    queue.push({ name, preDenied: denied ? denied.reason : null })
  }

  for (const name of pyTests.filter(matches)) {
    const result = baseResult(name, 'py')
    result.reason = 'python test: interpreter/venv and external dependencies are out of scope; not executed'
    results.push(result)
  }

  if (options.list) {
    const rows = queue.map(({ name, preDenied }) => {
      const result = baseResult(name, 'ts')
      return { ...result, plannedAction: preDenied ? 'SKIP(ENV_BLOCKED)' : 'RUN', reason: preDenied ?? '' }
    })
    for (const row of rows) {
      const env = Object.entries(row.carriedEnv).map(([k, v]) => `${k}=${v}`).join(' ')
      console.log([row.plannedAction.padEnd(17), row.script.padEnd(58), `NODE_ENV=${row.nodeEnv}`, env,
        row.npmScripts.length ? `npm:${row.npmScripts.join(',')}` : 'npm:-', row.reason].filter(Boolean).join('  '))
    }
    for (const result of results) console.log(`${'NOT_TESTED'.padEnd(17)}  ${result.script}  (${result.reason})`)
    console.log(`\n${queue.length} ts tests, ${results.length} python tests listed`)
    if (options.out) {
      atomicWrite(options.out, { schema: 'stockboard.test-sweep.plan.v1', root: options.root, tests: rows, python: results })
    }
    return
  }

  const logDir = options.keepLogs ?? (options.out ? `${options.out.replace(/\.json$/, '')}-logs` : null)
  if (logDir) fs.mkdirSync(logDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const flush = () => {
    if (!options.out) return
    atomicWrite(options.out, {
      schema: 'stockboard.test-sweep.v1',
      startedAt,
      updatedAt: new Date().toISOString(),
      root: options.root,
      label: options.label,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      options: {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        filter: options.filter ? options.filter.source : null,
        triage: options.triage,
      },
      isolation: {
        helper: 'scripts/lib/synthetic-isolation.ts (this checkout)',
        childEnv: 'allowlist + runtime-bound paths, HOME re-bound, network preload, NODE_ENV never production',
        envFilesRead: false,
      },
      totals: totalsOf(results),
      results: [...results].sort((left, right) => left.script.localeCompare(right.script)),
    })
  }

  let cursor = 0
  const total = queue.length
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total) return
      const { name, preDenied } = queue[index]
      const prior = previous.get(name)
      if (prior && prior.statusAuto !== 'TIMEOUT') { applyTriage(prior, triage); results.push(prior); continue }

      const result = baseResult(name, 'ts')
      const references = npmIndex.get(name) ?? []
      const plan = planEnvironment(references)
      if (preDenied) {
        result.status = 'ENV_BLOCKED'
        result.statusAuto = 'ENV_BLOCKED'
        result.reason = preDenied
      } else {
        const runtime = createSyntheticRuntime(result.name)
        activeRuntimes.add(runtime)
        try {
          const outcome = await runOne(options, tsxBinary, path.join('scripts', name), plan, runtime)
          const verdict = classify(outcome)
          result.executed = true
          result.status = verdict.status
          result.statusAuto = verdict.status
          result.reason = verdict.reason
          result.exitCode = outcome.exitCode
          result.signal = outcome.signal
          result.durationMs = outcome.durationMs
          result.networkAttempts = outcome.networkAttempts
          result.outputBytes = outcome.bytes
          result.outputTruncated = outcome.truncated
          result.tail = lastLines(outcome.output, 15)
          result.skipSignal = SKIP_SIGNAL.test(stripAnsi(outcome.output))
          if (logDir) {
            result.logPath = path.join(logDir, `${result.name}.log`)
            fs.writeFileSync(result.logPath, stripAnsi(outcome.output))
          }
        } catch (error) {
          result.executed = false
          result.status = 'FAIL'
          result.statusAuto = 'FAIL'
          result.reason = `sweep harness error: ${error instanceof Error ? error.message : String(error)}`
        } finally {
          try { runtime.cleanup() } catch { /* best effort */ }
          activeRuntimes.delete(runtime)
        }
      }
      applyTriage(result, triage)
      results.push(result)
      flush()
      const marker = result.status === 'PASS' ? 'ok  ' : result.status.padEnd(4)
      console.error(`[${results.length}/${total + pyTests.filter(matches).length}] ${marker} ${result.script} ${result.durationMs}ms ${result.status === 'PASS' ? '' : result.reason}`)
    }
  }

  const shutdown = () => {
    for (const child of activeChildren) killGroup(child, 'SIGKILL')
    for (const runtime of activeRuntimes) { try { runtime.cleanup() } catch { /* best effort */ } }
  }
  process.on('SIGINT', () => { shutdown(); process.exit(130) })
  process.on('SIGTERM', () => { shutdown(); process.exit(143) })
  process.on('exit', shutdown)

  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(total, 1)) }, () => worker()))
  flush()
  const totals = totalsOf(results)
  console.error(`sweep complete: ${JSON.stringify(totals)}`)
  if (!options.out) console.log(JSON.stringify({ totals, results }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
