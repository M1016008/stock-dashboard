import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  ApprovedWriterIdentity,
  WriterHoldDriver,
  WriterRuntimeIdentity,
} from '@/lib/storage/weekly-writer-hold'

export type LaunchdRuntimeIdentity = ApprovedWriterIdentity & {
  plistPath: string
}

export type CommandResult = Readonly<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: Error
}>

export type CommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => CommandResult

export type DatabaseHandle = Readonly<{
  pid: number
  command: string
  files: readonly string[]
}>

export const LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS = 40_000
export const LAUNCHD_RESTORE_RESERVE_BASE_MS = 30_000

const systemCommandRunner: CommandRunner = (file, args, timeoutMs) => {
  const result = spawnSync(file, [...args], { encoding: 'utf8', timeout: timeoutMs })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

function commandFailure(name: string, result: CommandResult): never {
  const detail = result.error?.message || result.stderr.trim() || `status=${String(result.status)}`
  throw new Error(`${name}_FAILED:${detail}`)
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readPlistProgram(identity: LaunchdRuntimeIdentity, run: CommandRunner): string {
  const program = run('/usr/bin/plutil', ['-extract', 'Program', 'raw', '-o', '-', identity.plistPath], 5_000)
  if (program.status === 0) return program.stdout.trim()
  const argument = run('/usr/bin/plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', identity.plistPath], 5_000)
  if (argument.status !== 0) commandFailure('PLIST_PROGRAM', argument)
  return argument.stdout.trim()
}

function assertDefinition(identity: LaunchdRuntimeIdentity, run: CommandRunner): void {
  const stat = fs.statSync(identity.plistPath)
  if (!stat.isFile()) throw new Error(`WRITER_PLIST_NOT_REGULAR:${identity.label}`)
  if (sha256File(identity.plistPath) !== identity.definitionSha256) {
    throw new Error(`WRITER_DEFINITION_MISMATCH:${identity.label}`)
  }
  if (readPlistProgram(identity, run) !== identity.program) {
    throw new Error(`WRITER_PROGRAM_MISMATCH:${identity.label}`)
  }
}

function launchdPrint(label: string, run: CommandRunner, uid: number): CommandResult {
  return run('/bin/launchctl', ['print', `gui/${uid}/${label}`], 5_000)
}

// Identity of the job launchd actually loaded, from the top-level (one tab
// deep) `path`, `program`, and `working directory` keys of `launchctl print`.
// Nested blocks are ignored; a missing or repeated path/program is ambiguous.
export type LoadedLaunchdJob = Readonly<{ path: string; program: string; workingDirectory: string | null }>

export function parseLoadedLaunchdJob(label: string, stdout: string): LoadedLaunchdJob {
  const values = (key: string) => [...stdout.matchAll(new RegExp(`^\\t${key} = (.*)$`, 'gm'))]
    .map((match) => match[1]!.trim())
  const single = (key: string, required: boolean): string | null => {
    const found = values(key)
    if (found.length > 1 || (required && found.length === 0) || found.some((value) => !value)) {
      throw new Error(`LAUNCHD_JOB_IDENTITY_AMBIGUOUS:${label}:${key}`)
    }
    return found[0] ?? null
  }
  return {
    path: single('path', true)!,
    program: single('program', true)!,
    workingDirectory: single('working directory', false),
  }
}

function assertLoadedJob(identity: LaunchdRuntimeIdentity, job: LoadedLaunchdJob): void {
  if (job.path !== identity.plistPath) throw new Error(`WRITER_LOADED_PATH_MISMATCH:${identity.label}`)
  if (job.program !== identity.program) throw new Error(`WRITER_LOADED_PROGRAM_MISMATCH:${identity.label}`)
}

function processGroupId(pid: number, run: CommandRunner): number | null {
  const result = run('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], 5_000)
  if (result.status !== 0) {
    if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()
      && !result.error && !result.signal) return null
    commandFailure('PROCESS_GROUP_PROBE', result)
  }
  const value = Number(result.stdout.trim())
  if (!Number.isInteger(value) || value <= 0) throw new Error(`PROCESS_GROUP_PROBE_AMBIGUOUS:${pid}`)
  return value
}

function processGroupAlive(processGroup: number, run: CommandRunner): boolean {
  const result = run('/bin/ps', ['-axo', 'pgid='], 5_000)
  if (result.status !== 0) commandFailure('PROCESS_GROUP_LIST', result)
  return result.stdout.split(/\s+/).some((value) => Number(value) === processGroup)
}

function isMissingLaunchdJob(result: CommandResult): boolean {
  return result.status !== 0
    && /could not find service|service not found|no such process/i.test(`${result.stdout}\n${result.stderr}`)
}

function isDisabled(label: string, run: CommandRunner, uid: number): boolean {
  const result = run('/bin/launchctl', ['print-disabled', `gui/${uid}`], 5_000)
  if (result.status !== 0) commandFailure('LAUNCHCTL_PRINT_DISABLED', result)
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = result.stdout.match(new RegExp(`"${escaped}"\\s*=>\\s*([A-Za-z]+)`))
  if (!match) return false
  if (match[1] === 'disabled' || match[1] === 'true') return true
  if (match[1] === 'enabled' || match[1] === 'false') return false
  throw new Error(`LAUNCHCTL_DISABLED_STATE_AMBIGUOUS:${label}:${match[1]}`)
}

export function launchdJobPid(label: string, options: {
  run?: CommandRunner
  uid?: number
} = {}): number | null {
  const run = options.run ?? systemCommandRunner
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  const result = launchdPrint(label, run, uid as number)
  if (isMissingLaunchdJob(result)) return null
  if (result.status !== 0) commandFailure('LAUNCHCTL_PRINT', result)
  const match = result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)
  return match ? Number(match[1]) : null
}

