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
  throw new Error('Usage: tsx scripts/run-isolated-runtime.ts <development|test|build> -- <command> [args...]')
}

const separator = process.argv.indexOf('--', 2)
if (separator < 0) usage()
const kind = process.argv[2] as IsolatedRuntimeKind
if (kind !== 'development' && kind !== 'test' && kind !== 'build') usage()
const [command, ...args] = process.argv.slice(separator + 1)
if (!command) usage()
if ([command, ...args].some((argument) => argument.includes('.env.local'))) {
  throw new Error('Isolated runtime commands must never load .env.local')
}

const temporary = kind !== 'development'
const root = temporary
  ? fs.mkdtempSync(path.join(os.tmpdir(), `stockboard-${kind}-`))
  : path.join(process.cwd(), '.stockboard-development')
for (const directory of ['data', 'fixtures', 'artifacts', 'storage-incidents']) {
  fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 })
}

const environment = createIsolatedRuntimeEnvironment(kind, root)
assertIsolatedRuntimeEnvironment(environment)
if (kind === 'development') console.log(`[runtime-isolation] development data root: ${root}`)

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: environment,
  shell: false,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}

child.once('error', (error) => {
  if (temporary) fs.rmSync(root, { recursive: true, force: true })
  throw error
})
child.once('exit', (code, signal) => {
  if (temporary) fs.rmSync(root, { recursive: true, force: true })
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
