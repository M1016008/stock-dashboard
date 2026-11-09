// Production entry point for the approved weekly SQLite backup runner.
//
// This file only gathers observations and wires existing pieces together:
// `runWeeklyBackupGeneration` (lib/storage/weekly-backup-runner.ts) owns the
// acquisition, Writer Hold, verification and publication; the launchd driver
// (lib/storage/launchd-writer-hold-driver.ts) owns bootout/bootstrap.
//
//   observe (default): read-only. Prints the observation JSON accepted by
//     `npm run backup:weekly:preflight` plus the writer-definition digest.
//   execute: requires --confirm=WRITE_APPROVED_WEEKLY_BACKUP_GENERATION,
//     the approved plan SHA-256 and the approved writer-definition digest.
//
// Usage:
//   node --import tsx scripts/run-weekly-backup-generation.ts --plan=/abs/plan.json \
//     --expected-plan-sha256=<sha> [--mode=execute --expected-writers-sha256=<sha> \
//     --confirm=WRITE_APPROVED_WEEKLY_BACKUP_GENERATION]

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertWeeklyBackupPlanSha256,
  validateWeeklyBackupPlan,
  type Market,
  type WeeklyBackupDynamicObservation,
  type WeeklyBackupObservation,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'
import { runWeeklyBackupGeneration } from '@/lib/storage/weekly-backup-runner'
import {
  createLaunchdWriterHoldDriver,
  launchdJobPid,
  type LaunchdRuntimeIdentity,
} from '@/lib/storage/launchd-writer-hold-driver'

const CONFIRMATION = 'WRITE_APPROVED_WEEKLY_BACKUP_GENERATION'
// The historical trigger worker keeps a long-lived ownership lease while it is
// alive. It is an approved, held writer, so its lease is not a blocking lock.
const HELD_WORKER_LOCK_TYPES: Record<string, string> = {
  trigger_historical_worker: 'com.stockboard.trigger-historical-scan',
}
// Daily update jobs must not have a scheduled start inside the Writer Hold.
const DAILY_UPDATE_LABELS = ['com.stockboard.update-latest', 'com.stockboard.us-update-latest']
const MARKETS: readonly Market[] = ['JP', 'US']

const argv = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split('=')
  return [key, rest.join('=')]
}))
const mode = argv.get('--mode') ?? 'observe'
const planPath = argv.get('--plan') ?? ''
const expectedPlanSha256 = argv.get('--expected-plan-sha256') ?? ''
const runbookPath = path.resolve(argv.get('--runbook') ?? 'docs/production-weekly-backup-runbook.md')
if (!path.isAbsolute(planPath) || !expectedPlanSha256) {
  throw new Error('usage: --plan=/absolute/plan.json --expected-plan-sha256=<sha> [--mode=observe|execute]')
}
if (mode !== 'observe' && mode !== 'execute') throw new Error(`UNKNOWN_MODE:${mode}`)

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as WeeklyBackupPlan
validateWeeklyBackupPlan(plan)
assertWeeklyBackupPlanSha256(plan, expectedPlanSha256)

