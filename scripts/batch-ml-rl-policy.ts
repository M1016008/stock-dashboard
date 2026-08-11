// scripts/batch-ml-rl-policy.ts
//
// rl_training_states_v2 に保存した state/action/reward から、短期売買方針を
// オフラインで継続評価する。v1は安全な contextual-bandit 型の評価に留め、
// 未来情報を最新候補生成へ直接混ぜない。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_DEFAULT_HORIZON_LIST, ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'

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

type LabelStateRow = {
  ticker: string
  date: string
  horizon_days: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  reward_long: number | null
  reward_short: number | null
  reward_wait: number | null
  policy_action: Action
  state_bucket: string
}

type PolicyCacheFeatureRow = {
  ticker: string
  date: string
  feature_json: string
}

type State = {
  ticker: string
  date: string
  horizonDays: number
  policyAction: Action
  stateBucket: string
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
  sampleCount: number
  positiveCount: number
  rewardSum: number
  rewardBuckets: Map<number, number>
  returnSum: number
  returnCount: number
  maxDrawdownPct: number | null
  actionCounts: Record<Action, number>
  oracleMatches: number
}

type SqlPolicyAggRow = {
  sample_count: number | null
  min_date: string | null
  max_date: string | null
  rule_reward_sum: number | null
  rule_positive_count: number | null
  rule_return_sum: number | null
  rule_return_count: number | null
  rule_max_drawdown_pct: number | null
  rule_long_count: number | null
  rule_short_count: number | null
  rule_wait_count: number | null
  rule_oracle_matches: number | null
  oracle_reward_sum: number | null
  oracle_positive_count: number | null
  oracle_return_sum: number | null
  oracle_return_count: number | null
  oracle_max_drawdown_pct: number | null
  oracle_long_count: number | null
  oracle_short_count: number | null
  oracle_wait_count: number | null
  wait_reward_sum: number | null
  wait_positive_count: number | null
  wait_return_sum: number | null
  wait_return_count: number | null
  wait_max_drawdown_pct: number | null
}

const HORIZONS = (process.env.ML_RL_HORIZONS ?? ML_PHYSICS_DEFAULT_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const RECENT_DAYS = Number(process.env.ML_RL_RECENT_DAYS ?? 0)
const START_DATE = process.env.ML_RL_START_DATE?.trim() || null
const END_DATE = process.env.ML_RL_END_DATE?.trim() || null
const LIMIT_STATES = Number(process.env.ML_RL_LIMIT_STATES ?? 0)
const PAGE_DATES = Math.max(1, Number(process.env.ML_RL_PAGE_DATES ?? 20))
const POLICY_CACHE_PAGE_DATES = Math.max(1, Number(process.env.ML_RL_POLICY_CACHE_PAGE_DATES ?? 5))
const POLICY_CACHE_INSERT_ROWS = Math.max(100, Number(process.env.ML_RL_POLICY_CACHE_INSERT_ROWS ?? 1000))
const SQL_AGG_MODE = (process.env.ML_RL_SQL_AGG ?? '1') !== '0'

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function laterDate(a: string | null, b: string | null): string | null {
  if (a && b) return maxDate(a, b)
  return a ?? b
}

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

function medianFromBuckets(buckets: Map<number, number>, sampleCount: number): number | null {
  if (sampleCount === 0) return null
  const midpoint = Math.floor((sampleCount - 1) / 2)
  const midpoint2 = Math.floor(sampleCount / 2)
  let seen = 0
  let first: number | null = null
  let second: number | null = null
  for (const [bucket, count] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const nextSeen = seen + count
    if (first === null && midpoint < nextSeen) first = bucket / 100
    if (second === null && midpoint2 < nextSeen) {
      second = bucket / 100
      break
    }
    seen = nextSeen
  }
  if (first === null || second === null) return null
  return (first + second) / 2
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
  result.sampleCount += 1
  result.positiveCount += reward > 0 ? 1 : 0
  result.rewardSum += reward
  const rewardBucket = Math.round(reward * 100)
  result.rewardBuckets.set(rewardBucket, (result.rewardBuckets.get(rewardBucket) ?? 0) + 1)
  result.actionCounts[action] += 1
  if (action === oracleAction(state)) result.oracleMatches += 1
  const ret = selectedReturn(state, action)
  if (finite(ret)) {
    result.returnSum += ret
    result.returnCount += 1
  }
  const drawdown = selectedDrawdown(state, action)
  if (finite(drawdown)) {
    result.maxDrawdownPct = result.maxDrawdownPct === null ? drawdown : Math.min(result.maxDrawdownPct, drawdown)
  }
}

async function cutoffDate(): Promise<string | null> {
  if (RECENT_DAYS <= 0) return START_DATE
  const latest = END_DATE ?? (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM rl_training_states_v2`,
  ))?.date ?? null
  if (!latest) return null
  const recentStart = (await execGet<{ date: string | null }>(
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
  return laterDate(START_DATE, recentStart)
}

async function ensurePolicyCacheTables(): Promise<void> {
  await execRun(`
    CREATE TABLE IF NOT EXISTS ml_physics_feature_policy_cache (
      feature_set TEXT NOT NULL,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      policy_action TEXT NOT NULL,
      state_bucket TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (feature_set, ticker, date)
    )
  `)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_feature_policy_cache_date_idx ON ml_physics_feature_policy_cache(feature_set, date, policy_action)`)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_feature_policy_cache_action_idx ON ml_physics_feature_policy_cache(feature_set, policy_action, date)`)
}

async function loadMissingPolicyDateBatch(startDate: string | null, beforeDate: string | null): Promise<string[]> {
  const where = ['f.feature_set = ?']
  const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET]
  if (startDate) {
    where.push('f.date >= ?')
    args.push(startDate)
  }
  if (END_DATE) {
    where.push('f.date <= ?')
    args.push(END_DATE)
  }
  if (beforeDate) {
    where.push('f.date < ?')
    args.push(beforeDate)
  }
  where.push(`
    NOT EXISTS (
      SELECT 1
      FROM ml_physics_feature_policy_cache c
      WHERE c.feature_set = f.feature_set
        AND c.ticker = f.ticker
        AND c.date = f.date
    )
  `)

  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT f.date
    FROM ml_feature_vectors_v2 f
    WHERE ${where.join(' AND ')}
    ORDER BY f.date DESC
    LIMIT ?
    `,
    [...args, POLICY_CACHE_PAGE_DATES],
  )
  return rows.map((row) => row.date)
}

