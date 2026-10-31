export type ServiceRuntimeObservation = {
  loaded: boolean
  disabled: boolean
  instances: number
  pid?: number | null
}

export type StableServiceReadiness = {
  label: string
  pid: number
  checks: number
  pidChanges: number
  startedAt: string
  readyAt: string
}

export async function waitForStableServiceReadiness(input: {
  label: string
  observe: () => Promise<ServiceRuntimeObservation>
  probe: () => Promise<void>
  timeoutMs: number
  intervalMs: number
  consecutivePasses: number
  minimumStableMs?: number
  maximumPidChanges?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<StableServiceReadiness> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || !Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1
    || !Number.isSafeInteger(input.consecutivePasses) || input.consecutivePasses < 1) {
    throw new Error('service_readiness_budget_invalid')
  }
  const maximumPidChanges = input.maximumPidChanges ?? 3
  const minimumStableMs = input.minimumStableMs ?? 0
  if (!Number.isSafeInteger(maximumPidChanges) || maximumPidChanges < 0) {
    throw new Error('service_readiness_pid_change_budget_invalid')
  }
  if (!Number.isSafeInteger(minimumStableMs) || minimumStableMs < 0 || minimumStableMs > input.timeoutMs) {
    throw new Error('service_readiness_stability_budget_invalid')
  }
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const startedAtMs = now()
  let stablePid: number | null = null
  let consecutivePasses = 0
  let checks = 0
  let pidChanges = 0
  let stableSinceMs: number | null = null
  let lastFailure = 'not_observed'

  while (now() - startedAtMs <= input.timeoutMs) {
    checks += 1
    try {
      const observed = await input.observe()
      if (!observed.loaded || observed.disabled || observed.instances !== 1
        || !Number.isSafeInteger(observed.pid) || (observed.pid ?? 0) <= 0) {
        throw new Error(
          `launchd_not_ready:loaded_${observed.loaded}:disabled_${observed.disabled}:`
          + `instances_${observed.instances}:pid_${observed.pid ?? 'none'}`,
        )
      }
      const pid = observed.pid as number
      if (stablePid !== null && pid !== stablePid) {
        pidChanges += 1
        consecutivePasses = 0
        stableSinceMs = null
        if (pidChanges > maximumPidChanges) throw new Error('launchd_restart_loop')
      }
      stablePid = pid
      if (stableSinceMs === null) stableSinceMs = now()
      await input.probe()
      consecutivePasses += 1
      const confirmed = await input.observe()
      if (!confirmed.loaded || confirmed.disabled || confirmed.instances !== 1 || confirmed.pid !== pid) {
        throw new Error('launchd_identity_changed_after_probe')
      }
      if (consecutivePasses >= input.consecutivePasses
        && now() - stableSinceMs >= minimumStableMs) {
        return {
          label: input.label,
          pid,
          checks,
          pidChanges,
          startedAt: new Date(startedAtMs).toISOString(),
          readyAt: new Date(now()).toISOString(),
        }
      }
      lastFailure = `stabilizing_${consecutivePasses}_of_${input.consecutivePasses}`
    } catch (error) {
      consecutivePasses = 0
      stableSinceMs = null
      lastFailure = error instanceof Error ? error.message : String(error)
      if (lastFailure === 'launchd_restart_loop') break
    }
    const remainingMs = input.timeoutMs - (now() - startedAtMs)
    if (remainingMs <= 0) break
    await sleep(Math.min(input.intervalMs, remainingMs))
  }
  throw new Error(`service_readiness_timeout:${input.label}:${lastFailure}`)
}
