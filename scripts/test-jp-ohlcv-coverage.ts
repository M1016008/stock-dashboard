import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { ensureSchema } from '@/lib/db/migrate'
import {
  assertJpOhlcvCoverageSchema,
  assertNoPendingJpOhlcvRepair,
  loadOpenJpOhlcvCoverageIssueCounts,
  recordJpOhlcvCoverageFailure,
  recordJpOhlcvCoverageSuccess,
} from '@/lib/jp-ohlcv-coverage'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-jp-coverage-'))
const database = path.join(directory, 'coverage.sqlite')
const client = createClient({ url: `file:${database}` })

async function openIssues(): Promise<Array<{ date: string; ticker: string; kind: string }>> {
  const result = await client.execute(`
    SELECT date,ticker,kind FROM jquants_daily_coverage_issues
    WHERE status='open' ORDER BY date,ticker,kind
  `)
  return result.rows.map((row) => ({
    date: String(row.date), ticker: String(row.ticker), kind: String(row.kind),
  }))
}

async function main(): Promise<void> {
  try {
    await ensureSchema(client)
    await assertJpOhlcvCoverageSchema(client)
    await client.execute({
      sql: `INSERT INTO batch_runs(job_type,started_at,status,error_summary)
            VALUES('ohlcv_fetch:jquants',unixepoch(),'partial',?)`,
      args: [JSON.stringify({ approvalSha256: 'a'.repeat(64), phase: 'derived_pending' })],
    })
    await assert.rejects(
      () => assertNoPendingJpOhlcvRepair(client),
      /derived_pending/,
      'normal ingestion must not overtake an incomplete repair derivation',
    )
    await client.execute(`UPDATE batch_runs SET status='success'`)
    await assertNoPendingJpOhlcvRepair(client)
    await recordJpOhlcvCoverageFailure(client, {
      date: '2026-07-17', detail: 'date-bulk ingestion started; completion evidence pending',
    })
    await recordJpOhlcvCoverageSuccess(client, {
      date: '2026-10-30', expectedRows: 4_193,
      missingTickers: [], protectedConflictTickers: [], satisfiedTickers: [],
    })
    assert.deepEqual(await openIssues(), [
      { date: '2026-07-17', ticker: '*', kind: 'FETCH_FAILED' },
    ], 'a later successful day must not hide an older failed session')

    await recordJpOhlcvCoverageSuccess(client, {
      date: '2026-07-17', expectedRows: 4_218,
      missingTickers: ['7003'], protectedConflictTickers: ['1447', '2164'],
      satisfiedTickers: ['1306'],
    })
    assert.deepEqual(await loadOpenJpOhlcvCoverageIssueCounts(client), {
      fetchFailed: 0, missing: 1, protectedConflicts: 2, unexpectedProtectedConflicts: 0, newIssues: 1,
    })

    await recordJpOhlcvCoverageFailure(client, {
      date: '2026-07-17', detail: 'retry started; completion evidence pending',
    })
    assert.deepEqual(await loadOpenJpOhlcvCoverageIssueCounts(client), {
      fetchFailed: 1, missing: 1, protectedConflicts: 2, unexpectedProtectedConflicts: 0, newIssues: 2,
    }, 'a retry attempt must not hide unresolved rows or protected conflicts')

    await recordJpOhlcvCoverageSuccess(client, {
      date: '2026-07-17', expectedRows: 4_218,
      missingTickers: [], protectedConflictTickers: ['1447', '2164'],
      satisfiedTickers: [],
    })
    assert.deepEqual(await loadOpenJpOhlcvCoverageIssueCounts(client), {
      fetchFailed: 0, missing: 1, protectedConflicts: 2, unexpectedProtectedConflicts: 0, newIssues: 1,
    }, 'a missing row absent from the provider envelope must remain unresolved')

    await recordJpOhlcvCoverageSuccess(client, {
      date: '2026-07-17', expectedRows: 4_218,
      missingTickers: [], protectedConflictTickers: ['1447', '2164'],
      satisfiedTickers: ['7003'],
    })
    assert.deepEqual(await loadOpenJpOhlcvCoverageIssueCounts(client), {
      fetchFailed: 0, missing: 0, protectedConflicts: 2, unexpectedProtectedConflicts: 0, newIssues: 0,
    })
    // A new missing row or a conflict outside the approved 1447/2164 keys must
    // surface as a new issue instead of disappearing inside the known two.
    await recordJpOhlcvCoverageSuccess(client, {
      date: '2026-11-05', expectedRows: 4_200,
      missingTickers: ['9999'], protectedConflictTickers: ['1447'], satisfiedTickers: [],
    })
    assert.deepEqual(await loadOpenJpOhlcvCoverageIssueCounts(client), {
      fetchFailed: 0, missing: 1, protectedConflicts: 2, unexpectedProtectedConflicts: 1, newIssues: 2,
    })
    const protectedRows = await client.execute({
      sql: `SELECT ticker,status FROM jquants_daily_coverage_issues
            WHERE date='2026-07-17' AND kind='PROTECTED_CONFLICT' ORDER BY ticker`,
      args: [],
    })
    assert.deepEqual(protectedRows.rows.map((row) => `${row.ticker}:${row.status}`), ['1447:open', '2164:open'])
    const coverage = await client.execute({
      sql: 'SELECT expected_rows FROM jquants_daily_coverage WHERE date=?',
      args: ['2026-07-17'],
    })
    assert.equal(Number(coverage.rows[0]?.expected_rows), 4_218)
    await client.execute('DROP TABLE jquants_daily_coverage_issues')
    await assert.rejects(
      () => assertJpOhlcvCoverageSchema(client),
      /jquants_daily_coverage_issues/,
      'an incomplete Production bootstrap must fail before ingestion starts',
    )
    console.log('JP OHLCV persistent coverage issue tests: PASS')
  } finally {
    client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
