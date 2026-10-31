import type { DatabaseHandle } from '@/lib/storage/launchd-writer-hold-driver'
import type { WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'
import { WEEKLY_BACKUP_READER_LABELS } from '@/lib/storage/weekly-backup-policy'

export const JP_OHLCV_READ_ISOLATION_STAGES = [
  'after_read_services_held',
  'pre_insert',
  'after_data_commit_before_source_publish',
  'before_derived_rebuild',
  'after_derived_rebuild',
  'after_serving_verification_before_read_resume',
] as const

export type JpOhlcvReadIsolationStage = (typeof JP_OHLCV_READ_ISOLATION_STAGES)[number]

export type JpOhlcvReadIsolationReceipt = {
  version: 1
  transactionId: string
  stage: JpOhlcvReadIsolationStage
  checkedAt: string
  heldServices: string[]
  databaseHandleCount: 0
}

function assertExactReaderInventory(labels: readonly string[]): void {
  const actual = [...new Set(labels)].sort()
  const expected = [...WEEKLY_BACKUP_READER_LABELS].sort()
  if (labels.length !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('repair_read_isolation_inventory_mismatch')
  }
}

export async function assertJpOhlcvRepairReadIsolation(input: {
  transactionId: string
  stage: JpOhlcvReadIsolationStage
  readServiceLabels: readonly string[]
  observeService: (label: string) => Promise<WriterRuntimeIdentity>
  inspectDatabaseHandles: () => DatabaseHandle[]
  now?: () => Date
}): Promise<JpOhlcvReadIsolationReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.transactionId)) {
    throw new Error('repair_read_isolation_transaction_id_invalid')
  }
  assertExactReaderInventory(input.readServiceLabels)
  const heldServices: string[] = []
  for (const label of input.readServiceLabels) {
    const observed = await input.observeService(label)
    if (observed.label !== label
      || observed.loaded
      || observed.instances !== 0
      || observed.pid !== null
      || observed.processGroupId !== null) {
      throw new Error(`repair_read_isolation_service_not_held:${label}`)
    }
    heldServices.push(label)
  }
  const handles = input.inspectDatabaseHandles()
  if (handles.length !== 0) {
    throw new Error(`repair_read_isolation_database_handle_present:${handles.map((handle) => handle.pid).join(',')}`)
  }
  return {
    version: 1,
    transactionId: input.transactionId,
    stage: input.stage,
    checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    heldServices: heldServices.sort(),
    databaseHandleCount: 0,
  }
}

export function assertJpOhlcvReadIsolationReceipt(
  receipt: JpOhlcvReadIsolationReceipt,
  stage: JpOhlcvReadIsolationStage,
  transactionId: string,
): void {
  if (!receipt || typeof receipt !== 'object'
    || !Array.isArray(receipt.heldServices)
    || typeof receipt.checkedAt !== 'string') {
    throw new Error(`repair_read_isolation_receipt_invalid:${stage}`)
  }
  assertExactReaderInventory(receipt.heldServices)
  if (receipt.version !== 1
    || receipt.transactionId !== transactionId
    || receipt.stage !== stage
    || !Number.isFinite(Date.parse(receipt.checkedAt))
    || receipt.databaseHandleCount !== 0) {
    throw new Error(`repair_read_isolation_receipt_invalid:${stage}`)
  }
}
