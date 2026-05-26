// scripts/batch-ml-rl-policy.ts
//
// rl_training_states_v2 に保存した state/action/reward から、短期売買方針を
// オフラインで継続評価する。v1は安全な contextual-bandit 型の評価に留め、
// 未来情報を最新候補生成へ直接混ぜない。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'

type Action = 'long_entry' | 'short_entry' | 'wait'

type StateActionRow = {
  ticker: string
  date: string
  horizon_days: number
  action: Action
  reward: number | null
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  feature_json: string
}

type State = {
  ticker: string
  date: string
  horizonDays: number
  profile: PhysicsFeatureProfile
  returns: {
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
  }
  rewards: Partial<Record<Action, number>>
}

type PolicyResult = {
  policyName: string
  policyType: string
  horizonDays: number
  evaluationDate: string
  startDate: string | null
  endDate: string | null
  rewards: number[]
  returns: number[]
  drawdowns: number[]
  actionCounts: Record<Action, number>
  oracleMatches: number
}

const HORIZONS = (process.env.ML_RL_HORIZONS ?? '5,10,15')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const RECENT_DAYS = Number(process.env.ML_RL_RECENT_DAYS ?? 520)
const START_DATE = process.env.ML_RL_START_DATE?.trim() || null
const END_DATE = process.env.ML_RL_END_DATE?.trim() || null
const LIMIT_STATES = Number(process.env.ML_RL_LIMIT_STATES ?? 0)

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number | null | undefined, digits = 4): number | null {
  return finite(value) ? Number(value.toFixed(digits)) : null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function pctBucket(value: number | null | undefined, low: number, high: number): 'low' | 'mid' | 'high' | 'unknown' {
  if (!finite(value)) return 'unknown'
  if (value <= low) return 'low'
  if (value >= high) return 'high'
  return 'mid'
}

function policyAction(profile: PhysicsFeatureProfile): Action {
  const sma5Velocity = profile.velocities?.sma5?.d5 ?? 0
  const sma25Velocity = profile.velocities?.sma25?.d5 ?? 0
  const sma5Acceleration = profile.accelerations?.sma5?.d5 ?? 0
  const gap5To25 = profile.gaps?.sma5To25Pct ?? 0
  const gap5To25Velocity = profile.gapVelocity?.sma5To25D5 ?? 0
  const priceVsSma5 = profile.pricePosition?.sma5 ?? 0
  const priceVsSma25 = profile.pricePosition?.sma25 ?? 0
  const sectorRank = profile.context?.sector33RankPct ?? profile.context?.sector17RankPct ?? 50
  const order = profile.maOrder?.replace(/\s/g, '') ?? ''
  const trend = profile.regimes?.trend
  const spread = profile.regimes?.spread
  const turn = profile.regimes?.turn

  const overheated =
    priceVsSma5 > 14
    || gap5To25 > 11
    || (sma5Velocity > 16 && sma5Acceleration < -4)
  const supportiveContext = !finite(sectorRank) || sectorRank <= 65
  const longSetup =
    order.startsWith('5日>25日')
    && sma5Velocity > 0.8
    && sma25Velocity >= -0.2
    && gap5To25Velocity >= -1.5
    && priceVsSma5 >= -1
    && priceVsSma25 >= -3
    && supportiveContext
    && !overheated
    && (trend === 'up_acceleration' || spread === 'up_expansion' || turn === 'rebound_watch' || turn === 'bullish_turn')

  const shortSetup =
    (order.startsWith('200日>75日') || order.endsWith('25日>5日'))
    && sma5Velocity < -0.8
    && sma25Velocity <= 0.2
    && gap5To25Velocity <= 1.5
    && priceVsSma5 <= 1
    && priceVsSma25 <= 3
    && (trend === 'down_acceleration' || spread === 'down_expansion' || turn === 'breakdown_watch' || turn === 'bearish_turn')

  if (longSetup) return 'long_entry'
  if (shortSetup || overheated) return 'short_entry'
  return 'wait'
}

function oracleAction(state: State): Action {
  const actions: Action[] = ['long_entry', 'short_entry', 'wait']
  return actions.reduce((best, action) => {
    const reward = state.rewards[action] ?? -Infinity
    const bestReward = state.rewards[best] ?? -Infinity
    return reward > bestReward ? action : best
  }, 'wait' as Action)
}

function selectedReturn(state: State, action: Action): number | null {
  const value = state.returns.returnPct
  if (!finite(value)) return null
  if (action === 'short_entry') return -value
  return value
}

function selectedDrawdown(state: State, action: Action): number | null {
  if (action === 'short_entry') {
    const adverse = state.returns.maxReturnPct
    return finite(adverse) ? -Math.max(0, adverse) : null
  }
  const adverse = state.returns.minReturnPct
  return finite(adverse) ? adverse : null
}

function pushEvaluation(result: PolicyResult, state: State, action: Action) {
  const reward = state.rewards[action]
  if (!finite(reward)) return
  result.rewards.push(reward)
  result.actionCounts[action] += 1
  if (action === oracleAction(state)) result.oracleMatches += 1
  const ret = selectedReturn(state, action)
  if (finite(ret)) result.returns.push(ret)
  const drawdown = selectedDrawdown(state, action)
  if (finite(drawdown)) result.drawdowns.push(drawdown)
}

async function cutoffDate(): Promise<string | null> {
  if (START_DATE || RECENT_DAYS <= 0) return START_DATE
  const latest = END_DATE ?? (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM rl_training_states_v2`,
  ))?.date ?? null
  if (!latest) return null
  return (await execGet<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM rl_training_states_v2
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [latest, RECENT_DAYS],
  ))?.date ?? null
}

async function loadStates(horizon: number, startDate: string | null): Promise<State[]> {
  const where = [
    's.horizon_days = ?',
    'f.feature_set = ?',
    's.reward IS NOT NULL',
  ]
  const args: Array<string | number> = [horizon, ML_PHYSICS_FEATURE_SET]
  if (startDate) {
    where.push('s.date >= ?')
    args.push(startDate)
  }
  if (END_DATE) {
    where.push('s.date <= ?')
    args.push(END_DATE)
  }
  const limitSql = LIMIT_STATES > 0 ? `LIMIT ${LIMIT_STATES * 3}` : ''
  const rows = await execAll<StateActionRow>(
    `
    SELECT
      s.ticker,
      s.date,
      s.horizon_days,
      s.action,
      s.reward,
      l.return_pct,
      l.max_return_pct,
      l.min_return_pct,
      f.feature_json
    FROM rl_training_states_v2 s
    INNER JOIN ml_feature_vectors_v2 f
      ON f.ticker = s.ticker
     AND f.date = s.date
    LEFT JOIN ml_short_labels l
      ON l.ticker = s.ticker
     AND l.date = s.date
     AND l.horizon_days = s.horizon_days
    WHERE ${where.join(' AND ')}
    ORDER BY s.date DESC, s.ticker, s.action
    ${limitSql}
    `,
    args,
  )
  const byKey = new Map<string, State>()
  for (const row of rows) {
    const profile = parseJson<PhysicsFeatureProfile | null>(row.feature_json, null)
    if (!profile) continue
    const key = `${row.ticker}\t${row.date}\t${row.horizon_days}`
    let state = byKey.get(key)
    if (!state) {
      state = {
        ticker: row.ticker,
        date: row.date,
        horizonDays: row.horizon_days,
        profile,
        returns: {
          returnPct: row.return_pct,
          maxReturnPct: row.max_return_pct,
          minReturnPct: row.min_return_pct,
        },
        rewards: {},
      }
      byKey.set(key, state)
    }
    state.rewards[row.action] = row.reward ?? undefined
  }
  return [...byKey.values()].filter((state) =>
    finite(state.rewards.long_entry)
    && finite(state.rewards.short_entry)
    && finite(state.rewards.wait),
  )
}

function describeActionBreakdown(result: PolicyResult): Record<string, unknown> {
  const total = Math.max(1, result.rewards.length)
  return {
    long: result.actionCounts.long_entry,
    short: result.actionCounts.short_entry,
    wait: result.actionCounts.wait,
    longRate: round(result.actionCounts.long_entry / total, 4),
    shortRate: round(result.actionCounts.short_entry / total, 4),
    waitRate: round(result.actionCounts.wait / total, 4),
  }
}

function metrics(result: PolicyResult): Record<string, unknown> {
  const sampleCount = result.rewards.length
  const positive = result.rewards.filter((value) => value > 0).length
  return {
    featureSet: ML_PHYSICS_FEATURE_SET,
    recentDays: RECENT_DAYS,
    sampleCount,
    winRate: sampleCount ? round(positive / sampleCount, 4) : null,
    oracleMatchRate: sampleCount ? round(result.oracleMatches / sampleCount, 4) : null,
    avgReward: round(avg(result.rewards), 4),
    medianReward: round(median(result.rewards), 4),
    avgReturnPct: round(avg(result.returns), 4),
    maxDrawdownPct: round(result.drawdowns.length ? Math.min(...result.drawdowns) : null, 4),
    actionShape: describeActionBreakdown(result),
  }
}

function makeResult(policyName: string, policyType: string, horizon: number, evaluationDate: string, startDate: string | null, endDate: string | null): PolicyResult {
  return {
    policyName,
    policyType,
    horizonDays: horizon,
    evaluationDate,
    startDate,
    endDate,
    rewards: [],
    returns: [],
    drawdowns: [],
    actionCounts: { long_entry: 0, short_entry: 0, wait: 0 },
    oracleMatches: 0,
  }
}

function stateBucket(profile: PhysicsFeatureProfile): string {
  const trend = profile.regimes?.trend ?? 'unknown'
  const spread = profile.regimes?.spread ?? 'unknown'
  const sma5Speed = pctBucket(profile.velocities?.sma5?.d5, -2, 2)
  const gapFlow = pctBucket(profile.gapVelocity?.sma5To25D5, -1.5, 1.5)
  return `${trend}|${spread}|sma5:${sma5Speed}|gap:${gapFlow}`
}

async function evaluateHorizon(horizon: number, startDate: string | null): Promise<PolicyResult[]> {
  const states = await loadStates(horizon, startDate)
  const dates = states.map((state) => state.date).sort()
  const actualStart = dates[0] ?? startDate
  const actualEnd = END_DATE ?? dates.at(-1) ?? null
  const evaluationDate = new Date().toISOString().slice(0, 10)
  const rule = makeResult('physics_rule_policy_v1', 'offline_contextual_bandit', horizon, evaluationDate, actualStart, actualEnd)
  const oracle = makeResult('oracle_upper_bound', 'offline_oracle_benchmark', horizon, evaluationDate, actualStart, actualEnd)
  const wait = makeResult('always_wait', 'baseline', horizon, evaluationDate, actualStart, actualEnd)
  const buckets = new Map<string, { total: number; long: number; short: number; wait: number }>()

  for (const state of states) {
    const chosen = policyAction(state.profile)
    const best = oracleAction(state)
    pushEvaluation(rule, state, chosen)
    pushEvaluation(oracle, state, best)
    pushEvaluation(wait, state, 'wait')
    const bucket = stateBucket(state.profile)
    const current = buckets.get(bucket) ?? { total: 0, long: 0, short: 0, wait: 0 }
    current.total += 1
    current.long += best === 'long_entry' ? 1 : 0
    current.short += best === 'short_entry' ? 1 : 0
    current.wait += best === 'wait' ? 1 : 0
    buckets.set(bucket, current)
  }

  const bucketSummary = [...buckets.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 30)
    .map(([bucket, value]) => ({
      bucket,
      sampleCount: value.total,
      bestLongRate: round(value.long / Math.max(1, value.total), 4),
      bestShortRate: round(value.short / Math.max(1, value.total), 4),
      bestWaitRate: round(value.wait / Math.max(1, value.total), 4),
    }))

  for (const result of [rule, oracle, wait]) {
    ;(result as PolicyResult & { bucketSummary?: unknown }).bucketSummary = bucketSummary
  }
  return [rule, oracle, wait]
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml rl policy: no horizons')
    return
  }
  await execRun(`SELECT 1`)
  const startDate = await cutoffDate()
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const horizon of HORIZONS) {
    const results = await evaluateHorizon(horizon, startDate)
    for (const result of results) {
      const m = metrics(result)
      const actionBreakdown = describeActionBreakdown(result)
      statements.push({
        sql: `
          INSERT OR REPLACE INTO ml_rl_policy_evaluations
            (evaluation_id, policy_name, policy_type, horizon_days, evaluation_date,
             start_date, end_date, sample_count, long_count, short_count, wait_count,
             win_rate, oracle_match_rate, avg_reward, median_reward, avg_return_pct,
             max_drawdown_pct, action_breakdown_json, metrics_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          `${result.policyName}_h${horizon}_${result.evaluationDate}_${result.startDate ?? 'all'}_${result.endDate ?? 'latest'}`,
          result.policyName,
          result.policyType,
          horizon,
          result.evaluationDate,
          result.startDate,
          result.endDate,
          result.rewards.length,
          result.actionCounts.long_entry,
          result.actionCounts.short_entry,
          result.actionCounts.wait,
          m.winRate as number | null,
          m.oracleMatchRate as number | null,
          m.avgReward as number | null,
          m.medianReward as number | null,
          m.avgReturnPct as number | null,
          m.maxDrawdownPct as number | null,
          JSON.stringify(actionBreakdown),
          JSON.stringify({ ...m, bucketSummary: (result as PolicyResult & { bucketSummary?: unknown }).bucketSummary ?? [] }),
        ],
      })
    }
    console.log(`ml rl policy horizon=${horizon}: states=${results[0]?.rewards.length ?? 0}, start=${results[0]?.startDate ?? '-'}`)
  }
  await execBatch(statements)
  console.log(`ml rl policy complete: horizons=${HORIZONS.join('/')}, recent_days=${RECENT_DAYS || 'all'}, start=${startDate ?? '-'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
