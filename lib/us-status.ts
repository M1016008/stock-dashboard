import { execGet } from '@/lib/db/client'

type UsUniverseSummary = {
  total: number
  active: number
}

type UsDateRange = {
  firstDate: string | null
  latestDate: string | null
}

type UsSnapshotDate = {
  latestDate: string | null
}

type UsSnapshotCount = {
  tickers: number
}

export type UsLatestRun = {
  job_type: string
  status: string
  started_at: number
  finished_at: number | null
  total_tickers: number
  succeeded: number
  failed: number
  rows_inserted: number
}

export type UsStatusSummary = {
  market: 'US'
  universe: {
    total: number
    active: number
  }
  ohlcv: {
    firstDate: string | null
    latestDate: string | null
    tickers: number
    rows: number | null
    rowsApproximate: boolean
  }
  snapshots: {
    latestDate: string | null
    tickers: number
  }
  latestRun: UsLatestRun | null
}

export async function getUsStatusSummary(): Promise<UsStatusSummary> {
  const [universe, firstDate, latestDate, snapshotLatestDate, latestRun, ohlcvRows] = await Promise.all([
    execGet<UsUniverseSummary>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM market_universe WHERE market = 'US'`,
    ),
    execGet<{ date: string | null }>(
      `SELECT date FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx WHERE market = 'US' ORDER BY date ASC LIMIT 1`,
    ),
    execGet<{ date: string | null }>(
      `SELECT date FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx WHERE market = 'US' ORDER BY date DESC LIMIT 1`,
    ),
    execGet<UsSnapshotDate>(
      `SELECT date AS latestDate
       FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
       WHERE market = 'US'
       ORDER BY date DESC
       LIMIT 1`,
    ),
    execGet<UsLatestRun>(
      `SELECT job_type, status, started_at, finished_at, total_tickers, succeeded, failed, rows_inserted
       FROM market_data_runs
       WHERE market = 'US'
         AND job_type = 'tiingo_ohlcv'
       ORDER BY started_at DESC
       LIMIT 1`,
    ),
    execGet<{ rows: number | null }>(
      `SELECT SUM(rows_inserted) AS rows FROM market_data_runs WHERE market = 'US' AND job_type = 'tiingo_ohlcv'`,
    ),
  ])

  const snapshotLatest = snapshotLatestDate?.latestDate ?? null
  const snapshotCount = snapshotLatest
    ? await execGet<UsSnapshotCount>(
        `SELECT COUNT(*) AS tickers
         FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
         WHERE market = 'US'
           AND date = ?`,
        [snapshotLatest],
      )
    : null

  return {
    market: 'US',
    universe: {
      total: Number(universe?.total ?? 0),
      active: Number(universe?.active ?? 0),
    },
    ohlcv: {
      firstDate: firstDate?.date ?? null,
      latestDate: latestDate?.date ?? null,
      tickers: Number(latestRun?.succeeded ?? 0),
      rows: ohlcvRows?.rows == null ? null : Number(ohlcvRows.rows),
      rowsApproximate: true,
    },
    snapshots: {
      latestDate: snapshotLatest,
      tickers: Number(snapshotCount?.tickers ?? 0),
    },
    latestRun: latestRun ?? null,
  }
}
