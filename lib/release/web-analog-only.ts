import path from 'node:path'

export const WEB_ANALOG_TARGETS = [
  'com.stockboard.web',
  'com.stockboard.analog-search',
] as const

export const PRODUCTION_AGENT_INVENTORY = [
  ...WEB_ANALOG_TARGETS,
  'com.stockboard.trigger-historical-scan',
  'com.stockboard.web-health',
  'com.stockboard.update-latest',
  'com.stockboard.classification-sync',
  'com.stockboard.kabutan-material-news',
  'com.stockboard.kabutan-themes',
  'com.stockboard.earnings-refresh',
  'com.stockboard.us-update-latest',
  'com.stockboard.ml-learning',
  'com.stockboard.ml-freshness-guard',
  'com.stockboard.data-freshness-guard',
  'com.stockboard.weekly-optimization',
  'com.stockboard.db-maintenance',
  'com.stockboard.trigger-ml-frozen-monitor',
] as const

export type ProductionAgentLabel = (typeof PRODUCTION_AGENT_INVENTORY)[number]

export interface ReleaseLaunchAgentDefinition {
  Label?: string
  WorkingDirectory?: string
  ProgramArguments?: string[]
  EnvironmentVariables?: Record<string, string>
}

const REQUIRED_STORAGE_ENVIRONMENT = [
  'STOCKBOARD_DB_PATH',
  'STOCK_DATA_MOUNT_PATH',
  'STOCK_DATA_VOLUME_UUID',
  'STOCK_DATA_MIN_FREE_BYTES',
  'STOCK_DATA_MIN_FREE_PERCENT',
] as const

export function assertReleaseLaunchAgentDefinition(
  label: (typeof WEB_ANALOG_TARGETS)[number],
  definition: ReleaseLaunchAgentDefinition,
  releaseRoot: string,
): void {
  if (definition.Label !== label) throw new Error(`launchagent_label_mismatch:${label}`)
  if (!definition.WorkingDirectory || path.resolve(definition.WorkingDirectory) !== path.resolve(releaseRoot)) {
    throw new Error(`launchagent_working_directory_mismatch:${label}`)
  }
  const args = definition.ProgramArguments ?? []
  const expectedNext = path.join(path.resolve(releaseRoot), 'node_modules', 'next', 'dist', 'bin', 'next')
  if (args[1] !== expectedNext || !args.includes('start')) throw new Error(`launchagent_program_mismatch:${label}`)
  const environment = definition.EnvironmentVariables ?? {}
  const expectedRole = label === 'com.stockboard.web' ? 'web' : 'analog-search'
  if (environment.NODE_ENV !== 'production'
    || environment.STOCKBOARD_PROCESS_ROLE !== expectedRole
    || environment.NEXT_DIST_DIR !== '.next-live'
    || environment.SKIP_SCHEMA_ENSURE !== '1'
    || environment.USE_LOCAL_DB !== '1'
    || environment.EXTERNAL_STORAGE_REQUIRED !== 'true') {
    throw new Error(`launchagent_environment_mismatch:${label}`)
  }
  for (const key of REQUIRED_STORAGE_ENVIRONMENT) {
    if (!environment[key]?.trim()) throw new Error(`launchagent_storage_identity_missing:${label}:${key}`)
  }
}

export interface AgentState {
  loaded: boolean
  disabled: boolean
  state: string | null
}

export type AgentSnapshot = Record<ProductionAgentLabel, AgentState>

export interface WebAnalogReleaseAdapter {
  snapshotAgents(): AgentSnapshot | Promise<AgentSnapshot>
  assertHealthy(): void | Promise<void>
  promote(): void | Promise<void>
  restore(): void | boolean | Promise<void | boolean>
  needsRecovery?(): boolean | Promise<boolean>
  commit?(): void | Promise<void>
  kickstart(label: (typeof WEB_ANALOG_TARGETS)[number]): void | Promise<void>
}

function isTarget(label: ProductionAgentLabel): label is (typeof WEB_ANALOG_TARGETS)[number] {
  return WEB_ANALOG_TARGETS.includes(label as (typeof WEB_ANALOG_TARGETS)[number])
}

