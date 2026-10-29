type ActiveStageProcess = {
  pid: number
  processGroupId: number
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
