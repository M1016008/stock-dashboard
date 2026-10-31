import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { initializeJpOhlcvCoverageStore } from '@/lib/jp-ohlcv-coverage-store'
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
    }), /fixture_boundary_crash/)
    const afterCrash = await client.execute("SELECT COUNT(*) AS count FROM ohlcv_daily WHERE ticker='7003'")
    assert.equal(Number(afterCrash.rows[0].count), 0)

    await client.execute('DROP TRIGGER fail_boundary_head')
    const first = await applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 100,
      targetDate: '2026-07-17',
      officialRows: july,
      bootstrapPreservedConflictTickers: ['1447', '2164'],
    })
    assert.equal(first.inserted, 1)
    assert.equal(first.openMissing, 0)
    assert.equal(first.openConflicts, 2)
    assert.equal(first.publicationStatus, 'PARTIAL_HOLD')

    const october = rows('2026-10-30')
    for (const row of october.slice(0, 3)) {
      await client.execute({
        sql: 'INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
      })
    }
    const second = await applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 101,
      targetDate: '2026-10-30',
      officialRows: october,
    })
    assert.equal(second.inserted, 1)
    assert.equal(second.openConflicts, 2)

    await client.execute("UPDATE ohlcv_daily SET close=269.9 WHERE ticker='1447' AND date='2026-07-17'")
    const november = rows('2026-11-02')
    await assert.rejects(() => applyJpOhlcvIngestionBoundary(client, {
      sourceRunId: 102,
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
      sourceRunId: 103,
      targetDate: newConflictDate,
      officialRows: newConflictRows,
    }), /new_value_conflict/)
    const currentCount = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date = ?', args: [newConflictDate],
    })
    assert.equal(Number(currentCount.rows[0].count), 1)
  } finally {
    client.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().then(() => console.log('JP OHLCV ingestion boundary tests: PASS')).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