export function assertReleaseTargetsAvailable(snapshot: AgentSnapshot): void {
  for (const label of WEB_ANALOG_TARGETS) {
    const state = snapshot[label]
    if (!state.loaded || state.disabled || state.state !== 'running') {
      throw new Error(`release_target_not_running:${label}`)
    }
  }
}

/**
 * A release may change only the Web/Analog PIDs. Loaded and disabled state must
 * stay byte-for-byte equivalent for every known agent, including the targets.
 */
export function assertAgentStatePreserved(before: AgentSnapshot, after: AgentSnapshot): void {
  for (const label of PRODUCTION_AGENT_INVENTORY) {
    if (before[label].loaded !== after[label].loaded || before[label].disabled !== after[label].disabled) {
      throw new Error(`launchagent_state_changed:${label}`)
    }
    if (!isTarget(label) && before[label].state !== after[label].state) {
      throw new Error(`non_target_runtime_state_changed:${label}`)
    }
  }
}

export interface WebAnalogReleaseResult {
  before: AgentSnapshot
  after: AgentSnapshot
  rolledBack: false
}

export interface BestEffortSignalResult {
  signaled: number
  errors: string[]
}

export interface ReleaseRecoveryResult {
  restartRequired: boolean
  freeze: BestEffortSignalResult
  resume: BestEffortSignalResult
}

/** Keep rollback independent from freeze failures; resume targets only after verified recovery. */
export function recoverReleaseWithBestEffortSignals(options: {
  freezeRequired: boolean
  signal: (signal: 'SIGSTOP' | 'SIGCONT') => BestEffortSignalResult
  rollback: () => boolean
}): ReleaseRecoveryResult {
  const empty = (): BestEffortSignalResult => ({ signaled: 0, errors: [] })
  let freeze = empty()
  let resume = empty()
  let restartRequired = false
  let rollbackError: unknown
  try {
    if (options.freezeRequired) freeze = options.signal('SIGSTOP')
    restartRequired = options.rollback()
  } catch (error) {
    rollbackError = error
  }
  if (!rollbackError) {
    if (options.freezeRequired || freeze.signaled > 0) resume = options.signal('SIGCONT')
  }
  if (rollbackError) {
    throw new AggregateError([rollbackError, ...freeze.errors, ...resume.errors], 'release_rollback_failed_hold')
  }
  return {
    restartRequired: restartRequired || freeze.errors.length > 0 || resume.errors.length > 0,
    freeze,
    resume,
  }
}

/** Promote and restart exactly two existing services. Any post-promotion error restores the prior build. */
export async function runWebAnalogRelease(adapter: WebAnalogReleaseAdapter): Promise<WebAnalogReleaseResult> {
  const before = await adapter.snapshotAgents()
  assertReleaseTargetsAvailable(before)
  await adapter.assertHealthy()

  let promoted = false
  try {
    await adapter.promote()
    promoted = true
    for (const label of WEB_ANALOG_TARGETS) await adapter.kickstart(label)
    await adapter.assertHealthy()
    const after = await adapter.snapshotAgents()
    assertAgentStatePreserved(before, after)
    await adapter.commit?.()
    return { before, after, rolledBack: false }
  } catch (primaryError) {
    const rollbackErrors: unknown[] = []
    const recoveryRequired = promoted || await adapter.needsRecovery?.() === true
    if (recoveryRequired) {
      let restored = false
      let restartRequired = true
      try {
        restartRequired = await adapter.restore() !== false
        restored = true
      } catch (error) {
        rollbackErrors.push(error)
      }
      if (restored) {
        if (restartRequired) {
          for (const label of WEB_ANALOG_TARGETS) {
            try { await adapter.kickstart(label) } catch (error) { rollbackErrors.push(error) }
          }
        }
        try { await adapter.assertHealthy() } catch (error) { rollbackErrors.push(error) }
        try {
          const restoredSnapshot = await adapter.snapshotAgents()
          assertAgentStatePreserved(before, restoredSnapshot)
        } catch (error) {
          rollbackErrors.push(error)
        }
      }
    }
    throw new AggregateError(
      [primaryError, ...rollbackErrors],
      recoveryRequired ? 'web_analog_release_rolled_back_or_held' : 'web_analog_release_preflight_failed',
    )
  }
}
