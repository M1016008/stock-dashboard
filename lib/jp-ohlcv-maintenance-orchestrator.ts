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
  let committed: JpOhlcvMaintenanceTransactionResult | null = null
  const execution = await withWeeklyWriterHold({
    approved: input.config.writerServices.map((service) => ({
      label: service.label,
      definitionSha256: service.definitionSha256,
      program: service.program,
    })),
    maximumHoldMs: input.config.maximumMaintenanceMs,
    maximumStopWaitMs: 60_000,
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