async function loadMissingPolicyRows(dates: string[]): Promise<PolicyCacheFeatureRow[]> {
  if (dates.length === 0) return []
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<PolicyCacheFeatureRow>(
    `
    SELECT
      f.ticker,
      f.date,
      f.feature_json
    FROM ml_feature_vectors_v2 f
    WHERE f.feature_set = ?
      AND f.date IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1
        FROM ml_physics_feature_policy_cache c
        WHERE c.feature_set = f.feature_set
          AND c.ticker = f.ticker
          AND c.date = f.date
      )
    `,
    [ML_PHYSICS_FEATURE_SET, ...dates],
  )
}

async function insertPolicyCacheRows(rows: Array<{ ticker: string; date: string; policyAction: Action; stateBucket: string }>): Promise<void> {
  for (let i = 0; i < rows.length; i += POLICY_CACHE_INSERT_ROWS) {
    const chunk = rows.slice(i, i + POLICY_CACHE_INSERT_ROWS)
    if (chunk.length === 0) continue
    const values = chunk.map(() => '(?, ?, ?, ?, ?, unixepoch())').join(', ')
    const args: string[] = []
    for (const row of chunk) {
      args.push(ML_PHYSICS_FEATURE_SET, row.ticker, row.date, row.policyAction, row.stateBucket)
    }
    await execRun(
      `
      INSERT OR IGNORE INTO ml_physics_feature_policy_cache
        (feature_set, ticker, date, policy_action, state_bucket, created_at)
      VALUES ${values}
      `,
      args,
    )
  }
}

