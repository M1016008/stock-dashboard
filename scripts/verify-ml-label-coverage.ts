import { execAll } from '@/lib/db/client'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'

type CountRow = { horizon: number; rows: number }

const horizons = [...new Set(
  String(process.env.ML_HORIZONS ?? ML_PRIMARY_HORIZON_LIST)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
)].sort((a, b) => a - b)

async function main(): Promise<void> {
  if (horizons.length === 0) throw new Error('ML_HORIZONS is empty')
  const placeholders = horizons.map(() => '?').join(', ')
  // These are both full-table aggregation checks. Run them sequentially so a
  // production verification does not double SQLite's peak scan memory.
  const extremaRows = await execAll<CountRow>(
    `SELECT horizon_days AS horizon, COUNT(*) AS rows
     FROM forward_extrema INDEXED BY fext_horizon_date_idx
     WHERE horizon_days IN (${placeholders})
     GROUP BY horizon_days ORDER BY horizon_days`,
    horizons,
  )
  const labelRows = await execAll<CountRow>(
    `SELECT horizon_days AS horizon, COUNT(*) AS rows
     FROM ml_training_labels
     WHERE horizon_days IN (${placeholders})
     GROUP BY horizon_days ORDER BY horizon_days`,
    horizons,
  )
  const extremaByHorizon = new Map(extremaRows.map((row) => [Number(row.horizon), Number(row.rows)]))
  const labelsByHorizon = new Map(labelRows.map((row) => [Number(row.horizon), Number(row.rows)]))
  const checks = horizons.map((horizon) => {
    const extrema = extremaByHorizon.get(horizon) ?? 0
    const labels = labelsByHorizon.get(horizon) ?? 0
    return { horizon, extrema, labels, passed: extrema === labels }
  })
  console.log(JSON.stringify({ checks }, null, 2))
  if (checks.some((check) => !check.passed)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