// Read-only: every loaded label in the gui/<uid> domain with the prefix.
export function listLoadedLaunchdLabels(prefix: string, options: {
  run?: CommandRunner
  uid?: number
} = {}): string[] {
  const run = options.run ?? systemCommandRunner
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  const result = run('/bin/launchctl', ['print', `gui/${uid}`], 5_000)
  if (result.status !== 0) commandFailure('LAUNCHCTL_PRINT_DOMAIN', result)
  const block = result.stdout.match(/^\s*services = \{\n([\s\S]*?)^\s*\}/m)
  if (!block) throw new Error('LAUNCHCTL_PRINT_DOMAIN_AMBIGUOUS:no services block')
  return block[1]!.split('\n').map((line) => line.trim().split(/\s+/).at(-1) ?? '')
    .filter((label) => label.startsWith(prefix))
}

// Read-only: the runtime WorkingDirectory, after the plist definition is
// verified. A loaded job must have been loaded from the approved plist and
// program, and its actual working directory must equal the plist's; an
// unloaded job will start from the verified plist.
export function readLaunchdWorkingDirectory(identity: LaunchdRuntimeIdentity, options: {
  run?: CommandRunner
  uid?: number
} = {}): string | null {
  const run = options.run ?? systemCommandRunner
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  assertDefinition(identity, run)
  const result = run('/usr/bin/plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', identity.plistPath], 5_000)
  const configured = result.status === 0 ? result.stdout.trim() : null
  const print = launchdPrint(identity.label, run, uid as number)
  if (isMissingLaunchdJob(print)) return configured
  if (print.status !== 0) commandFailure('LAUNCHCTL_PRINT', print)
  const job = parseLoadedLaunchdJob(identity.label, print.stdout)
  assertLoadedJob(identity, job)
  if (job.workingDirectory !== configured) throw new Error(`WRITER_LOADED_WORKING_DIRECTORY_MISMATCH:${identity.label}`)
  return job.workingDirectory
}

// Read-only: an approved-absent service has nothing at its exact plist path
// (not even a dangling symlink) and no loaded job under its label.
export function assertLaunchdServiceAbsent(identity: { label: string; plistPath: string }, options: {
  run?: CommandRunner
  uid?: number
} = {}): void {
  const run = options.run ?? systemCommandRunner
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  if (typeof identity.plistPath !== 'string' || !path.isAbsolute(identity.plistPath)
      || path.basename(identity.plistPath) !== `${identity.label}.plist`) {
    throw new Error(`ABSENT_SERVICE_PLIST_PATH_INVALID:${identity.label}`)
  }
  if (fs.lstatSync(identity.plistPath, { throwIfNoEntry: false })) {
    throw new Error(`ABSENT_SERVICE_DEFINITION_PRESENT:${identity.label}`)
  }
  const print = launchdPrint(identity.label, run, uid as number)
  if (isMissingLaunchdJob(print)) return
  if (print.status === 0) throw new Error(`ABSENT_SERVICE_LOADED:${identity.label}`)
  commandFailure('LAUNCHCTL_PRINT', print)
}