async function populatePolicyCache(startDate: string | null): Promise<void> {
  let beforeDate: string | null = null
  let batches = 0
  let cachedRows = 0
  for (;;) {
    const dates = await loadMissingPolicyDateBatch(startDate, beforeDate)
    if (dates.length === 0) break
    const rows = await loadMissingPolicyRows(dates)
    const cacheRows: Array<{ ticker: string; date: string; policyAction: Action; stateBucket: string }> = []
    for (const row of rows) {
      const profile = parseJson<PhysicsFeatureProfile | null>(row.feature_json, null)
      if (!profile) continue
      cacheRows.push({
        ticker: row.ticker,
        date: row.date,
        policyAction: policyAction(profile),
        stateBucket: stateBucket(profile),
      })
    }
    await insertPolicyCacheRows(cacheRows)
    cachedRows += cacheRows.length
    batches += 1
    beforeDate = dates.at(-1) ?? null
    if (batches % 10 === 0) {
      console.log(`ml rl policy cache: batches=${batches}, cached=${cachedRows.toLocaleString()}, cursor<${beforeDate ?? '-'}`)
    }
    if (!beforeDate) break
  }
  console.log(`ml rl policy cache ready: feature_set=${ML_PHYSICS_FEATURE_SET}, added=${cachedRows.toLocaleString()}, start=${startDate ?? '-'}`)
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
        policyAction: policyAction(profile),
        stateBucket: stateBucket(profile),
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
  const total = Math.max(1, result.sampleCount)
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
  const sampleCount = result.sampleCount
  return {
    featureSet: ML_PHYSICS_FEATURE_SET,
    recentDays: RECENT_DAYS,
    sampleCount,
    winRate: sampleCount ? round(result.positiveCount / sampleCount, 4) : null,
    oracleMatchRate: sampleCount ? round(result.oracleMatches / sampleCount, 4) : null,
    avgReward: round(sampleCount ? result.rewardSum / sampleCount : null, 4),
    medianReward: round(medianFromBuckets(result.rewardBuckets, sampleCount), 4),
    avgReturnPct: round(result.returnCount ? result.returnSum / result.returnCount : null, 4),
    maxDrawdownPct: round(result.maxDrawdownPct, 4),
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
    sampleCount: 0,
    positiveCount: 0,
    rewardSum: 0,
    rewardBuckets: new Map(),
    returnSum: 0,
    returnCount: 0,
    maxDrawdownPct: null,
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

function stateFromLabelRow(row: LabelStateRow): State | null {
  if (!finite(row.reward_long) || !finite(row.reward_short) || !finite(row.reward_wait)) return null
  return {
    ticker: row.ticker,
    date: row.date,
    horizonDays: row.horizon_days,
    policyAction: row.policy_action,
    stateBucket: row.state_bucket,
    returns: {
      returnPct: row.return_pct,
      maxReturnPct: row.max_return_pct,
      minReturnPct: row.min_return_pct,
    },
    rewards: {
      long_entry: row.reward_long,
      short_entry: row.reward_short,
      wait: row.reward_wait,
    },
  }
}

async function loadDateBatch(horizon: number, startDate: string | null, beforeDate: string | null): Promise<string[]> {
  const where = ['horizon_days = ?']
  const args: Array<string | number> = [horizon]
  if (startDate) {
    where.push('date >= ?')
    args.push(startDate)
  }
  if (END_DATE) {
    where.push('date <= ?')
    args.push(END_DATE)
  }
  if (beforeDate) {
    where.push('date < ?')
    args.push(beforeDate)
  }
  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT date
    FROM ml_short_labels
    WHERE ${where.join(' AND ')}
    ORDER BY date DESC
    LIMIT ?
    `,
    [...args, PAGE_DATES],
  )
  return rows.map((row) => row.date)
}

async function loadLabelStates(horizon: number, dates: string[]): Promise<LabelStateRow[]> {
  if (dates.length === 0) return []
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<LabelStateRow>(
    `
    SELECT
      l.ticker,
      l.date,
      l.horizon_days,
      l.return_pct,
      l.max_return_pct,
      l.min_return_pct,
      l.reward_long,
      l.reward_short,
      l.reward_wait,
      c.policy_action,
      c.state_bucket
    FROM ml_short_labels l
    INNER JOIN ml_physics_feature_policy_cache c
      ON c.ticker = l.ticker
     AND c.date = l.date
     AND c.feature_set = ?
    WHERE l.horizon_days = ?
      AND l.date IN (${placeholders})
      AND l.reward_long IS NOT NULL
      AND l.reward_short IS NOT NULL
      AND l.reward_wait IS NOT NULL
    `,
    [ML_PHYSICS_FEATURE_SET, horizon, ...dates],
  )
}

function mergeSqlAggRow(
  results: { rule: PolicyResult; oracle: PolicyResult; wait: PolicyResult },
  row: SqlPolicyAggRow | undefined,
): void {
  const count = Number(row?.sample_count ?? 0)
  if (count <= 0) return
  const applyCommon = (result: PolicyResult, minDate: string | null | undefined, maxDate: string | null | undefined) => {
    if (minDate && (!result.startDate || minDate < result.startDate)) result.startDate = minDate
    if (maxDate && (!result.endDate || maxDate > result.endDate)) result.endDate = maxDate
  }
  applyCommon(results.rule, row?.min_date, row?.max_date)
  applyCommon(results.oracle, row?.min_date, row?.max_date)
  applyCommon(results.wait, row?.min_date, row?.max_date)

  results.rule.sampleCount += count
  results.rule.positiveCount += Number(row?.rule_positive_count ?? 0)
  results.rule.rewardSum += Number(row?.rule_reward_sum ?? 0)
  results.rule.returnSum += Number(row?.rule_return_sum ?? 0)
  results.rule.returnCount += Number(row?.rule_return_count ?? 0)
  results.rule.maxDrawdownPct = results.rule.maxDrawdownPct === null
    ? row?.rule_max_drawdown_pct ?? null
    : Math.min(results.rule.maxDrawdownPct, row?.rule_max_drawdown_pct ?? results.rule.maxDrawdownPct)
  results.rule.actionCounts.long_entry += Number(row?.rule_long_count ?? 0)
  results.rule.actionCounts.short_entry += Number(row?.rule_short_count ?? 0)
  results.rule.actionCounts.wait += Number(row?.rule_wait_count ?? 0)
  results.rule.oracleMatches += Number(row?.rule_oracle_matches ?? 0)

  results.oracle.sampleCount += count
  results.oracle.positiveCount += Number(row?.oracle_positive_count ?? 0)
  results.oracle.rewardSum += Number(row?.oracle_reward_sum ?? 0)
  results.oracle.returnSum += Number(row?.oracle_return_sum ?? 0)
  results.oracle.returnCount += Number(row?.oracle_return_count ?? 0)
  results.oracle.maxDrawdownPct = results.oracle.maxDrawdownPct === null
    ? row?.oracle_max_drawdown_pct ?? null
    : Math.min(results.oracle.maxDrawdownPct, row?.oracle_max_drawdown_pct ?? results.oracle.maxDrawdownPct)
  results.oracle.actionCounts.long_entry += Number(row?.oracle_long_count ?? 0)
  results.oracle.actionCounts.short_entry += Number(row?.oracle_short_count ?? 0)
  results.oracle.actionCounts.wait += Number(row?.oracle_wait_count ?? 0)
  results.oracle.oracleMatches += count

  results.wait.sampleCount += count
  results.wait.positiveCount += Number(row?.wait_positive_count ?? 0)
  results.wait.rewardSum += Number(row?.wait_reward_sum ?? 0)
  results.wait.returnSum += Number(row?.wait_return_sum ?? 0)
  results.wait.returnCount += Number(row?.wait_return_count ?? 0)
  results.wait.maxDrawdownPct = results.wait.maxDrawdownPct === null
    ? row?.wait_max_drawdown_pct ?? null
    : Math.min(results.wait.maxDrawdownPct, row?.wait_max_drawdown_pct ?? results.wait.maxDrawdownPct)
  results.wait.actionCounts.wait += count
  results.wait.oracleMatches += Number(row?.oracle_wait_count ?? 0)
}

async function aggregateSqlPolicyBatch(horizon: number, dates: string[]): Promise<SqlPolicyAggRow | undefined> {
  if (dates.length === 0) return undefined
  const placeholders = dates.map(() => '?').join(', ')
  return execGet<SqlPolicyAggRow>(
    `
    WITH base AS (
      SELECT
        l.date,
        l.return_pct,
        l.max_return_pct,
        l.min_return_pct,
        l.reward_long,
        l.reward_short,
        l.reward_wait,
        c.policy_action,
        CASE
          WHEN l.reward_long > l.reward_wait AND l.reward_long >= l.reward_short THEN 'long_entry'
          WHEN l.reward_short > l.reward_wait AND l.reward_short > l.reward_long THEN 'short_entry'
          ELSE 'wait'
        END AS oracle_action
      FROM ml_short_labels l
      INNER JOIN ml_physics_feature_policy_cache c
        ON c.ticker = l.ticker
       AND c.date = l.date
       AND c.feature_set = ?
      WHERE l.horizon_days = ?
        AND l.date IN (${placeholders})
        AND l.reward_long IS NOT NULL
        AND l.reward_short IS NOT NULL
        AND l.reward_wait IS NOT NULL
    ),
    scored AS (
      SELECT
        *,
        CASE policy_action
          WHEN 'long_entry' THEN reward_long
          WHEN 'short_entry' THEN reward_short
          ELSE reward_wait
        END AS rule_reward,
        CASE policy_action
          WHEN 'short_entry' THEN -return_pct
          ELSE return_pct
        END AS rule_return,
        CASE policy_action
          WHEN 'short_entry' THEN -MAX(0, max_return_pct)
          ELSE min_return_pct
        END AS rule_drawdown,
        MAX(reward_long, reward_short, reward_wait) AS oracle_reward,
        CASE oracle_action
          WHEN 'short_entry' THEN -return_pct
          ELSE return_pct
        END AS oracle_return,
        CASE oracle_action
          WHEN 'short_entry' THEN -MAX(0, max_return_pct)
          ELSE min_return_pct
        END AS oracle_drawdown
      FROM base
    )
    SELECT
      COUNT(*) AS sample_count,
      MIN(date) AS min_date,
      MAX(date) AS max_date,
      SUM(rule_reward) AS rule_reward_sum,
      SUM(CASE WHEN rule_reward > 0 THEN 1 ELSE 0 END) AS rule_positive_count,
      SUM(rule_return) AS rule_return_sum,
      SUM(CASE WHEN rule_return IS NOT NULL THEN 1 ELSE 0 END) AS rule_return_count,
      MIN(rule_drawdown) AS rule_max_drawdown_pct,
      SUM(CASE WHEN policy_action = 'long_entry' THEN 1 ELSE 0 END) AS rule_long_count,
      SUM(CASE WHEN policy_action = 'short_entry' THEN 1 ELSE 0 END) AS rule_short_count,
      SUM(CASE WHEN policy_action = 'wait' THEN 1 ELSE 0 END) AS rule_wait_count,
      SUM(CASE WHEN policy_action = oracle_action THEN 1 ELSE 0 END) AS rule_oracle_matches,
      SUM(oracle_reward) AS oracle_reward_sum,
      SUM(CASE WHEN oracle_reward > 0 THEN 1 ELSE 0 END) AS oracle_positive_count,
      SUM(oracle_return) AS oracle_return_sum,
      SUM(CASE WHEN oracle_return IS NOT NULL THEN 1 ELSE 0 END) AS oracle_return_count,
      MIN(oracle_drawdown) AS oracle_max_drawdown_pct,
      SUM(CASE WHEN oracle_action = 'long_entry' THEN 1 ELSE 0 END) AS oracle_long_count,
      SUM(CASE WHEN oracle_action = 'short_entry' THEN 1 ELSE 0 END) AS oracle_short_count,
      SUM(CASE WHEN oracle_action = 'wait' THEN 1 ELSE 0 END) AS oracle_wait_count,
      SUM(reward_wait) AS wait_reward_sum,
      SUM(CASE WHEN reward_wait > 0 THEN 1 ELSE 0 END) AS wait_positive_count,
      SUM(return_pct) AS wait_return_sum,
      SUM(CASE WHEN return_pct IS NOT NULL THEN 1 ELSE 0 END) AS wait_return_count,
      MIN(min_return_pct) AS wait_max_drawdown_pct
    FROM scored
    `,
    [ML_PHYSICS_FEATURE_SET, horizon, ...dates],
  )
}

async function evaluateHorizonSql(horizon: number, startDate: string | null, evaluationDate: string): Promise<PolicyResult[]> {
  const results = {
    rule: makeResult('physics_rule_policy_v1', 'offline_contextual_bandit', horizon, evaluationDate, startDate, END_DATE),
    oracle: makeResult('oracle_upper_bound', 'offline_oracle_benchmark', horizon, evaluationDate, startDate, END_DATE),
    wait: makeResult('always_wait', 'baseline', horizon, evaluationDate, startDate, END_DATE),
  }
  let beforeDate: string | null = null
  let batchCount = 0
  for (;;) {
    const dates = await loadDateBatch(horizon, startDate, beforeDate)
    if (dates.length === 0) break
    const row = await aggregateSqlPolicyBatch(horizon, dates)
    mergeSqlAggRow(results, row)
    batchCount += 1
    beforeDate = dates.at(-1) ?? null
    if (batchCount % 10 === 0) {
      console.log(`ml rl policy horizon=${horizon} sql: batches=${batchCount}, states=${results.rule.sampleCount.toLocaleString()}, cursor<${beforeDate ?? '-'}`)
    }
    if (!beforeDate) break
  }
  for (const result of [results.rule, results.oracle, results.wait]) {
    ;(result as PolicyResult & { bucketSummary?: unknown }).bucketSummary = []
  }
  return [results.rule, results.oracle, results.wait]
}

async function evaluateHorizon(horizon: number, startDate: string | null, evaluationDate: string): Promise<PolicyResult[]> {
  const rule = makeResult('physics_rule_policy_v1', 'offline_contextual_bandit', horizon, evaluationDate, startDate, END_DATE)
  const oracle = makeResult('oracle_upper_bound', 'offline_oracle_benchmark', horizon, evaluationDate, startDate, END_DATE)
  const wait = makeResult('always_wait', 'baseline', horizon, evaluationDate, startDate, END_DATE)
  const buckets = new Map<string, { total: number; long: number; short: number; wait: number }>()

  let beforeDate: string | null = null
  let actualStart: string | null = null
  let actualEnd: string | null = null
  let batchCount = 0
  for (;;) {
    const dates = await loadDateBatch(horizon, startDate, beforeDate)
    if (dates.length === 0) break
    const rows = await loadLabelStates(horizon, dates)
    for (const row of rows) {
      if (LIMIT_STATES > 0 && rule.sampleCount >= LIMIT_STATES) break
      const state = stateFromLabelRow(row)
      if (!state) continue
      if (actualStart === null) actualStart = state.date
      else if (state.date < actualStart) actualStart = state.date
      if (actualEnd === null) actualEnd = state.date
      else if (state.date > actualEnd) actualEnd = state.date
      const chosen = state.policyAction
      const best = oracleAction(state)
      pushEvaluation(rule, state, chosen)
      pushEvaluation(oracle, state, best)
      pushEvaluation(wait, state, 'wait')
      const bucket = state.stateBucket
      const current = buckets.get(bucket) ?? { total: 0, long: 0, short: 0, wait: 0 }
      current.total += 1
      current.long += best === 'long_entry' ? 1 : 0
      current.short += best === 'short_entry' ? 1 : 0
      current.wait += best === 'wait' ? 1 : 0
      buckets.set(bucket, current)
    }
    batchCount += 1
    beforeDate = dates.at(-1) ?? null
    if (batchCount % 10 === 0) {
      console.log(`ml rl policy horizon=${horizon}: batches=${batchCount}, states=${rule.sampleCount.toLocaleString()}, cursor<${beforeDate ?? '-'}`)
    }
    if (!beforeDate || (LIMIT_STATES > 0 && rule.sampleCount >= LIMIT_STATES)) break
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
    result.startDate = actualStart ?? startDate
    result.endDate = END_DATE ?? actualEnd
    ;(result as PolicyResult & { bucketSummary?: unknown }).bucketSummary = bucketSummary
  }
  return [rule, oracle, wait]
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml rl policy: no horizons')
    return
  }
  await ensurePolicyCacheTables()
  const evaluationDate = new Date().toISOString().slice(0, 10)
  const horizonPlaceholders = HORIZONS.map(() => '?').join(', ')
  const policyNames = ['physics_rule_policy_v1', 'oracle_upper_bound', 'always_wait']
  const policyPlaceholders = policyNames.map(() => '?').join(', ')
  await execRun(
    `
    DELETE FROM ml_rl_policy_evaluations
    WHERE evaluation_date = ?
      AND horizon_days IN (${horizonPlaceholders})
      AND policy_name IN (${policyPlaceholders})
    `,
    [evaluationDate, ...HORIZONS, ...policyNames],
  )
  const startDate = await cutoffDate()
  await populatePolicyCache(startDate)
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const horizon of HORIZONS) {
    const horizonStatements: typeof statements = []
    const results = SQL_AGG_MODE
      ? await evaluateHorizonSql(horizon, startDate, evaluationDate)
      : await evaluateHorizon(horizon, startDate, evaluationDate)
    for (const result of results) {
      const m = metrics(result)
      const actionBreakdown = describeActionBreakdown(result)
      horizonStatements.push({
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
          result.sampleCount,
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
    await execBatch(horizonStatements)
    statements.push(...horizonStatements)
    console.log(`ml rl policy horizon=${horizon}: states=${results[0]?.sampleCount ?? 0}, start=${results[0]?.startDate ?? '-'}`)
    console.log(`ml rl policy horizon=${horizon}: saved=${horizonStatements.length}`)
  }
  console.log(`ml rl policy complete: horizons=${HORIZONS.join('/')}, recent_days=${RECENT_DAYS || 'all'}, start=${startDate ?? '-'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
