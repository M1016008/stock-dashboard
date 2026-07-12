// scripts/batch-ml-labels.ts
//
// forward_extrema から、確定済みの教師ラベルだけを ml_training_labels に同期する。

import { execAll, execRun } from '@/lib/db/client'

const HORIZONS = (process.env.ML_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_LABEL_START_DATE?.trim() || null
const END_DATE = process.env.ML_LABEL_END_DATE?.trim() || null
const RECENT_DAYS = Number(process.env.ML_LABEL_RECENT_DAYS ?? 0)
const DATE_CHUNK_DAYS = Number(process.env.ML_LABEL_DATE_CHUNK_DAYS ?? 30)

function horizonPlaceholders(): string {
  return HORIZONS.map(() => '?').join(', ')
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function laterDate(a: string | null, b: string | null): string | null {
  if (a && b) return maxDate(a, b)
  return a ?? b
}

async function recentStartDate(): Promise<string | null> {
  if (!Number.isFinite(RECENT_DAYS) || RECENT_DAYS <= 0) return null
  const rows = await execAll<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM forward_extrema INDEXED BY fext_date_horizon_idx
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [RECENT_DAYS],
  )
  return rows[0]?.date ?? null
}

async function labelDateBounds(startDate: string | null, endDate: string | null): Promise<{ minDate: string; maxDate: string } | null> {
  const where: string[] = []
  const args: Array<string | number> = []
  if (startDate) {
    where.push('date >= ?')
    args.push(startDate)
  }
  if (endDate) {
    where.push('date <= ?')
    args.push(endDate)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const minRows = await execAll<{ date: string | null }>(
    `SELECT date FROM forward_extrema INDEXED BY fext_date_horizon_idx ${whereSql} ORDER BY date ASC LIMIT 1`,
    args,
  )
  const maxRows = await execAll<{ date: string | null }>(
    `SELECT date FROM forward_extrema INDEXED BY fext_date_horizon_idx ${whereSql} ORDER BY date DESC LIMIT 1`,
    args,
  )
  const minDateValue = minRows[0]?.date ?? null
  const maxDateValue = maxRows[0]?.date ?? null
  if (!minDateValue || !maxDateValue) return null
  return { minDate: minDateValue, maxDate: maxDateValue }
}

async function syncLabelsForRange(startDate: string | null, endDate: string | null): Promise<void> {
  const where = [`fe.horizon_days IN (${horizonPlaceholders()})`]
  const args: Array<string | number> = [...HORIZONS]
  if (startDate) {
    where.push('fe.date >= ?')
    args.push(startDate)
  }
  if (endDate) {
    where.push('fe.date <= ?')
    args.push(endDate)
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
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml labels: no horizons')
    return
  }

  const recentStart = await recentStartDate()
  const effectiveStartDate = laterDate(START_DATE, recentStart)
  const effectiveEndDate = END_DATE

  console.log(
    `ml labels start: horizons=${HORIZONS.join('/')}, start=${effectiveStartDate ?? '-'}, requested_start=${START_DATE ?? '-'}, recent_start=${recentStart ?? '-'}, end=${effectiveEndDate ?? '-'}, recent_days=${RECENT_DAYS || '-'}, chunk_days=${DATE_CHUNK_DAYS || '-'}`,
  )

  let chunks = 0
  if (DATE_CHUNK_DAYS > 0) {
    const bounds = await labelDateBounds(effectiveStartDate, effectiveEndDate)
    if (!bounds) {
      console.log('ml labels: no forward_extrema rows')
      return
    }
    let cursor = bounds.minDate
    while (cursor <= bounds.maxDate) {
      const chunkEnd = minDate(addDays(cursor, DATE_CHUNK_DAYS - 1), bounds.maxDate)
      console.log(`ml labels chunk ${chunks + 1} start: horizons=${HORIZONS.join('/')}, start=${cursor}, end=${chunkEnd}`)
      await syncLabelsForRange(cursor, chunkEnd)
      chunks += 1
      console.log(`ml labels chunk ${chunks} done: horizons=${HORIZONS.join('/')}, start=${cursor}, end=${chunkEnd}`)
      cursor = addDays(chunkEnd, 1)
    }
  } else {
    await syncLabelsForRange(effectiveStartDate, effectiveEndDate)
    chunks = 1
  }

  console.log(
    `ml labels synced: horizons=${HORIZONS.join('/')}, start=${effectiveStartDate ?? '-'}, end=${effectiveEndDate ?? '-'}, recent_days=${RECENT_DAYS || '-'}, chunks=${chunks || '-'}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
