import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import {
  initializeJpOhlcvCoverageStore,
  loadJpOhlcvCoverageHead,
  persistJpOhlcvCoverageTransition,
} from '@/lib/jp-ohlcv-coverage-store'
import {
  reconcileJpOhlcvCoverageLedger,
  type JpOhlcvCoverageProjection,
  type JpOhlcvPriorIssueObservation,
} from '@/lib/jp-ohlcv-coverage-ledger'
import { buildJpOhlcvIngestionReceipt } from '@/lib/jp-ohlcv-ingestion-receipt'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  buildJpOhlcvRuntimeRepairScope,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

const exact = (row: JpOfficialOhlcvValue): JpOhlcvValue => {
  const { adjustmentFactor: _factor, ...value } = row
  return value
}
const officialForDate = (date: string): JpOfficialOhlcvValue[] => [
  { ticker: '1306', date, open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date, open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
  { ticker: '2164', date, open: 113, high: 113, low: 105, close: 108.3, volume: 40, adjustmentFactor: 1 },
]

function buildTransition(input: {
  date: string
  sourceRunId: number
  previous: JpOhlcvCoverageProjection | null
  priorIssueObservations: JpOhlcvPriorIssueObservation[]
  preserveConflicts: boolean
}) {
  const official = officialForDate(input.date)
  const before = input.preserveConflicts
    ? [exact(official[0]), { ...exact(official[2]), close: 270.2 }, { ...exact(official[3]), close: 108.2 }]
    : [exact(official[0]), exact(official[2]), exact(official[3])]
  const after = [...before, exact(official[1])]
  const approvalPlan = buildJpOhlcvBackfillPlan({ date: input.date, officialRows: official, existingRows: before })
  const approvalScope = buildJpOhlcvMissingOnlyRepairScope({
    plan: approvalPlan,
    approvedConflictTickers: input.preserveConflicts ? ['1447', '2164'] : [],
  })
  const runtimeScope = buildJpOhlcvRuntimeRepairScope({ approvalScope, officialRows: official, existingRows: before })
  const receipt = buildJpOhlcvIngestionReceipt({
    expectedApproval: {
      approvalPlanSha256: runtimeScope.approvalPlanSha256,
      approvedRepairKeysSha256: runtimeScope.approvedRepairKeysSha256,
    },
    approvedScope: runtimeScope,
    officialRows: official,
    beforeRows: before,
    afterRows: after,
  })
  const projection = reconcileJpOhlcvCoverageLedger({
    sourceRunId: input.sourceRunId,
    targetDate: input.date,
    officialRows: official,
    existingRows: after,
    previousProjection: input.previous,
    expectedPreviousProjectionSha256: input.previous?.projectionSha256 ?? null,
    priorIssueObservations: input.priorIssueObservations,
  })
  return { projection, receipt, before, after }
}

async function main(): Promise<void> {
  const first = buildTransition({
    date: '2026-07-17', sourceRunId: 20, previous: null,
    priorIssueObservations: [], preserveConflicts: true,
  })
  assert.equal(first.receipt.status, 'APPROVED_KEYS_SATISFIED')
  assert.equal(first.receipt.dataQualityStatus, 'UNRESOLVED_CONFLICTS_HOLD')
  assert.equal(first.projection.publicationStatus, 'PARTIAL_HOLD')
  const julyObservations: JpOhlcvPriorIssueObservation[] = first.before
    .filter((row) => row.ticker === '1447' || row.ticker === '2164')
    .map((existing) => ({ date: existing.date, ticker: existing.ticker, existing }))
  const second = buildTransition({
    date: '2026-10-30', sourceRunId: 21, previous: first.projection,
    priorIssueObservations: julyObservations, preserveConflicts: false,
  })
  const stale = buildTransition({
    date: '2026-11-02', sourceRunId: 22, previous: first.projection,
    priorIssueObservations: julyObservations, preserveConflicts: false,
  })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-coverage-store-'))
  const client = createClient({ url: `file:${path.join(tempDir, 'coverage.sqlite')}` })
  try {
    await initializeJpOhlcvCoverageStore(client)
    assert.equal(await loadJpOhlcvCoverageHead(client), null)

    await client.execute(`CREATE TRIGGER fail_coverage_head_insert
      BEFORE INSERT ON jp_ohlcv_coverage_heads BEGIN SELECT RAISE(ABORT, 'fixture_insert_crash'); END`)
    await assert.rejects(() => persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 20,
      expectedPreviousProjectionSha256: null,
      projection: first.projection,
      receipt: first.receipt,
    }), /fixture_insert_crash/)
    const receiptCountAfterCrash = await client.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_ingestion_receipts')
    assert.equal(Number(receiptCountAfterCrash.rows[0].count), 0)
    assert.equal(await loadJpOhlcvCoverageHead(client), null)

    await client.execute('DROP TRIGGER fail_coverage_head_insert')
    const head = await persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 20,
      expectedPreviousProjectionSha256: null,
      projection: first.projection,
      receipt: first.receipt,
    })
    assert.equal(head.projectionSha256, first.projection.projectionSha256)
    assert.equal(head.receiptSha256, first.receipt.receiptSha256)
    assert.equal(head.receipt.receiptSha256, first.receipt.receiptSha256)

    const replay = await persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 20,
      expectedPreviousProjectionSha256: null,
      projection: first.projection,
      receipt: first.receipt,
    })
    assert.equal(replay.bindingSha256, head.bindingSha256)

    await client.execute(`CREATE TRIGGER fail_coverage_head_update
      BEFORE UPDATE ON jp_ohlcv_coverage_heads BEGIN SELECT RAISE(ABORT, 'fixture_update_crash'); END`)
    await assert.rejects(() => persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 21,
      expectedPreviousProjectionSha256: first.projection.projectionSha256,
      projection: second.projection,
      receipt: second.receipt,
    }), /fixture_update_crash/)
    const countAfterUpdateCrash = await client.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_ingestion_receipts')
    assert.equal(Number(countAfterUpdateCrash.rows[0].count), 1)
    assert.equal((await loadJpOhlcvCoverageHead(client))?.sourceRunId, 20)

    await client.execute('DROP TRIGGER fail_coverage_head_update')
    const secondHead = await persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 21,
      expectedPreviousProjectionSha256: first.projection.projectionSha256,
      projection: second.projection,
      receipt: second.receipt,
    })
    assert.equal(secondHead.sourceRunId, 21)

    await assert.rejects(() => persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 22,
      expectedPreviousProjectionSha256: first.projection.projectionSha256,
      projection: stale.projection,
      receipt: stale.receipt,
    }), /compare_and_swap_failed/)

    await assert.rejects(() => persistJpOhlcvCoverageTransition(client, {
      sourceRunId: 20,
      expectedPreviousProjectionSha256: null,
      projection: first.projection,
      receipt: second.receipt,
    }), /transition_contract_invalid/)

    await assert.rejects(() => client.execute({
      sql: 'UPDATE jp_ohlcv_ingestion_receipts SET receipt_json = ? WHERE source_run_id = ?',
      args: ['{}', 21],
    }), /receipt_immutable/)
    await assert.rejects(() => client.execute({
      sql: 'DELETE FROM jp_ohlcv_ingestion_receipts WHERE source_run_id = ?',
      args: [21],
    }), /receipt_immutable/)
    await client.execute('DROP TRIGGER jp_ohlcv_ingestion_receipts_no_update')
    await client.execute({
      sql: 'UPDATE jp_ohlcv_ingestion_receipts SET receipt_json = ? WHERE source_run_id = ?',
      args: [JSON.stringify({ ...second.receipt, targetDate: '2026-10-29' }), 21],
    })
    await assert.rejects(() => loadJpOhlcvCoverageHead(client), /receipt_hash_mismatch/)
    await client.execute('DELETE FROM jp_ohlcv_coverage_heads')
    await assert.rejects(() => loadJpOhlcvCoverageHead(client), /head_missing_with_receipts/)
  } finally {
    client.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().then(() => {
  console.log('JP OHLCV coverage store tests: PASS')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
