import {
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  type JpOhlcvProductionExecutionConfiguration,
} from '@/lib/jp-ohlcv-executable-plan'
import {
  withWeeklyWriterHold,
  type ApprovedWriterIdentity,
  type WriterHoldDriver,
  type WriterHoldReceipt,
  type WriterRuntimeIdentity,
} from '@/lib/storage/weekly-writer-hold'
import { JP_OHLCV_BACKUP_TIME_LIMITS } from '@/lib/jp-ohlcv-backup-time-budget'
import { WEEKLY_BACKUP_WRITER_LABELS } from '@/lib/storage/weekly-backup-policy'

export const JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS = [
  'com.stockboard.large-holder-update',
  'com.stockboard.ml-weekly-governance',
  'com.stockboard.us-ml-weekly',
] as const

export const JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS = [
  'com.stockboard.ml-weekly-governance',
  'com.stockboard.us-ml-weekly',
] as const

export const JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS = WEEKLY_BACKUP_WRITER_LABELS.filter(
  (label) => !JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.includes(
    label as (typeof JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS)[number],
  ),
)

export type JpOhlcvMaintenanceTransactionResult = {
  status: 'COMMITTED'
  archivedJournal: string
  transactionId: string
}

export type JpOhlcvWriterRecoveryReceipt = {
  restoredLabels: string[]
  alreadyLoadedLabels: string[]
  preservedUnloadedLabels: string[]
  startedAtMs: number
  completedAtMs: number
  durationMs: number
}

function assertWriterRecoveryIdentity(
  expected: ApprovedWriterIdentity,
  observed: WriterRuntimeIdentity,
): void {
  if (observed.label !== expected.label
    || observed.definitionSha256 !== expected.definitionSha256
    || observed.program !== expected.program) {
    throw new Error(`repair_writer_recovery_identity_mismatch:${expected.label}`)
  }
  if (observed.instances < 0 || observed.instances > 1 || (observed.disabled && observed.loaded)) {
    throw new Error(`repair_writer_recovery_runtime_state_invalid:${expected.label}`)
  }
}

export async function restoreJpOhlcvMaintenanceWriters(input: {
  config: JpOhlcvProductionExecutionConfiguration
  driver: WriterHoldDriver
  assertRecoverySafe: () => Promise<void>
  maximumWaitMs?: number
  pollIntervalMs?: number
}): Promise<JpOhlcvWriterRecoveryReceipt> {
  const maximumWaitMs = input.maximumWaitMs ?? 60_000
  const pollIntervalMs = input.pollIntervalMs ?? 250
  if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs <= 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0
    || pollIntervalMs > maximumWaitMs) {
    throw new Error('repair_writer_recovery_wait_invalid')
  }
  const approved = input.config.writerServices.map((service) => ({
    label: service.label,
    definitionSha256: service.definitionSha256,
    program: service.program,
  }))
  const approvedLabels = new Set(approved.map((service) => service.label))
  if (approvedLabels.size !== approved.length
    || JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS.length + JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.length
      !== approved.length
    || [...JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS, ...JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS]
      .some((label) => !approvedLabels.has(label))) {
    throw new Error('repair_writer_recovery_inventory_mismatch')
  }

  const expectedDisabled = new Set<string>(JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS)
  const expectedUnloaded = new Set<string>(JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS)
  const observe = async (expected: ApprovedWriterIdentity): Promise<WriterRuntimeIdentity> => {
    const observed = await input.driver.observe(expected.label)
    assertWriterRecoveryIdentity(expected, observed)
    if (observed.disabled !== expectedDisabled.has(expected.label)) {
      throw new Error(`repair_writer_recovery_disabled_state_mismatch:${expected.label}`)
    }
    return observed
  }
  const waitLoaded = async (expected: ApprovedWriterIdentity): Promise<void> => {
    const deadline = input.driver.now() + maximumWaitMs
    for (;;) {
      const observed = await observe(expected)
      if (observed.loaded && observed.instances === 1 && !observed.disabled) return
      if (input.driver.now() >= deadline) {
        throw new Error(`repair_writer_recovery_bootstrap_timeout:${expected.label}`)
      }
      await input.driver.sleep(pollIntervalMs)
    }
  }

  for (const expected of approved) {
    const observed = await observe(expected)
    if (expectedUnloaded.has(expected.label) && (observed.loaded || observed.instances !== 0)) {
      throw new Error(`repair_writer_recovery_unloaded_service_changed:${expected.label}`)
    }
  }
  await input.assertRecoverySafe()

  const startedAtMs = input.driver.now()
  const restoredLabels: string[] = []
  const alreadyLoadedLabels: string[] = []
  for (const expected of [...approved].reverse()) {
    if (expectedUnloaded.has(expected.label)) continue
    await input.assertRecoverySafe()
    const observed = await observe(expected)
    if (observed.loaded) {
      alreadyLoadedLabels.push(expected.label)
      continue
    }
    if (observed.instances !== 0 || observed.disabled) {
      throw new Error(`repair_writer_recovery_prebootstrap_state_invalid:${expected.label}`)
    }
    await input.driver.bootstrap(expected.label)
    await waitLoaded(expected)
    restoredLabels.push(expected.label)
  }

  await input.assertRecoverySafe()
  for (const expected of approved) {
    const observed = await observe(expected)
    const shouldLoad = !expectedUnloaded.has(expected.label)
    if (observed.loaded !== shouldLoad || observed.instances !== (shouldLoad ? 1 : 0)) {
      throw new Error(`repair_writer_recovery_final_state_mismatch:${expected.label}`)
    }
  }
  const completedAtMs = input.driver.now()
  return {
    restoredLabels,
    alreadyLoadedLabels,
    preservedUnloadedLabels: [...JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS],
    startedAtMs,
    completedAtMs,
    durationMs: completedAtMs - startedAtMs,
  }
}

