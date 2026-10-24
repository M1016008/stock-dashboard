import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertIsolatedRuntimeEnvironment,
  createIsolatedRuntimeEnvironment,
  type IsolatedRuntimeKind,
} from '@/lib/runtime/isolation'

function usage(): never {
  throw new Error('Usage: tsx scripts/run-isolated-runtime.ts <development|test|build|preview> [--root <absolute-dir>] -- <command> [args...]')
}

const separator = process.argv.indexOf('--', 2)
if (separator < 0) usage()
const kind = process.argv[2] as IsolatedRuntimeKind
if (kind !== 'development' && kind !== 'test' && kind !== 'build' && kind !== 'preview') usage()
const [command, ...args] = process.argv.slice(separator + 1)
if (!command) usage()
if ([command, ...args].some((argument) => argument.includes('.env.local'))) {
  throw new Error('Isolated runtime commands must never load .env.local')
}

const launcherArgs = process.argv.slice(3, separator)
let requestedRoot: string | null = null
if (launcherArgs.length > 0) {
  if ((kind !== 'development' && kind !== 'preview' && kind !== 'build') || launcherArgs.length !== 2 || launcherArgs[0] !== '--root') usage()
  requestedRoot = path.resolve(launcherArgs[1])
}

const temporary = kind === 'test' || (kind === 'build' && requestedRoot === null)
const root = temporary
  ? fs.mkdtempSync(path.join(os.tmpdir(), `stockboard-${kind}-`))
  : requestedRoot ?? path.join(process.cwd(), kind === 'preview' ? '.stockboard-preview' : '.stockboard-development')
for (const directory of ['data', 'fixtures', 'artifacts', 'storage-incidents', 'home', 'tmp', 'cache']) {
  fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 })
}

const environment = createIsolatedRuntimeEnvironment(kind, root)
assertIsolatedRuntimeEnvironment(environment)
if (kind === 'development' || kind === 'preview') console.log(`[runtime-isolation] ${kind} data root: ${root}`)

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: environment,
  shell: false,
  stdio: 'inherit',
  detached: true,
})

const ownerMarkerPath = path.join(root, '.runtime-owner.json')
fs.writeFileSync(ownerMarkerPath, JSON.stringify({
  version: 1,
  kind,
  root: fs.realpathSync(root),
  cwd: fs.realpathSync(process.cwd()),
  launcherPid: process.pid,
  childPid: child.pid,
  startedAt: new Date().toISOString(),
}), { mode: 0o600 })

function removeOwnedMarker(): void {
  try {
    const marker = JSON.parse(fs.readFileSync(ownerMarkerPath, 'utf8')) as { launcherPid?: number }
    if (marker.launcherPid === process.pid) fs.rmSync(ownerMarkerPath, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

let forcedExit: NodeJS.Timeout | null = null
let receivedSignal: NodeJS.Signals | null = null
const terminateProcessGroup = (signal: NodeJS.Signals): void => {
  try { process.kill(-child.pid!, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    receivedSignal = signal
    terminateProcessGroup(signal)
    forcedExit = setTimeout(() => terminateProcessGroup('SIGKILL'), 5_000)
    forcedExit.unref()
  })
}

child.once('error', (error) => {
  if (forcedExit) clearTimeout(forcedExit)
  removeOwnedMarker()
  if (temporary) fs.rmSync(root, { recursive: true, force: true })
  throw error
})
child.once('exit', (code, signal) => {
  if (forcedExit) clearTimeout(forcedExit)
  removeOwnedMarker()
  if (temporary) fs.rmSync(root, { recursive: true, force: true })
  const effectiveSignal = receivedSignal ?? signal
  process.exitCode = effectiveSignal === 'SIGINT' ? 130 : effectiveSignal === 'SIGTERM' ? 143 : code ?? 1
})
