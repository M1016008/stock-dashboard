// scripts/check-sector-etf-holdings-health.ts
//
// Summarize latest sector ETF holding fetch outcomes and fail the scheduler when
// failed/skipped counts exceed operational thresholds.

import { execAll, execGet } from '@/lib/db/client'

type StatusCount = {
  status: string
  count: number
}

type FailedRun = {
  etf_ticker: string
  status: string
  started_at: number | null
  finished_at: number | null
  holdings_count: number | null
  error_summary: string | null
}

async function main() {
  const maxFailed = Number(process.env.SECTOR_ETF_MAX_FAILED ?? 0)
  const maxSkipped = Number(process.env.SECTOR_ETF_MAX_SKIPPED ?? 99)
  const windowHours = Number(process.env.SECTOR_ETF_HEALTH_WINDOW_HOURS ?? 6)
  const latestStartedAt = (await execGet<{ started_at: number | null }>(
    `SELECT MAX(started_at) AS started_at FROM sector_etf_holding_runs`,
  ))?.started_at ?? null

  if (!latestStartedAt) {
    console.log(JSON.stringify({ status: 'missing', message: 'No sector ETF holding runs found' }, null, 2))
    process.exitCode = 1
    return
  }

  const windowStart = latestStartedAt - Math.max(1, windowHours) * 3600
  const counts = await execAll<StatusCount>(
    `
    SELECT status, COUNT(*) AS count
    FROM sector_etf_holding_runs
    WHERE started_at >= ?
      AND started_at <= ?
    GROUP BY status
    ORDER BY status
    `,
    [windowStart, latestStartedAt],
  )
  const failed = counts.find((row) => row.status === 'failed')?.count ?? 0
  const skipped = counts.find((row) => row.status === 'skipped')?.count ?? 0
  const problemRuns = await execAll<FailedRun>(
    `
    SELECT etf_ticker, status, started_at, finished_at, holdings_count, error_summary
    FROM sector_etf_holding_runs
    WHERE started_at >= ?
      AND started_at <= ?
      AND status IN ('failed', 'skipped')
    ORDER BY status, etf_ticker
    LIMIT 40
    `,
    [windowStart, latestStartedAt],
  )

  console.log(JSON.stringify({
    latestStartedAt,
    windowHours,
    windowStart,
    counts,
    thresholds: { maxFailed, maxSkipped },
    problemRuns,
  }, null, 2))

  if (failed > maxFailed || skipped > maxSkipped) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[check-sector-etf-holdings-health] failed:', error)
  process.exitCode = 1
})
