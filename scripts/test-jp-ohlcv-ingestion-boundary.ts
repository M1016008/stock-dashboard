import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import {
  assertJpOhlcvSourceRunPublishable,
  initializeJpOhlcvCoverageStore,
  publishJpOhlcvSourceRun,
} from '@/lib/jp-ohlcv-coverage-store'
import { applyJpOhlcvIngestionBoundary } from '@/lib/jp-ohlcv-ingestion-boundary'
import type { JpOfficialOhlcvValue } from '@/lib/jp-ohlcv-data-quality'

const rows = (date: string): JpOfficialOhlcvValue[] => [
  { ticker: '1306', date, open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date, open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
  { ticker: '2164', date, open: 113, high: 113, low: 105, close: 108.3, volume: 40, adjustmentFactor: 1 },
]

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-boundary-'))
  const client = createClient({ url: `file:${path.join(tempDir, 'fixture.sqlite')}` })
  try {
    await client.execute(`CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      PRIMARY KEY (ticker, date))`)
    await client.execute(`CREATE TABLE batch_runs (
      id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL)`)
    await client.execute("INSERT INTO batch_runs VALUES (100, 'ohlcv_fetch:jquants', 'running')")
    await initializeJpOhlcvCoverageStore(client)
    const july = rows('2026-07-17')
    for (const row of [july[0], { ...july[2], close: 270.2 }, { ...july[3], close: 108.2 }]) {
      await client.execute({
        sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
      })
    }
    await client.execute(`CREATE TRIGGER fail_boundary_head
      BEFORE INSERT ON jp_ohlcv_coverage_heads BEGIN SELECT RAISE(ABORT, 'fixture_boundary_crash'); END`)
    await assert.rejects(() => applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 100,
      targetDate: '2026-07-17',
      officialRows: july,
      bootstrapPreservedConflictTickers: ['1447', '2164'],
      requireRunningBatchRun: true,
    }), /fixture_boundary_crash/)
    const afterCrash = await client.execute("SELECT COUNT(*) AS count FROM ohlcv_daily WHERE ticker='7003'")
    assert.equal(Number(afterCrash.rows[0].count), 0)
    const receiptAfterCrash = await client.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_ingestion_receipts')
    const headAfterCrash = await client.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_coverage_heads')
    const runAfterCrash = await client.execute('SELECT status FROM batch_runs WHERE id = 100')
    assert.equal(Number(receiptAfterCrash.rows[0].count), 0)
    assert.equal(Number(headAfterCrash.rows[0].count), 0)
    assert.equal(runAfterCrash.rows[0].status, 'running')

    await client.execute('DROP TRIGGER fail_boundary_head')
    const first = await applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 100,
      targetDate: '2026-07-17',
      officialRows: july,
      bootstrapPreservedConflictTickers: ['1447', '2164'],
      requireRunningBatchRun: true,
    })
    assert.equal(first.inserted, 1)
    assert.equal(first.openMissing, 0)
    assert.equal(first.openConflicts, 2)
    assert.equal(first.publicationStatus, 'PARTIAL_HOLD')
    const sourceRun = await client.execute('SELECT status FROM batch_runs WHERE id = 100')
    assert.equal(sourceRun.rows[0].status, 'running')

    const october = rows('2026-10-30')
    await client.execute("INSERT INTO batch_runs VALUES (101, 'ohlcv_fetch:jquants', 'running')")
    for (const row of october) {
      await client.execute({
        sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
      })
    }
    const second = await applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 101,
      targetDate: '2026-10-30',
      officialRows: october,
      requireRunningBatchRun: true,
    })
    assert.equal(second.inserted, 0)
    assert.equal(second.alreadySatisfied, 4)
    assert.equal(second.missingCoverage, 'COMPLETE')
    assert.equal(second.dataQualityConflict, 'KNOWN_CONFLICTS')
    assert.equal(second.sourcePublication, 'PARTIAL_HOLD')
    assert.equal(second.openConflicts, 2)
    const replay = await applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 101,
      targetDate: '2026-10-30',
      officialRows: october,
    })
    assert.equal(replay.receiptSha256, second.receiptSha256)
    assert.equal(replay.inserted, 0)
    await client.execute("UPDATE ohlcv_daily SET close=999 WHERE ticker='1306' AND date='2026-10-30'")
    await assert.rejects(() => applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 101,
      targetDate: '2026-10-30',
      officialRows: october,
    }), /replay_identity_mismatch/)
    await client.execute("UPDATE ohlcv_daily SET close=407.9 WHERE ticker='1306' AND date='2026-10-30'")
    await assert.rejects(
      () => assertJpOhlcvSourceRunPublishable(client, { sourceRunId: 101, targetDate: '2026-10-30' }),
      /source_run_not_publishable/,
    )

    await client.execute("UPDATE ohlcv_daily SET close=269.9 WHERE ticker='1447' AND date='2026-07-17'")
    const november = rows('2026-11-02')
    await assert.rejects(() => applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 103,
      targetDate: '2026-11-02',
      officialRows: november,
    }), /ingestion_evidence_hold/)
    const novemberCount = await client.execute("SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date='2026-11-02'")
    assert.equal(Number(novemberCount.rows[0].count), 0)

    const newConflictDate = '2026-11-04'
    const newConflictRows = rows(newConflictDate)
    const conflict = { ...newConflictRows[0], close: 999 }
    await client.execute({
      sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [conflict.ticker, conflict.date, conflict.open, conflict.high, conflict.low, conflict.close, conflict.volume],
    })
    await assert.rejects(() => applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 104,
      targetDate: newConflictDate,
      officialRows: newConflictRows,
    }), /new_value_conflict/)
    const currentCount = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date = ?', args: [newConflictDate],
    })
    assert.equal(Number(currentCount.rows[0].count), 1)

    const cleanClient = createClient({ url: `file:${path.join(tempDir, 'clean.sqlite')}` })
    try {
      await cleanClient.execute(`CREATE TABLE ohlcv_daily (
        ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
        low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
        PRIMARY KEY (ticker, date))`)
      await cleanClient.execute(`CREATE TABLE batch_runs (
        id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL,
        finished_at INTEGER, total_tickers INTEGER, succeeded INTEGER, failed INTEGER,
        rows_inserted INTEGER, error_summary TEXT)`)
      await cleanClient.execute(`CREATE TABLE jquants_daily_coverage (
        date TEXT PRIMARY KEY, expected_rows INTEGER NOT NULL, imported_at INTEGER NOT NULL)`)
      await cleanClient.execute(`CREATE TABLE jquants_sync_runs (
        id INTEGER PRIMARY KEY, target_date TEXT NOT NULL, api_type TEXT NOT NULL,
        expected_rows INTEGER NOT NULL DEFAULT 0, imported_rows INTEGER NOT NULL DEFAULT 0,
        missing_tickers TEXT, status TEXT NOT NULL, finished_at INTEGER, error_summary TEXT)`)
      await cleanClient.execute("INSERT INTO batch_runs(id,job_type,status) VALUES(200,'ohlcv_fetch:jquants','running')")
      await cleanClient.execute("INSERT INTO jquants_sync_runs(id,target_date,api_type,status) VALUES(300,'2026-11-05','equities/bars/daily:date','running')")
      await initializeJpOhlcvCoverageStore(cleanClient)
      const cleanRows = rows('2026-11-05')
      for (const row of cleanRows) {
        await cleanClient.execute({
          sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
        })
      }
      const clean = await applyJpOhlcvIngestionBoundary(cleanClient, {
        sourceRunId: 200,
        targetDate: '2026-11-05',
        officialRows: cleanRows,
        requireRunningBatchRun: true,
      })
      assert.equal(clean.inserted, 0)
      assert.equal(clean.alreadySatisfied, 4)
      assert.equal(clean.missingCoverage, 'COMPLETE')
      assert.equal(clean.dataQualityConflict, 'CLEAN')
      assert.equal(clean.sourcePublication, 'PUBLISHABLE')
      await assertJpOhlcvSourceRunPublishable(cleanClient, {
        sourceRunId: 200,
        targetDate: '2026-11-05',
      })
      await publishJpOhlcvSourceRun(cleanClient, {
        sourceRunId: 200,
        targetDate: '2026-11-05',
        totalTickers: 4,
        succeeded: 4,
        failed: 0,
        rowsInserted: 0,
        errorSummary: '[]',
        syncRun: { id: 300, expectedRows: 4, importedRows: 4, missingTickersJson: '[]' },
      })
      const published = await cleanClient.execute('SELECT status, rows_inserted FROM batch_runs WHERE id=200')
      assert.equal(published.rows[0].status, 'success')
      assert.equal(Number(published.rows[0].rows_inserted), 0)
      const syncPublished = await cleanClient.execute('SELECT status FROM jquants_sync_runs WHERE id=300')
      const coveragePublished = await cleanClient.execute("SELECT expected_rows FROM jquants_daily_coverage WHERE date='2026-11-05'")
      assert.equal(syncPublished.rows[0].status, 'success')
      assert.equal(Number(coveragePublished.rows[0].expected_rows), 4)

      const nextRows = rows('2026-11-06')
      for (const row of nextRows) {
        await cleanClient.execute({
          sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
        })
      }
      await cleanClient.execute("INSERT INTO batch_runs(id,job_type,status) VALUES(201,'ohlcv_fetch:jquants','running')")
      await cleanClient.execute("INSERT INTO jquants_sync_runs(id,target_date,api_type,status) VALUES(301,'2026-11-06','equities/bars/daily:date','running')")
      await applyJpOhlcvIngestionBoundary(cleanClient, {
        sourceRunId: 201,
        targetDate: '2026-11-06',
        officialRows: nextRows,
        requireRunningBatchRun: true,
      })
      await cleanClient.execute("UPDATE ohlcv_daily SET close=999 WHERE ticker='1306' AND date='2026-11-06'")
      await assert.rejects(() => publishJpOhlcvSourceRun(cleanClient, {
        sourceRunId: 201,
        targetDate: '2026-11-06',
        totalTickers: 4,
        succeeded: 4,
        failed: 0,
        rowsInserted: 0,
        errorSummary: '[]',
        syncRun: { id: 301, expectedRows: 4, importedRows: 4, missingTickersJson: '[]' },
      }), /source_run_after_state_changed/)
      await cleanClient.execute("UPDATE ohlcv_daily SET close=407.9 WHERE ticker='1306' AND date='2026-11-06'")
      await assert.rejects(() => publishJpOhlcvSourceRun(cleanClient, {
        sourceRunId: 201,
        targetDate: '2026-11-06',
        totalTickers: 4,
        succeeded: 4,
        failed: 0,
        rowsInserted: 0,
        errorSummary: '[]',
        syncRun: { id: 999, expectedRows: 4, importedRows: 4, missingTickersJson: '[]' },
      }), /sync_run_finalize_compare_and_swap_failed/)
      const heldRun = await cleanClient.execute('SELECT status FROM batch_runs WHERE id=201')
      const heldSync = await cleanClient.execute('SELECT status FROM jquants_sync_runs WHERE id=301')
      const heldCoverage = await cleanClient.execute("SELECT COUNT(*) AS count FROM jquants_daily_coverage WHERE date='2026-11-06'")
      assert.equal(heldRun.rows[0].status, 'running')
      assert.equal(heldSync.rows[0].status, 'running')
      assert.equal(Number(heldCoverage.rows[0].count), 0)
    } finally {
      cleanClient.close()
    }
  } finally {
    client.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().then(() => console.log('JP OHLCV ingestion boundary tests: PASS')).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
