import { spawn, type SpawnOptions } from 'node:child_process'
import {
  attestCurrentServingProjectionRunner,
  type CurrentServingProjectionRunnerAttestation,
} from '@/lib/research/six-stage-current-serving-runner-attestation'

export type CurrentServingProjectionRunnerResult = {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A child spawned by this process has the same uid. EPERM therefore means
    // the numeric process-group id now belongs to an unrelated OS process.
    if (code === 'ESRCH' || code === 'EPERM') return false
    throw error
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function currentServingProjectionRunnerInvocation(
  attestation: CurrentServingProjectionRunnerAttestation,
): { command: string; args: string[]; options: Pick<SpawnOptions, 'cwd' | 'detached'> } {
  return {
    command: process.execPath,
    args: [
      attestation.tsxPath,
      '--tsconfig',
      attestation.tsconfigPath,
      attestation.runnerPath,
    ],
    options: { cwd: attestation.root, detached: true },
  }
}

export async function runAttestedCurrentServingProjection(input: {
  environment: NodeJS.ProcessEnv
  timeoutMs?: number
  terminationGraceMs?: number
}): Promise<CurrentServingProjectionRunnerResult> {
  const timeoutMs = input.timeoutMs ?? 5 * 60_000
  const terminationGraceMs = input.terminationGraceMs ?? 10_000
  if (
    !Number.isFinite(timeoutMs)
    || !Number.isFinite(terminationGraceMs)
    || timeoutMs <= 1_000
    || terminationGraceMs < 100
    || terminationGraceMs >= timeoutMs
  ) {
    throw new Error('CURRENT_PROJECTION_INVALID_PROCESS_DEADLINE')
  }
  const attestation = attestCurrentServingProjectionRunner(input.environment)
  const invocation = currentServingProjectionRunnerInvocation(attestation)
  const startedAt = Date.now()
  const softDeadline = startedAt + timeoutMs - terminationGraceMs
  const hardDeadline = startedAt + timeoutMs
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      ...invocation.options,
      env: input.environment,
      stdio: 'inherit',
      shell: false,
    })
    let timedOut = false
    let settling = false
    let receivedSignal: NodeJS.Signals | null = null
    const softTimer = setTimeout(() => {
      timedOut = true
      if (child.pid) signalProcessGroup(child.pid, 'SIGTERM')
    }, Math.max(1, softDeadline - Date.now()))
    const hardTimer = setTimeout(() => {
      timedOut = true
      if (child.pid) signalProcessGroup(child.pid, 'SIGKILL')
    }, Math.max(1, hardDeadline - Date.now()))

    const cleanup = () => {
      clearTimeout(softTimer)
      clearTimeout(hardTimer)
      process.off('SIGINT', forwardInterrupt)
      process.off('SIGTERM', forwardTermination)
    }
    const forwardInterrupt = () => {
      receivedSignal = 'SIGINT'
      if (child.pid) signalProcessGroup(child.pid, 'SIGINT')
    }
    const forwardTermination = () => {
      receivedSignal = 'SIGTERM'
      if (child.pid) signalProcessGroup(child.pid, 'SIGTERM')
    }
    process.once('SIGINT', forwardInterrupt)
    process.once('SIGTERM', forwardTermination)

    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settling) return
      settling = true
      void (async () => {
        if (child.pid && processGroupExists(child.pid)) {
          signalProcessGroup(child.pid, timedOut ? 'SIGKILL' : 'SIGTERM')
          const residualDeadline = timedOut ? hardDeadline + 1_000 : Date.now() + terminationGraceMs
          while (processGroupExists(child.pid) && Date.now() < residualDeadline) await sleep(50)
          if (processGroupExists(child.pid)) signalProcessGroup(child.pid, 'SIGKILL')
          await sleep(50)
          if (processGroupExists(child.pid)) {
            cleanup()
            reject(new Error('CURRENT_PROJECTION_RUNNER_PROCESS_GROUP_RESIDUAL'))
            return
          }
        }
        cleanup()
        if (receivedSignal) {
          process.kill(process.pid, receivedSignal)
          return
        }
        resolve({ code: timedOut ? 124 : code, signal, timedOut })
      })().catch((error) => {
        cleanup()
        reject(error)
      })
    })
  })
}
