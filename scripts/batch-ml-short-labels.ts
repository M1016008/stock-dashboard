// scripts/batch-ml-short-labels.ts
//
// forward_extrema から、短期〜月足目線のMLラベルとRL用 state/action/reward を作る。

import { execAll, execRun } from '@/lib/db/client'
import { ML_PHYSICS_DEFAULT_HORIZON_LIST, ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

const HORIZONS = (process.env.ML_SHORT_HORIZONS ?? ML_PHYSICS_DEFAULT_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_SHORT_LABEL_START_DATE?.trim() || null
const END_DATE = process.env.ML_SHORT_LABEL_END_DATE?.trim() || null
const RECENT_DAYS = Number(process.env.ML_SHORT_LABEL_RECENT_DAYS ?? 0)
const WRITE_RL_STATES = process.env.ML_SHORT_WRITE_RL_STATES !== '0'
const DATE_CHUNK_DAYS = Number(process.env.ML_SHORT_LABEL_DATE_CHUNK_DAYS ?? 0)

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
    DELETE FROM ml_short_labels
    WHERE horizon_days IN (${horizonPlaceholders()})
      ${startDate ? 'AND date >= ?' : ''}
      ${endDate ? 'AND date <= ?' : ''}
    `,
    [...HORIZONS, ...(startDate ? [startDate] : []), ...(endDate ? [endDate] : [])],
  )

  await execRun(
    `
    INSERT INTO ml_short_labels
      (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct,
       up_label, down_label, wait_label, reward_long, reward_short, reward_wait,
       label_json, computed_at)
    WITH base AS (
      SELECT
        fe.*,
        CASE
          WHEN fe.horizon_days <= 5 THEN 4.0
          WHEN fe.horizon_days <= 10 THEN 6.0
          WHEN fe.horizon_days <= 15 THEN 8.0
          WHEN fe.horizon_days <= 20 THEN 10.0
          WHEN fe.horizon_days <= 40 THEN 15.0
          WHEN fe.horizon_days <= 60 THEN 20.0
          WHEN fe.horizon_days <= 90 THEN 25.0
          ELSE 30.0
        END AS up_target,
        CASE
          WHEN fe.horizon_days <= 5 THEN -3.0
          WHEN fe.horizon_days <= 10 THEN -5.0
          WHEN fe.horizon_days <= 15 THEN -7.0
          WHEN fe.horizon_days <= 20 THEN -8.0
          WHEN fe.horizon_days <= 40 THEN -12.0
          WHEN fe.horizon_days <= 60 THEN -15.0
          WHEN fe.horizon_days <= 90 THEN -20.0
          ELSE -25.0
        END AS down_target
      FROM forward_extrema fe
      WHERE ${where.join(' AND ')}
    )
    SELECT
      ticker,
      date,
      horizon_days,
      return_pct,
      max_return_pct,
      min_return_pct,
      CASE WHEN COALESCE(max_return_pct, -999999) >= up_target AND COALESCE(min_return_pct, 999999) > down_target THEN 1 ELSE 0 END AS up_label,
      CASE WHEN COALESCE(min_return_pct, 999999) <= down_target AND COALESCE(max_return_pct, -999999) < up_target THEN 1 ELSE 0 END AS down_label,
      CASE WHEN COALESCE(max_return_pct, -999999) < up_target AND COALESCE(min_return_pct, 999999) > down_target THEN 1 ELSE 0 END AS wait_label,
      ROUND(COALESCE(max_return_pct, return_pct, 0) + MIN(0, COALESCE(min_return_pct, 0)) * 0.8, 4) AS reward_long,
      ROUND(ABS(MIN(0, COALESCE(min_return_pct, 0))) - MAX(0, COALESCE(max_return_pct, 0)) * 0.8, 4) AS reward_short,
      ROUND(-ABS(COALESCE(return_pct, 0)) - MAX(0, COALESCE(max_return_pct, 0) - up_target) * 0.2 - ABS(MIN(0, COALESCE(min_return_pct, 0) - down_target)) * 0.2, 4) AS reward_wait,
      json_object(
        'source', 'forward_extrema',
        'upTarget', up_target,
        'downTarget', down_target,
        'daysToMax', days_to_max,
        'daysToMin', days_to_min,
        'maxReturnDate', max_return_date,
        'minReturnDate', min_return_date,
        'stopLoss3Hit', CASE WHEN COALESCE(min_return_pct, 999999) <= -3 THEN 1 ELSE 0 END,
        'stopLoss5Hit', CASE WHEN COALESCE(min_return_pct, 999999) <= -5 THEN 1 ELSE 0 END,
        'drawdownBeforeTarget',
          CASE
            WHEN COALESCE(max_return_pct, -999999) >= up_target
             AND COALESCE(days_to_min, 999999) < COALESCE(days_to_max, 999999)
            THEN min_return_pct
            ELSE NULL
          END,
        'failedPullback',
          CASE
            WHEN COALESCE(max_return_pct, -999999) < up_target
             AND COALESCE(min_return_pct, 999999) <= down_target
            THEN 1 ELSE 0
          END,
        'overheatedReversal',
          CASE
            WHEN COALESCE(max_return_pct, -999999) >= up_target
             AND COALESCE(min_return_pct, 999999) <= down_target
            THEN 1 ELSE 0
          END
      ) AS label_json,
      unixepoch()
    FROM base
    `,
    args,
  )
}

async function labelDateBounds(): Promise<{ minDate: string; maxDate: string } | null> {
  const where = [`horizon_days IN (${horizonPlaceholders()})`]
  const args: Array<string | number> = [...HORIZONS]
  if (START_DATE) {
    where.push('date >= ?')
    args.push(START_DATE)
  }
  if (END_DATE) {
    where.push('date <= ?')
    args.push(END_DATE)
  }
  const rows = await execAll<{ minDate: string | null; maxDate: string | null }>(
    `SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM forward_extrema WHERE ${where.join(' AND ')}`,
    args,
  )
  const row = rows[0]
  if (!row?.minDate || !row.maxDate) return null
  return { minDate: row.minDate, maxDate: row.maxDate }
}

async function recentStartDate(): Promise<string | null> {
  if (!Number.isFinite(RECENT_DAYS) || RECENT_DAYS <= 0) return null
  const rows = await execAll<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM forward_extrema
      WHERE horizon_days IN (${horizonPlaceholders()})
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [...HORIZONS, RECENT_DAYS],
  )
  return rows[0]?.date ?? null
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml short labels: no horizons')
    return
  }

  if (DATE_CHUNK_DAYS > 0) {
    if (WRITE_RL_STATES) {
      throw new Error('ML_SHORT_LABEL_DATE_CHUNK_DAYS currently requires ML_SHORT_WRITE_RL_STATES=0')
    }
    const bounds = await labelDateBounds()
    if (!bounds) {
      console.log('ml short labels: no forward_extrema rows')
      return
    }
    let cursor = bounds.minDate
    let chunks = 0
    while (cursor <= bounds.maxDate) {
      const chunkEnd = minDate(addDays(cursor, DATE_CHUNK_DAYS - 1), bounds.maxDate)
      await syncLabelsForRange(cursor, chunkEnd)
      chunks += 1
      console.log(`ml short labels chunk ${chunks}: horizons=${HORIZONS.join('/')}, start=${cursor}, end=${chunkEnd}`)
      cursor = addDays(chunkEnd, 1)
    }
    console.log(
      `ml short labels synced: horizons=${HORIZONS.join('/')}, start=${bounds.minDate}, end=${bounds.maxDate}, chunks=${chunks}, rl_states=off`,
    )
    return
  }

  const effectiveStartDate = START_DATE ?? await recentStartDate()
  const effectiveEndDate = END_DATE

  await syncLabelsForRange(effectiveStartDate, effectiveEndDate)

  if (WRITE_RL_STATES) {
    const actions = [
      { action: 'long_entry', rewardColumn: 'reward_long' },
      { action: 'short_entry', rewardColumn: 'reward_short' },
      { action: 'wait', rewardColumn: 'reward_wait' },
    ]

    for (const { action, rewardColumn } of actions) {
      await execRun(
        `
        INSERT OR REPLACE INTO rl_training_states_v2
          (ticker, date, horizon_days, action, state_json, reward, next_state_json, computed_at)
        SELECT
          f.ticker,
          f.date,
          l.horizon_days,
          ?,
          json_object(
            'featureSet', f.feature_set,
            'featureVersion', f.version,
            'featureDate', f.date,
            'featureRow', f.ticker || ':' || f.date || ':' || f.feature_set
          ),
          l.${rewardColumn},
          NULL,
          unixepoch()
        FROM ml_feature_vectors_v2 f
        INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
        WHERE f.feature_set = ? AND l.horizon_days IN (${horizonPlaceholders()})
          ${effectiveStartDate ? 'AND l.date >= ?' : ''}
          ${effectiveEndDate ? 'AND l.date <= ?' : ''}
        `,
        [
          action,
          ML_PHYSICS_FEATURE_SET,
          ...HORIZONS,
          ...(effectiveStartDate ? [effectiveStartDate] : []),
          ...(effectiveEndDate ? [effectiveEndDate] : []),
        ],
      )
    }
  }

  console.log(
    `ml short labels synced: horizons=${HORIZONS.join('/')}, start=${effectiveStartDate ?? '-'}, end=${effectiveEndDate ?? '-'}, recent_days=${RECENT_DAYS || '-'}, rl_states=${WRITE_RL_STATES ? 'on' : 'off'}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