export async function runJpOhlcvMaintenanceOrchestrator(input: {
  config: JpOhlcvProductionExecutionConfiguration
  driver: WriterHoldDriver
  runTransaction: (assertWriterHoldValid: () => Promise<void>) => Promise<JpOhlcvMaintenanceTransactionResult>
  assertOnlyApprovedReaderHandles: () => Promise<void>
  assertCommittedState: (result: JpOhlcvMaintenanceTransactionResult) => Promise<void>
}): Promise<{ result: JpOhlcvMaintenanceTransactionResult; writerHold: WriterHoldReceipt }> {
  if (input.config.mode === 'PRODUCTION'
    && (JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS.length
        !== JP_OHLCV_BACKUP_TIME_LIMITS.writerRestoreLoadedServices
      || JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.length
        !== JP_OHLCV_BACKUP_TIME_LIMITS.writerRestoreUnloadedServices
      || JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS.some(
        (label) => !JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.includes(label),
      ))) {
    throw new Error('repair_writer_expected_state_budget_mismatch')
  }
  let committed: JpOhlcvMaintenanceTransactionResult | null = null
  const execution = await withWeeklyWriterHold({
    approved: input.config.writerServices.map((service) => ({
      label: service.label,
      definitionSha256: service.definitionSha256,
      program: service.program,
    })),
    maximumHoldMs: input.config.maximumMaintenanceMs,
    maximumStopWaitMs: 60_000,
    restoreSloMs: JP_OHLCV_BACKUP_TIME_LIMITS.writerRestoreSloMs,
    expectedLoadedLabels: input.config.mode === 'PRODUCTION'
      ? JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS
      : undefined,
    expectedUnloadedLabels: input.config.mode === 'PRODUCTION'
      ? JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS
      : undefined,
    expectedDisabledLabels: input.config.mode === 'PRODUCTION'
      ? JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS
      : undefined,
    stopPollIntervalMs: 250,
    driver: input.driver,
    operation: async (assertWriterHoldValid) => {
      await assertWriterHoldValid()
      await input.assertOnlyApprovedReaderHandles()
      if (databaseFileObjectIdentitySha256(input.config.databaseRealpath)
          !== input.config.databaseObjectIdentitySha256) {
        throw new Error('repair_orchestrator_database_object_identity_mismatch')
      }
      if (databaseSchemaIdentitySha256(input.config.databaseRealpath, input.config.sqliteExecutable)
          !== input.config.databaseIdentitySha256) {
        throw new Error('repair_orchestrator_database_schema_identity_mismatch')
      }
      const result = await input.runTransaction(assertWriterHoldValid)
      if (result.status !== 'COMMITTED') throw new Error('repair_orchestrator_transaction_not_committed')
      await assertWriterHoldValid()
      await input.assertCommittedState(result)
      committed = result
      return result
    },
    assertRestoreSafe: async () => {
      if (!committed) throw new Error('repair_orchestrator_writer_restore_blocked_uncommitted')
      await input.assertCommittedState(committed)
    },
  })
  return { result: execution.result, writerHold: execution.receipt }
}