export function createLaunchdWriterHoldDriver(
  approved: readonly LaunchdRuntimeIdentity[],
  options: {
    run?: CommandRunner
    uid?: number
    now?: () => number
    sleep?: (milliseconds: number) => Promise<void>
    // Also require a loaded job's actual path/program to be the approved ones.
    verifyLoadedJob?: boolean
  } = {},
): WriterHoldDriver {
  const run = options.run ?? systemCommandRunner
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  const identities = new Map(approved.map((identity) => [identity.label, identity]))

  const observe = async (label: string): Promise<WriterRuntimeIdentity> => {
    const identity = identities.get(label)
    if (!identity) throw new Error(`UNAPPROVED_WRITER_LABEL:${label}`)
    assertDefinition(identity, run)
    const result = launchdPrint(label, run, uid as number)
    const loaded = result.status === 0
    if (!loaded && !isMissingLaunchdJob(result)) commandFailure('LAUNCHCTL_PRINT', result)
    if (loaded && options.verifyLoadedJob) assertLoadedJob(identity, parseLoadedLaunchdJob(label, result.stdout))
    const pidMatch = loaded ? result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m) : null
    const pid = pidMatch ? Number(pidMatch[1]) : null
    return {
      label,
      definitionSha256: identity.definitionSha256,
      program: identity.program,
      loaded,
      disabled: isDisabled(label, run, uid as number),
      instances: loaded ? 1 : 0,
      pid,
      processGroupId: pid === null ? null : processGroupId(pid, run),
    }
  }

  return {
    observe,
    async bootout(label) {
      if (!identities.has(label)) throw new Error(`UNAPPROVED_WRITER_LABEL:${label}`)
      const result = run('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], 10_000)
      if (result.status !== 0) commandFailure('LAUNCHCTL_BOOTOUT', result)
    },
    async bootstrap(label) {
      const identity = identities.get(label)
      if (!identity) throw new Error(`UNAPPROVED_WRITER_LABEL:${label}`)
      assertDefinition(identity, run)
      const result = run('/bin/launchctl', ['bootstrap', `gui/${uid}`, identity.plistPath], 10_000)
      if (result.status !== 0) commandFailure('LAUNCHCTL_BOOTSTRAP', result)
    },
    async processGroupAlive(value) {
      return processGroupAlive(value, run)
    },
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: options.now ?? Date.now,
  }
}

function parseLsof(output: string): DatabaseHandle[] {
  const handles = new Map<number, { command: string; files: string[] }>()
  let currentPid: number | null = null
  for (const line of output.split('\n')) {
    if (!line) continue
    if (line[0] === 'p') {
      currentPid = Number(line.slice(1))
      if (!Number.isInteger(currentPid) || currentPid <= 0) throw new Error('LSOF_PROBE_AMBIGUOUS:invalid pid')
      if (!handles.has(currentPid)) handles.set(currentPid, { command: '', files: [] })
    } else if (line[0] === 'c') {
      if (currentPid === null) throw new Error('LSOF_PROBE_AMBIGUOUS:command without pid')
      handles.get(currentPid)!.command = line.slice(1)
    } else if (line[0] === 'n') {
      if (currentPid === null) throw new Error('LSOF_PROBE_AMBIGUOUS:file without pid')
      handles.get(currentPid)!.files.push(line.slice(1))
    }
  }
  return [...handles.entries()].map(([pid, value]) => ({ pid, ...value }))
}

export function assertNoUnauthorizedDatabaseHandles(args: {
  databasePath: string
  approvedReaders: readonly LaunchdRuntimeIdentity[]
  workerPid?: number
  additionallyApprovedPids?: readonly number[]
  timeoutMs: number
  run?: CommandRunner
  uid?: number
  exists?: (file: string) => boolean
}): DatabaseHandle[] {
  const run = args.run ?? systemCommandRunner
  const exists = args.exists ?? fs.existsSync
  const uid = args.uid ?? process.getuid?.()
  if (!Number.isInteger(uid)) throw new Error('LAUNCHD_UID_UNAVAILABLE')
  const allowedPids = new Set<number>()
  for (const identity of args.approvedReaders) {
    assertDefinition(identity, run)
    const pid = launchdJobPid(identity.label, { run, uid: uid as number })
    if (pid !== null) allowedPids.add(pid)
  }
  if (args.workerPid !== undefined) allowedPids.add(args.workerPid)
  for (const pid of args.additionallyApprovedPids ?? []) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`APPROVED_DATABASE_HANDLE_PID_INVALID:${pid}`)
    allowedPids.add(pid)
  }
  if (!exists(args.databasePath)) throw new Error('DATABASE_HANDLE_SOURCE_MISSING')
  const files = [args.databasePath, `${args.databasePath}-wal`, `${args.databasePath}-shm`]
    .filter((file) => exists(file))
  const result = run('/usr/sbin/lsof', ['-nP', '-Fpcn', ...files], args.timeoutMs)
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim() && !result.error) return []
  if (result.status !== 0 || result.error || result.signal || result.stderr.trim()) {
    commandFailure('LSOF_PROBE_AMBIGUOUS', result)
  }
  const handles = parseLsof(result.stdout)
  const unauthorized = handles.filter((handle) => !allowedPids.has(handle.pid))
  if (unauthorized.length > 0) {
    throw new Error(`UNAUTHORIZED_DATABASE_HANDLE:${unauthorized.map((item) => `${item.pid}:${item.command}`).join(',')}`)
  }
  return handles
}
