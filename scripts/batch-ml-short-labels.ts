// scripts/batch-ml-short-labels.ts
//
// forward_extrema から、5/10/15営業日の短期MLラベルとRL用 state/action/reward を作る。

import { execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

const HORIZONS = (process.env.ML_SHORT_HORIZONS ?? '5,10,15')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_SHORT_LABEL_START_DATE?.trim() || null
const END_DATE = process.env.ML_SHORT_LABEL_END_DATE?.trim() || null
const WRITE_RL_STATES = process.env.ML_SHORT_WRITE_RL_STATES !== '0'

function horizonPlaceholders(): string {
  return HORIZONS.map(() => '?').join(', ')
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml short labels: no horizons')
    return
  }

  const where = [`fe.horizon_days IN (${horizonPlaceholders()})`]
  const args: Array<string | number> = [...HORIZONS]
  if (START_DATE) {
    where.push('fe.date >= ?')
    args.push(START_DATE)
  }
  if (END_DATE) {
    where.push('fe.date <= ?')
    args.push(END_DATE)
  }

  await execRun(
    `
    INSERT OR REPLACE INTO ml_short_labels
      (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct,
       up_label, down_label, wait_label, reward_long, reward_short, reward_wait,
       label_json, computed_at)
    WITH base AS (
      SELECT
        fe.*,
        CASE
          WHEN fe.horizon_days <= 5 THEN 4.0
          WHEN fe.horizon_days <= 10 THEN 6.0
          ELSE 8.0
        END AS up_target,
        CASE
          WHEN fe.horizon_days <= 5 THEN -3.0
          WHEN fe.horizon_days <= 10 THEN -5.0
          ELSE -7.0
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
        'minReturnDate', min_return_date
      ) AS label_json,
      unixepoch()
    FROM base
    `,
    args,
  )

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
          ${START_DATE ? 'AND l.date >= ?' : ''}
          ${END_DATE ? 'AND l.date <= ?' : ''}
        `,
        [action, ML_PHYSICS_FEATURE_SET, ...HORIZONS, ...(START_DATE ? [START_DATE] : []), ...(END_DATE ? [END_DATE] : [])],
      )
    }
  }

  console.log(
    `ml short labels synced: horizons=${HORIZONS.join('/')}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}, rl_states=${WRITE_RL_STATES ? 'on' : 'off'}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
