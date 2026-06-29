// scripts/batch-ml-labels.ts
//
// forward_extrema から、確定済みの教師ラベルだけを ml_training_labels に同期する。

import { execRun } from '@/lib/db/client'

const HORIZONS = (process.env.ML_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_LABEL_START_DATE?.trim() || null
const END_DATE = process.env.ML_LABEL_END_DATE?.trim() || null
const RECENT_DAYS = Number(process.env.ML_LABEL_RECENT_DAYS ?? 0)

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml labels: no horizons')
    return
  }
  const where = [`fe.horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`]
  const args: Array<string | number> = [...HORIZONS]
  if (START_DATE) {
    where.push('fe.date >= ?')
    args.push(START_DATE)
  }
  if (!START_DATE && Number.isFinite(RECENT_DAYS) && RECENT_DAYS > 0) {
    where.push(`
      fe.date >= (
        SELECT MIN(date)
        FROM (
          SELECT DISTINCT date
          FROM forward_extrema
          WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})
          ORDER BY date DESC
          LIMIT ?
        )
      )
    `)
    args.push(...HORIZONS, RECENT_DAYS)
  }
  if (END_DATE) {
    where.push('fe.date <= ?')
    args.push(END_DATE)
  }
  await execRun(
    `
    INSERT OR REPLACE INTO ml_training_labels
      (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct,
       up_label, down_label, reward_score, label_json, computed_at)
    SELECT
      fe.ticker,
      fe.date,
      fe.horizon_days,
      fe.return_pct,
      fe.max_return_pct,
      fe.min_return_pct,
      CASE WHEN COALESCE(fe.max_return_pct, -999999) >= 10 THEN 1 ELSE 0 END AS up_label,
      CASE WHEN COALESCE(fe.min_return_pct, 999999) <= -5 THEN 1 ELSE 0 END AS down_label,
      ROUND(COALESCE(fe.max_return_pct, fe.return_pct, 0) + MIN(0, COALESCE(fe.min_return_pct, 0)) * 0.5, 4) AS reward_score,
      json_object(
        'daysToMax', fe.days_to_max,
        'daysToMin', fe.days_to_min,
        'hit10', fe.hit_10,
        'hit20', fe.hit_20,
        'hit40', fe.hit_40,
        'source', 'forward_extrema'
      ) AS label_json,
      unixepoch()
    FROM forward_extrema fe
    WHERE ${where.join(' AND ')}
    `,
    args,
  )
  console.log(`ml labels synced: horizons=${HORIZONS.join('/')}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}, recent_days=${RECENT_DAYS || '-'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
