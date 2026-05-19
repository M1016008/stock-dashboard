import { execAll, execGet } from '@/lib/db/client'

const UPDATE_JOB_TYPES = [
  'update_latest',
  'ohlcv_fetch:jquants',
  'snapshot_compute',
  'indices',
  'earnings_calendar',
]
const RUNNING_JOB_TTL_SECONDS = 6 * 60 * 60
const MIN_COVERAGE_RATIO = 1

type MaxDateRow = {
  maxDate: string | null
}

export type RunningJob = {
  id: number
  jobType: string
  startedAt: string | number | Date
}

export type DataFreshness = {
  expectedTradingDate: string
  latestOhlcvDate: string | null
  latestSnapshotDate: string | null
  latestIndexDate: string | null
  latestEarningsDate: string | null
  activeTickerCount: number
  staleOhlcvTickerCount: number
  staleSnapshotTickerCount: number
  latestOhlcvCount: number
  baselineOhlcvCount: number
  latestSnapshotCount: number
  baselineSnapshotCount: number
  needsOhlcvUpdate: boolean
  needsSnapshotUpdate: boolean
  needsUpdate: boolean
  running: boolean
  runningJobs: RunningJob[]
  checkedAt: string
}

function jstParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  }
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function previousWeekday(date: Date): Date {
  const d = new Date(date)
  do {
    d.setUTCDate(d.getUTCDate() - 1)
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d
}

export function expectedLatestTradingDate(now = new Date()): string {
  const parts = jstParts(now)
  const jstDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const weekday = jstDate.getUTCDay()

  if (weekday === 0) return formatDate(previousWeekday(jstDate))
  if (weekday === 6) return formatDate(previousWeekday(jstDate))
  if (parts.hour < 18) return formatDate(previousWeekday(jstDate))
  return formatDate(jstDate)
}

async function maxDate(tableName: string, columnName: string): Promise<string | null> {
  const row = await execGet<MaxDateRow>(`SELECT MAX(${columnName}) AS maxDate FROM ${tableName}`)
  return row?.maxDate ?? null
}

async function dateCoverage(tableName: string): Promise<{ latestCount: number; baselineCount: number }> {
  const rows = await execAll<{ date: string; count: number }>(`
    SELECT date, COUNT(*) AS count
    FROM ${tableName}
    GROUP BY date
    ORDER BY date DESC
    LIMIT 5
  `)
  const latestCount = Number(rows[0]?.count ?? 0)
  const baselineCount = Math.max(...rows.map(r => Number(r.count ?? 0)), latestCount)
  return { latestCount, baselineCount }
}

export async function getDataFreshness(now = new Date()): Promise<DataFreshness> {
  const expectedTradingDate = expectedLatestTradingDate(now)
  const [
    latestOhlcvDate,
    latestSnapshotDate,
    latestIndexDate,
    latestEarningsDate,
    ohlcvCoverage,
    snapshotCoverage,
    jquantsCoverage,
    tickerCoverage,
  ] = await Promise.all([
    maxDate('ohlcv_daily', 'date'),
    maxDate('daily_snapshots', 'date'),
    maxDate('indices_daily', 'date'),
    maxDate('earnings_calendar', 'announce_date'),
    dateCoverage('ohlcv_daily'),
    dateCoverage('daily_snapshots'),
    execGet<{ expectedRows: number }>(
      `SELECT expected_rows AS expectedRows FROM jquants_daily_coverage WHERE date = ?`,
      [expectedTradingDate],
    ),
    execGet<{
      activeTickerCount: number
      staleOhlcvTickerCount: number
      staleSnapshotTickerCount: number
    }>(
      `
        SELECT
          COUNT(*) AS activeTickerCount,
          SUM(CASE
            WHEN COALESCE((SELECT MAX(o.date) FROM ohlcv_daily o WHERE o.ticker = u.ticker), '') < ?
            THEN 1 ELSE 0
          END) AS staleOhlcvTickerCount,
          SUM(CASE
            WHEN COALESCE((SELECT MAX(s.date) FROM daily_snapshots s WHERE s.ticker = u.ticker), '') < ?
            THEN 1 ELSE 0
          END) AS staleSnapshotTickerCount
        FROM ticker_universe u
        WHERE u.active = 1
      `,
      [expectedTradingDate, expectedTradingDate],
    ),
  ])

  const placeholders = UPDATE_JOB_TYPES.map(() => '?').join(', ')
  const runningJobs = await execAll<RunningJob>(
    `
      SELECT id, job_type AS jobType, started_at AS startedAt
      FROM batch_runs
      WHERE status = 'running'
        AND job_type IN (${placeholders})
        AND started_at >= unixepoch() - ?
      ORDER BY id DESC
    `,
    [...UPDATE_JOB_TYPES, RUNNING_JOB_TTL_SECONDS],
  )

  const activeTickerCount = Number(tickerCoverage?.activeTickerCount ?? 0)
  const staleOhlcvTickerCount = Number(tickerCoverage?.staleOhlcvTickerCount ?? activeTickerCount)
  const staleSnapshotTickerCount = Number(tickerCoverage?.staleSnapshotTickerCount ?? activeTickerCount)
  const latestOhlcvCount = ohlcvCoverage.latestCount
  const baselineOhlcvCount = Number(jquantsCoverage?.expectedRows ?? ohlcvCoverage.baselineCount)
  const latestSnapshotCount = snapshotCoverage.latestCount
  const baselineSnapshotCount = Number(jquantsCoverage?.expectedRows ?? snapshotCoverage.baselineCount)
  const ohlcvCoverageFresh =
    baselineOhlcvCount === 0 || latestOhlcvCount >= Math.floor(baselineOhlcvCount * MIN_COVERAGE_RATIO)
  const snapshotCoverageFresh =
    baselineSnapshotCount === 0 || latestSnapshotCount >= Math.floor(baselineSnapshotCount * MIN_COVERAGE_RATIO)

  const needsOhlcvUpdate =
    !latestOhlcvDate
    || latestOhlcvDate < expectedTradingDate
    || !ohlcvCoverageFresh
  const needsSnapshotUpdate =
    !latestSnapshotDate
    || (!!latestOhlcvDate && latestSnapshotDate < latestOhlcvDate)
    || latestSnapshotDate < expectedTradingDate
    || !snapshotCoverageFresh

  return {
    expectedTradingDate,
    latestOhlcvDate,
    latestSnapshotDate,
    latestIndexDate,
    latestEarningsDate,
    activeTickerCount,
    staleOhlcvTickerCount,
    staleSnapshotTickerCount,
    latestOhlcvCount,
    baselineOhlcvCount,
    latestSnapshotCount,
    baselineSnapshotCount,
    needsOhlcvUpdate,
    needsSnapshotUpdate,
    needsUpdate: needsOhlcvUpdate || needsSnapshotUpdate,
    running: runningJobs.length > 0,
    runningJobs,
    checkedAt: now.toISOString(),
  }
}