function run(file: string, args: string[], timeoutMs = 60_000): string {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)}_FAILED:${result.error?.message ?? result.stderr.trim() ?? result.status}`)
  }
  return result.stdout
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function plistJson(file: string): Record<string, unknown> {
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])) as Record<string, unknown>
}

// diskutil -plist piped through plutil without a shell.
function diskutilPlist(target: string): Record<string, unknown> {
  const xml = run('/usr/sbin/diskutil', ['info', '-plist', target], 30_000)
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: xml, encoding: 'utf8', timeout: 30_000,
  })
  if (result.status !== 0) throw new Error(`PLUTIL_FAILED:${result.stderr.trim()}`)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function physicalWholeDisk(mount: string): string {
  const info = diskutilPlist(mount)
  const stores = info.APFSPhysicalStores as Array<{ APFSPhysicalStore: string }> | undefined
  const store = stores?.[0]?.APFSPhysicalStore ?? String(info.ParentWholeDisk ?? '')
  const whole = store.match(/^(disk\d+)/)?.[1]
  if (!whole) throw new Error(`PHYSICAL_DISK_UNKNOWN:${mount}`)
  return whole
}

// NVMe serials come from system_profiler; USB serials from the IOUSBHostDevice tree.
function physicalSerial(wholeDisk: string): string {
  const profile = JSON.parse(run('/usr/sbin/system_profiler', ['-json', 'SPNVMeDataType'], 120_000)) as unknown
  const stack: unknown[] = [profile]
  while (stack.length) {
    const node = stack.pop()
    if (Array.isArray(node)) stack.push(...node)
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (record.bsd_name === wholeDisk && typeof record.device_serial === 'string') return record.device_serial
      stack.push(...Object.values(record))
    }
  }
  let serial: string | null = null
  for (const line of run('/usr/sbin/ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0']).split('\n')) {
    if (/^\+-o /.test(line)) serial = null
    const serialMatch = line.match(/"USB Serial Number" = "([^"]+)"/)
    if (serialMatch && serial === null) serial = serialMatch[1]
    if (serial && line.includes(`"BSD Name" = "${wholeDisk}"`)) return serial
  }
  throw new Error(`PHYSICAL_SERIAL_UNKNOWN:${wholeDisk}`)
}

function volumeIdentity(mount: string): { mount: string; uuid: string; serial: string; freeBytes: number } {
  const info = diskutilPlist(mount)
  if (info.MountPoint !== mount) throw new Error(`MOUNT_IDENTITY_MISMATCH:${mount}`)
  const stats = fs.statfsSync(mount, { bigint: true })
  return {
    mount,
    uuid: String(info.VolumeUUID ?? ''),
    serial: physicalSerial(physicalWholeDisk(mount)),
    freeBytes: Number(stats.bavail * stats.bsize),
  }
}

function launchAgentPlist(label: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

function writerIdentities(): LaunchdRuntimeIdentity[] {
  return plan.writerLabels.map((label) => {
    const plistPath = launchAgentPlist(label)
    if (!fs.existsSync(plistPath)) throw new Error(`WRITER_PLIST_MISSING:${label}`)
    const definition = plistJson(plistPath)
    const program = typeof definition.Program === 'string'
      ? definition.Program
      : String((definition.ProgramArguments as string[] | undefined)?.[0] ?? '')
    return { label, plistPath, program, definitionSha256: sha256File(plistPath) }
  })
}

function writersDigest(identities: readonly LaunchdRuntimeIdentity[]): string {
  const canonical = identities.map(({ label, definitionSha256 }) => `${label}:${definitionSha256}`).sort().join('\n')
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Owner formats written by the code; the PID is always the second colon field:
//   lib/server/update-lock.ts                       <jobType>:<pid>:<epochMs>:<base36>
//   lib/server/trigger-historical-worker-ownership  worker:<pid>:<birthHash>:<uuid>
// Anything else returns null and is treated as a live owner by the caller.
function ownerPid(owner: string): number | null {
  const match = owner.match(/^[A-Za-z0-9_.-]+:(\d+):[A-Za-z0-9]+:[A-Za-z0-9-]+$/)
  return match ? Number(match[1]) : null
}

function activeWriterLockOwners(): string[] {
  const owners: string[] = []
  for (const market of MARKETS) {
    const database = plan.sourceDatabasePaths[market]
    const output = run(plan.sqliteBinaryPath, [
      '-readonly', '-json', '-cmd', '.timeout 30000', database,
      `SELECT job_type, owner FROM update_locks WHERE status = 'running' AND lease_expires_at > unixepoch()`,
    ], 120_000).trim()
    const rows = output ? JSON.parse(output) as Array<{ job_type: string; owner: string | null }> : []
    for (const row of rows) {
      const pid = row.owner ? ownerPid(row.owner) : null
      if (pid !== null && !processAlive(pid)) continue
      const heldLabel = HELD_WORKER_LOCK_TYPES[row.job_type]
      if (heldLabel && pid !== null && launchdJobPid(heldLabel) === pid) continue
      owners.push(`${market}:${row.job_type}:${row.owner ?? 'unknown'}`)
    }
  }
  return owners
}

function scheduledMinutes(label: string): Array<{ weekday: number | null; minuteOfDay: number }> {
  const definition = plistJson(launchAgentPlist(label))
  const raw = definition.StartCalendarInterval
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, number>>
  return entries.map((entry) => ({
    weekday: typeof entry.Weekday === 'number' ? entry.Weekday % 7 : null,
    minuteOfDay: (entry.Hour ?? 0) * 60 + (entry.Minute ?? 0),
  }))
}

function dailyUpdateWindowConflict(nowMs: number): boolean {
  for (const label of DAILY_UPDATE_LABELS) {
    if (launchdJobPid(label) !== null) return true
    const slots = scheduledMinutes(label)
    for (let t = nowMs; t <= nowMs + plan.maximumWriterHoldMs; t += 60_000) {
      const date = new Date(t)
      const minute = date.getHours() * 60 + date.getMinutes()
      if (slots.some((slot) => slot.minuteOfDay === minute && (slot.weekday === null || slot.weekday === date.getDay()))) {
        return true
      }
    }
  }
  return false
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(20_000) })
    const body = await response.json() as { status?: string }
    return response.ok && body.status === 'ok'
  } catch { return false }
}

function toolsArchiveSha3(): string {
  const directory = path.dirname(plan.sqliteBinaryPath)
  const archives = fs.readdirSync(directory).filter((name) => name.endsWith('.zip'))
  if (archives.length !== 1) throw new Error('SQLITE_TOOLS_ARCHIVE_AMBIGUOUS')
  return crypto.createHash('sha3-256').update(fs.readFileSync(path.join(directory, archives[0]))).digest('hex')
}

function loadedStockboardLabels(): Map<string, number | null> {
  const labels = new Map<string, number | null>()
  for (const line of run('/bin/launchctl', ['list']).split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/)
    if (label?.startsWith('com.stockboard.')) labels.set(label, pid === '-' ? null : Number(pid))
  }
  return labels
}

async function observeDynamic(): Promise<WeeklyBackupDynamicObservation> {
  const now = Date.now()
  const source = volumeIdentity(plan.sourceMount)
  const destination = volumeIdentity(plan.destinationMount)
  const loaded = loadedStockboardLabels()
  const known = new Set([...plan.writerLabels, ...plan.readerLabelsKeptOnline])
  return {
    now: new Date(now).toISOString(),
    sourceMount: source.mount,
    destinationMount: destination.mount,
    sourcePhysicalSerial: source.serial,
    destinationPhysicalSerial: destination.serial,
    sourceVolumeUuid: source.uuid,
    destinationVolumeUuid: destination.uuid,
    destinationFreeBytes: destination.freeBytes,
    combinedWalBytes: MARKETS.reduce((total, market) => {
      const wal = `${plan.sourceDatabasePaths[market]}-wal`
      return total + (fs.existsSync(wal) ? fs.statSync(wal).size : 0)
    }, 0),
    activeWriterLabels: plan.writerLabels.filter((label) => (loaded.get(label) ?? null) !== null),
    unknownWriterLabels: [...loaded.entries()]
      .filter(([label, pid]) => pid !== null && !known.has(label))
      .map(([label]) => label),
    writerLockOwners: activeWriterLockOwners(),
    updateWindowConflict: dailyUpdateWindowConflict(now),
    webHealthy: await healthy(3000),
    analogHealthy: await healthy(3105),
    priorManifestSha256: sha256File(plan.priorManifestPath),
    sqliteVersion: run(plan.sqliteBinaryPath, ['--version']).trim().split(/\s+/)[0],
    sqliteBinarySha256: sha256File(plan.sqliteBinaryPath),
    sqliteRsyncBinarySha256: sha256File(plan.sqliteRsyncBinaryPath),
    sqliteToolsArchiveSha3: toolsArchiveSha3(),
  }
}

async function observe(): Promise<WeeklyBackupObservation> {
  const generationRoot = path.join(plan.destinationRoot, plan.runId)
  return {
    ...(await observeDynamic()),
    existingCandidatePath: fs.existsSync(generationRoot),
    existingCompleteManifest: fs.existsSync(path.join(generationRoot, 'COMPLETE.manifest.json')),
  }
}

// An operator abort (Ctrl-C, or `kill -INT <pid>`) must not kill this process
// while writers are held: the runner polls assertRuntimeIdentity every second
// during sqlite3_rsync, so throwing there stops the copy and lets the writer
// hold restore every writer before the process exits.
let operatorAbortSignal: NodeJS.Signals | null = null

function installOperatorAbortHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (operatorAbortSignal === null) operatorAbortSignal = signal
      console.error(`[weekly-backup] ${signal} received: stopping and restoring writers before exit`)
    })
  }
}

function assertRuntimeIdentity(): void {
  if (operatorAbortSignal !== null) throw new Error(`OPERATOR_ABORT_REQUESTED:${operatorAbortSignal}`)
  for (const [mount, uuid, serial] of [
    [plan.sourceMount, plan.sourceVolumeUuid, plan.sourcePhysicalSerial],
    [plan.destinationMount, plan.destinationVolumeUuid, plan.destinationPhysicalSerial],
  ] as const) {
    const info = diskutilPlist(mount)
    if (info.MountPoint !== mount || String(info.VolumeUUID).toUpperCase() !== uuid.toUpperCase()) {
      throw new Error(`RUNTIME_VOLUME_IDENTITY_CHANGED:${mount}`)
    }
    if (physicalSerial(physicalWholeDisk(mount)) !== serial) throw new Error(`RUNTIME_PHYSICAL_SERIAL_CHANGED:${mount}`)
  }
}

async function main(): Promise<void> {
  const writers = writerIdentities()
  const digest = writersDigest(writers)
  const observation = await observe()
  if (mode === 'observe') {
    console.log(JSON.stringify({ mode, planSha256: expectedPlanSha256, writersDigest: digest, observation }, null, 2))
    return
  }
  if (argv.get('--confirm') !== CONFIRMATION) throw new Error('EXECUTION_CONFIRMATION_REQUIRED')
  if (argv.get('--expected-writers-sha256') !== digest) throw new Error('WRITER_DEFINITIONS_CHANGED_SINCE_APPROVAL')
  installOperatorAbortHandlers()

  const result = await runWeeklyBackupGeneration({
    plan,
    expectedPlanSha256,
    observation,
    runbookPath,
    approvedWriters: writers.map(({ label, definitionSha256, program }) => ({ label, definitionSha256, program })),
    writerDriver: createLaunchdWriterHoldDriver(writers),
    assertRuntimeIdentity,
    observeDynamicGate: observeDynamic,
    observePostflight: async () => ({
      dailySchedulesUnchanged: writersDigest(writerIdentities()) === digest,
      webHealthy: await healthy(3000),
      analogHealthy: await healthy(3105),
    }),
    onPhase: (phase) => console.log(JSON.stringify({ at: new Date().toISOString(), phase })),
    onProgress: (market, progress) => console.log(JSON.stringify({ at: new Date().toISOString(), market, progress })),
  })
  console.log(JSON.stringify({ result: 'GENERATION_PUBLISHED', ...result }, null, 2))
}

main().catch((error: unknown) => {
  console.error(`[weekly-backup] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
