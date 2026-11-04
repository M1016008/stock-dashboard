import type { Client, Transaction } from '@libsql/client'

export type JpOhlcvCoverageIssueKind = 'FETCH_FAILED' | 'MISSING' | 'PROTECTED_CONFLICT'

export type JpOhlcvCoverageIssue = {
  date: string
  ticker: string
  kind: JpOhlcvCoverageIssueKind
  detail: string | null
}

export async function assertJpOhlcvCoverageSchema(client: Client): Promise<void> {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('jquants_daily_coverage', 'jquants_daily_coverage_issues')`,
    args: [],
  })
  const present = new Set(result.rows.map((row) => String(row.name)))
  const missing = ['jquants_daily_coverage', 'jquants_daily_coverage_issues']
    .filter((table) => !present.has(table))
  if (missing.length > 0) {
    throw new Error(`JP OHLCV coverage schema is unavailable: ${missing.join(', ')}`)
  }
}

export async function assertNoPendingJpOhlcvRepair(client: Client): Promise<void> {
  const result = await client.execute({
    sql: `SELECT id, error_summary
          FROM batch_runs
          WHERE job_type = 'ohlcv_fetch:jquants'
            AND status = 'partial'
            AND json_valid(error_summary)
            AND json_extract(error_summary, '$.phase') = 'derived_pending'
          ORDER BY id DESC
          LIMIT 1`,
    args: [],
  })
  const pending = result.rows[0]
  if (pending) {
    throw new Error(`JP OHLCV repair ${String(pending.id)} is derived_pending; normal ingestion is blocked`)
  }
}

async function reconcileIssues(
  transaction: Transaction,
  date: string,
  issues: readonly JpOhlcvCoverageIssue[],
  satisfiedTickers: ReadonlySet<string>,
): Promise<void> {
  const active = new Set(issues.map((issue) => `${issue.ticker}:${issue.kind}`))
  const current = await transaction.execute({
    sql: `SELECT ticker, kind FROM jquants_daily_coverage_issues
          WHERE date = ? AND status = 'open'`,
    args: [date],
  })
  for (const row of current.rows) {
    const key = `${String(row.ticker)}:${String(row.kind)}`
    if (active.has(key)) continue
    const kind = String(row.kind) as JpOhlcvCoverageIssueKind
    const ticker = String(row.ticker)
    const resolved = kind === 'FETCH_FAILED'
      || (kind === 'MISSING' && satisfiedTickers.has(ticker))
    if (!resolved) continue
    await transaction.execute({
      sql: `UPDATE jquants_daily_coverage_issues
            SET status = 'resolved', resolved_at = unixepoch()
            WHERE date = ? AND ticker = ? AND kind = ? AND status = 'open'`,
      args: [date, String(row.ticker), String(row.kind)],
    })
  }
  for (const issue of issues) {
    await transaction.execute({
      sql: `INSERT INTO jquants_daily_coverage_issues(
              date, ticker, kind, status, detail, observed_at, resolved_at
            ) VALUES(?, ?, ?, 'open', ?, unixepoch(), NULL)
            ON CONFLICT(date, ticker, kind) DO UPDATE SET
              status = 'open', detail = excluded.detail,
              observed_at = unixepoch(), resolved_at = NULL`,
      args: [issue.date, issue.ticker, issue.kind, issue.detail],
    })
  }
}

export async function recordJpOhlcvCoverageSuccess(client: Client, input: {
  date: string
  expectedRows: number
  missingTickers: readonly string[]
  protectedConflictTickers: readonly string[]
  satisfiedTickers: readonly string[]
}): Promise<void> {
  const transaction = await client.transaction('write')
  try {
    await transaction.execute({
      sql: `INSERT INTO jquants_daily_coverage(date, expected_rows, imported_at)
            VALUES(?, ?, unixepoch())
            ON CONFLICT(date) DO UPDATE SET
              expected_rows = excluded.expected_rows,
              imported_at = unixepoch()`,
      args: [input.date, input.expectedRows],
    })
    await reconcileIssues(transaction, input.date, [
      ...input.missingTickers.map((ticker) => ({
        date: input.date, ticker, kind: 'MISSING' as const, detail: null,
      })),
      ...input.protectedConflictTickers.map((ticker) => ({
        date: input.date,
        ticker,
        kind: 'PROTECTED_CONFLICT' as const,
        detail: 'existing row preserved; separate adjudication required',
      })),
    ], new Set(input.satisfiedTickers))
    await transaction.commit()
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the original error */ }
    throw error
  }
}

export async function recordJpOhlcvCoverageFailure(client: Client, input: {
  date: string
  detail: string
}): Promise<void> {
  const transaction = await client.transaction('write')
  try {
    // Starting or failing a retry must not resolve previously observed missing
    // rows or protected conflicts for the same historical session.
    await transaction.execute({
      sql: `INSERT INTO jquants_daily_coverage_issues(
              date, ticker, kind, status, detail, observed_at, resolved_at
            ) VALUES(?, '*', 'FETCH_FAILED', 'open', ?, unixepoch(), NULL)
            ON CONFLICT(date, ticker, kind) DO UPDATE SET
              status = 'open', detail = excluded.detail,
              observed_at = unixepoch(), resolved_at = NULL`,
      args: [input.date, input.detail.slice(0, 2_000)],
    })
    await transaction.commit()
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the original error */ }
    throw error
  }
}

export async function loadOpenJpOhlcvCoverageIssueCounts(client: Client): Promise<{
  fetchFailed: number
  missing: number
  protectedConflicts: number
}> {
  const result = await client.execute(`
    SELECT kind, COUNT(*) AS count
    FROM jquants_daily_coverage_issues
    WHERE status = 'open'
    GROUP BY kind
  `)
  const counts = new Map(result.rows.map((row) => [String(row.kind), Number(row.count)]))
  return {
    fetchFailed: counts.get('FETCH_FAILED') ?? 0,
    missing: counts.get('MISSING') ?? 0,
    protectedConflicts: counts.get('PROTECTED_CONFLICT') ?? 0,
  }
}
