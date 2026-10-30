import {
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  type JpOhlcvProductionExecutionConfiguration,
} from '@/lib/jp-ohlcv-executable-plan'
import {
  withWeeklyWriterHold,
  type WriterHoldDriver,
  type WriterHoldReceipt,
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
