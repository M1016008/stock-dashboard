import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

type ActiveStageProcess = {
  pid: number
  processGroupId: number
}

export type RecordedProcessIdentity = {
  pid: number
  processGroupId: number
  identitySha256: string
}

const HANDLED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

let activeStageProcess: ActiveStageProcess | null = null
let shutdownSignal: NodeJS.Signals | null = null

export function isProcessGroupAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return false
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readProcessIdentity(pid: number): RecordedProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null
  const result = spawnSync('/bin/ps', ['-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 64_000,
    env: { ...process.env, COLUMNS: '4096' },
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null
  const normalized = result.stdout.trim().replace(/\s+/g, ' ')
  const fields = normalized.split(' ')
  const actualPid = Number(fields[0])
  const processGroupId = Number(fields[1])
  if (actualPid !== pid || !Number.isSafeInteger(processGroupId) || processGroupId <= 1) return null
  return {
    pid,
    processGroupId,
    identitySha256: crypto.createHash('sha256').update(normalized).digest('hex'),
  }
}

export function recordedProcessIdentityState(recorded: RecordedProcessIdentity):
  | 'MATCHING_PROCESS_ACTIVE'
  | 'RECORDED_PROCESS_GROUP_ACTIVE_WITHOUT_LEADER'
  | 'PID_ABSENT'
  | 'PID_REUSED_OR_IDENTITY_MISMATCH' {
  const current = readProcessIdentity(recorded.pid)
  if (!current) {
    return isProcessGroupAlive(recorded.processGroupId)
      ? 'RECORDED_PROCESS_GROUP_ACTIVE_WITHOUT_LEADER'
      : 'PID_ABSENT'
  }
  if (current.processGroupId !== recorded.processGroupId
    || current.identitySha256 !== recorded.identitySha256) {
    return 'PID_REUSED_OR_IDENTITY_MISMATCH'
  }
  return 'MATCHING_PROCESS_ACTIVE'
}

export function terminateProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error('repair_stage_process_group_invalid')
  }
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function terminateAndWaitForProcessGroup(
  processGroupId: number,
  graceMs = 5_000,
): Promise<void> {
  if (!isProcessGroupAlive(processGroupId)) return
  terminateProcessGroup(processGroupId, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return
    await sleep(50)
  }
  terminateProcessGroup(processGroupId, 'SIGKILL')
  const killDeadline = Date.now() + 5_000
  while (Date.now() < killDeadline) {
    if (!isProcessGroupAlive(processGroupId)) return
    await sleep(50)
  }
  throw new Error('repair_stage_process_group_survived_sigkill')
}

export function registerActiveStageProcess(processInfo: ActiveStageProcess): void {
  assertJpOhlcvRepairExecutionActive()
  if (activeStageProcess) throw new Error('repair_stage_process_already_active')
  if (processInfo.pid !== processInfo.processGroupId || processInfo.pid <= 1) {
    throw new Error('repair_stage_process_group_identity_invalid')
  }
  activeStageProcess = processInfo
}

export function clearActiveStageProcess(processGroupId: number): void {
  if (!activeStageProcess) return
  if (activeStageProcess.processGroupId !== processGroupId) {
    throw new Error('repair_stage_process_group_clear_mismatch')
  }
  activeStageProcess = null
}

export function assertJpOhlcvRepairExecutionActive(): void {
  if (shutdownSignal) throw new Error(`repair_execution_interrupted:${shutdownSignal}`)
}

export function currentJpOhlcvRepairShutdownSignal(): NodeJS.Signals | null {
  return shutdownSignal
}

export function installJpOhlcvRepairSignalHandlers(): () => void {
  if (shutdownSignal || activeStageProcess) throw new Error('repair_signal_supervisor_not_clean')
  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of HANDLED_SIGNALS) {
    const handler = () => {
      shutdownSignal ??= signal
      const active = activeStageProcess
      if (active) {
        void terminateAndWaitForProcessGroup(active.processGroupId).catch(() => {
          // The journal retains the process group identity for operator recovery.
        })
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
    if (activeStageProcess) throw new Error('repair_signal_supervisor_child_still_active')
    shutdownSignal = null
  }
}
