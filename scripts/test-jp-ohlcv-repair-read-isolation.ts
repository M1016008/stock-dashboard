import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertJpOhlcvReadIsolationReceipt,
  assertJpOhlcvRepairReadIsolation,
} from '@/lib/jp-ohlcv-repair-read-isolation'
import { WEEKLY_BACKUP_READER_LABELS } from '@/lib/storage/weekly-backup-policy'
import { assertNoUnauthorizedDatabaseHandles } from '@/lib/storage/launchd-writer-hold-driver'
import type { WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'

const held = (label: string): WriterRuntimeIdentity => ({
  label,
  definitionSha256: 'a'.repeat(64),
  program: `/fixture/${label}`,
  loaded: false,
  disabled: false,
  instances: 0,
  pid: null,
  processGroupId: null,
})

async function main(): Promise<void> {
  const transactionId = 'fixture-read-isolation'
  const receipt = await assertJpOhlcvRepairReadIsolation({
    transactionId,
    stage: 'pre_insert',
    readServiceLabels: WEEKLY_BACKUP_READER_LABELS,
    observeService: async (label) => held(label),
    inspectDatabaseHandles: () => [],
    now: () => new Date('2026-11-01T00:00:00.000Z'),
  })
  assertJpOhlcvReadIsolationReceipt(receipt, 'pre_insert', transactionId)
  assert.deepEqual(receipt.heldServices, [...WEEKLY_BACKUP_READER_LABELS].sort())

  await assert.rejects(() => assertJpOhlcvRepairReadIsolation({
    transactionId,
    stage: 'pre_insert',
    readServiceLabels: WEEKLY_BACKUP_READER_LABELS.slice(0, 3),
    observeService: async (label) => held(label),
    inspectDatabaseHandles: () => [],
  }), /repair_read_isolation_inventory_mismatch/)

  await assert.rejects(() => assertJpOhlcvRepairReadIsolation({
    transactionId,
    stage: 'before_derived_rebuild',
    readServiceLabels: WEEKLY_BACKUP_READER_LABELS,
    observeService: async (label) => label === 'com.stockboard.web'
      ? { ...held(label), loaded: true, instances: 1, pid: 42, processGroupId: 42 }
      : held(label),
    inspectDatabaseHandles: () => [],
  }), /repair_read_isolation_service_not_held:com\.stockboard\.web/)

  await assert.rejects(() => assertJpOhlcvRepairReadIsolation({
    transactionId,
    stage: 'after_data_commit_before_source_publish',
    readServiceLabels: WEEKLY_BACKUP_READER_LABELS,
    observeService: async (label) => held(label),
    inspectDatabaseHandles: () => [{ pid: 9876, command: 'sqlite3', files: ['/fixture/stockboard.db'] }],
  }), /repair_read_isolation_database_handle_present:9876/)

  assert.throws(() => assertJpOhlcvReadIsolationReceipt({
    ...receipt,
    stage: 'after_derived_rebuild',
  }, 'pre_insert', transactionId), /repair_read_isolation_receipt_invalid:pre_insert/)
  assert.throws(() => assertJpOhlcvReadIsolationReceipt({
    ...receipt,
    checkedAt: 123,
    heldServices: null,
  } as unknown as typeof receipt, 'pre_insert', transactionId), /repair_read_isolation_receipt_invalid:pre_insert/)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-read-isolation-'))
  const databasePath = path.join(root, 'fixture.sqlite')
  const probeFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
  for (const file of probeFiles) fs.writeFileSync(file, 'fixture')
  const descriptors: number[] = []
  try {
    for (const file of probeFiles) descriptors.push(fs.openSync(file, 'r'))
    await assert.rejects(() => assertJpOhlcvRepairReadIsolation({
      transactionId,
      stage: 'pre_insert',
      readServiceLabels: WEEKLY_BACKUP_READER_LABELS,
      observeService: async (label) => held(label),
      inspectDatabaseHandles: () => assertNoUnauthorizedDatabaseHandles({
        databasePath,
        approvedReaders: [],
        timeoutMs: 5_000,
      }),
    }), /UNAUTHORIZED_DATABASE_HANDLE/)
    while (descriptors.length > 0) fs.closeSync(descriptors.pop()!)
    const actualProbe = await assertJpOhlcvRepairReadIsolation({
      transactionId,
      stage: 'pre_insert',
      readServiceLabels: WEEKLY_BACKUP_READER_LABELS,
      observeService: async (label) => held(label),
      inspectDatabaseHandles: () => assertNoUnauthorizedDatabaseHandles({
        databasePath,
        approvedReaders: [],
        timeoutMs: 5_000,
      }),
    })
    assert.equal(actualProbe.databaseHandleCount, 0)
  } finally {
    while (descriptors.length > 0) fs.closeSync(descriptors.pop()!)
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log(JSON.stringify({
    status: 'PASS',
    readers: WEEKLY_BACKUP_READER_LABELS.length,
    negativeCases: 5,
    realLsofProbe: 'PASS',
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
