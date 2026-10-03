import { execAll, execGet } from '@/lib/db/client'

const horizons = [...new Set(
  String(process.env.FORWARD_EXTREMA_HORIZONS ?? '5,10,20,40,60,90,200')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
)].sort((a, b) => a - b)

if (horizons.length === 0) throw new Error('FORWARD_EXTREMA_HORIZONS is empty')

type CountRow = { horizon: number; rows: number }
type CoverageRow = { horizon: number; dates: number }

async function main(): Promise<void> {
  const values = horizons.map(() => '(?)').join(', ')
  const expected = await execAll<CountRow>(
    `WITH horizons(horizon) AS (VALUES ${values}),
       prices AS (
         SELECT ticker, COUNT(*) AS rows
         FROM ohlcv_daily
         GROUP BY ticker
       ),
       invalid AS (
         SELECT horizons.horizon, COUNT(*) AS rows
         FROM horizons
         INNER JOIN ohlcv_daily AS base
           ON base.close IS NULL OR base.close <= 0
         WHERE (
           SELECT COUNT(*)
           FROM ohlcv_daily AS future
           WHERE future.ticker = base.ticker AND future.date > base.date
         ) >= horizons.horizon
         GROUP BY horizons.horizon
       )
     SELECT horizons.horizon,
       SUM(CASE WHEN prices.rows > horizons.horizon THEN prices.rows - horizons.horizon ELSE 0 END)
         - COALESCE(invalid.rows, 0) AS rows
     FROM horizons
     CROSS JOIN prices
     LEFT JOIN invalid ON invalid.horizon = horizons.horizon
     GROUP BY horizons.horizon, invalid.rows
     ORDER BY horizons.horizon`,
    horizons,
  )
  const placeholders = horizons.map(() => '?').join(', ')
  const actual = await execAll<CountRow>(
    `SELECT horizon_days AS horizon, COUNT(*) AS rows
     FROM forward_extrema INDEXED BY fext_horizon_date_idx
     WHERE horizon_days IN (${placeholders})
     GROUP BY horizon_days ORDER BY horizon_days`,
    horizons,
  )
  const coverage = await execAll<CoverageRow>(
    `SELECT horizon_days AS horizon, COUNT(*) AS dates
     FROM forward_extrema_date_coverage
     WHERE horizon_days IN (${placeholders})
     GROUP BY horizon_days ORDER BY horizon_days`,
    horizons,
  )
  const source = await execGet<{ dates: number }>('SELECT COUNT(DISTINCT date) AS dates FROM ohlcv_daily')
  const expectedByHorizon = new Map(expected.map((row) => [Number(row.horizon), Number(row.rows)]))
  const actualByHorizon = new Map(actual.map((row) => [Number(row.horizon), Number(row.rows)]))
  const coverageByHorizon = new Map(coverage.map((row) => [Number(row.horizon), Number(row.dates)]))
  const sourceDates = Number(source?.dates ?? 0)
  const checks = horizons.map((horizon) => {
    const expectedRows = expectedByHorizon.get(horizon) ?? 0
    const actualRows = actualByHorizon.get(horizon) ?? 0
    const expectedDates = Math.max(0, sourceDates - horizon)
    const actualDates = coverageByHorizon.get(horizon) ?? 0
    return {
      horizon,
      expectedRows,
      actualRows,
      expectedDates,
      actualDates,
      passed: expectedRows === actualRows && expectedDates === actualDates,
    }
  })
  console.log(JSON.stringify({ sourceDates, checks }, null, 2))
  if (checks.some((check) => !check.passed)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
