// scripts/batch-ml-physics-status-evaluate.ts
//
// Physical Momentum の状態ラベルを、過去の forward extrema / ml_short_labels で
// 日次に客観検証する。これはオンライン強化学習ではなく、未来情報を現在の候補生成へ
// 直接混ぜない offline calibration として扱う。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'

type TargetDirection = 'up' | 'down' | 'wait'

type LabelRow = {
  ticker: string
  date: string
  horizon_days: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  up_label: number
  down_label: number
  wait_label: number
  reward_long: number | null
  reward_short: number | null
  reward_wait: number | null
  status_label: PhysicsStatus
}

type FeatureStatusRow = {
  ticker: string
  date: string
  feature_json: string
}

type Aggregate = {
  statusLabel: PhysicsStatus
  targetDirection: TargetDirection
  horizonDays: number
  startDate: string | null
  endDate: string | null
  sampleCount: number
  hitCount: number
  adverseCount: number
  returnSum: number
  returnCount: number
  maxReturnSum: number
  maxReturnCount: number
  minReturnSum: number
  minReturnCount: number
  returnBuckets: Map<number, number>
  rewardSum: number
  rewardCount: number
}

type GlobalAggregate = {
  targetDirection: TargetDirection
  horizonDays: number
  sampleCount: number
  hitCount: number
}

type HorizonEvaluation = {
  aggregates: Aggregate[]
  globals: Map<TargetDirection, GlobalAggregate>
}

type SqlAggregateRow = {
  status_label: PhysicsStatus
  target_direction: TargetDirection
  horizon_days: number
  start_date: string | null
  end_date: string | null
  sample_count: number
  hit_count: number
  adverse_count: number
  avg_return_pct: number | null
  avg_max_return_pct: number | null
  avg_min_return_pct: number | null
  avg_reward: number | null
  global_sample_count: number
  global_up_hit_count: number
  global_down_hit_count: number
  global_wait_hit_count: number
}

type SqlPartialRow = {
  status_label: PhysicsStatus
  target_direction: TargetDirection
  horizon_days: number
  start_date: string | null
  end_date: string | null
  sample_count: number
  hit_count: number
  adverse_count: number
  return_sum: number | null
  return_count: number
  max_return_sum: number | null
  max_return_count: number
  min_return_sum: number | null
  min_return_count: number
  reward_sum: number | null
  reward_count: number
  global_up_hit_count: number
  global_down_hit_count: number
  global_wait_hit_count: number
}

type SqlRunningAggregate = {
  status_label: PhysicsStatus
  target_direction: TargetDirection
  horizon_days: number
  start_date: string | null
  end_date: string | null
  sample_count: number
  hit_count: number
  adverse_count: number
  return_sum: number
  return_count: number
  max_return_sum: number
  max_return_count: number
  min_return_sum: number
  min_return_count: number
  reward_sum: number
  reward_count: number
  global_sample_count: number
  global_up_hit_count: number
  global_down_hit_count: number
  global_wait_hit_count: number
}

const STATUS_TARGET: Record<PhysicsStatus, TargetDirection> = {
  上昇加速: 'up',
  上昇継続: 'up',
  押し目形成: 'up',
  反発準備: 'up',
  過熱注意: 'down',
  失速警戒: 'down',
  下落加速: 'down',
  見送り: 'wait',
  算出待ち: 'wait',
}

const HORIZONS = (process.env.ML_PHYSICS_STATUS_HORIZONS ?? ML_PRIMARY_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const RECENT_DAYS = Number(process.env.ML_PHYSICS_STATUS_RECENT_DAYS ?? 0)
const START_DATE = process.env.ML_PHYSICS_STATUS_START_DATE?.trim() || null
const END_DATE = process.env.ML_PHYSICS_STATUS_END_DATE?.trim() || null
const PAGE_DATES = Math.max(1, Number(process.env.ML_PHYSICS_STATUS_PAGE_DATES ?? 20))
const STATUS_CACHE_PAGE_ROWS = Math.max(100, Number(process.env.ML_PHYSICS_STATUS_CACHE_PAGE_ROWS ?? 1000))
const LIMIT_ROWS = Math.max(0, Number(process.env.ML_PHYSICS_STATUS_LIMIT_ROWS ?? 0))
const STATUS_CACHE_INSERT_ROWS = Math.max(100, Number(process.env.ML_PHYSICS_STATUS_CACHE_INSERT_ROWS ?? 1000))
const SKIP_STATUS_CACHE = process.env.ML_PHYSICS_STATUS_SKIP_CACHE === '1'
const SQL_AGGREGATE =
  process.env.ML_PHYSICS_STATUS_SQL_AGG === '1' ||
  (process.env.ML_PHYSICS_STATUS_SQL_AGG == null && RECENT_DAYS > 0)

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

function avg(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null
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

function wilsonLowerBound(hitCount: number, sampleCount: number, z = 1.96): number | null {
  if (sampleCount <= 0) return null
  const p = hitCount / sampleCount
  const z2 = z * z
  const denom = 1 + z2 / sampleCount
  const centre = p + z2 / (2 * sampleCount)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * sampleCount)) / sampleCount)
  return Math.max(0, (centre - margin) / denom)
}

function confidenceScore(hitCount: number, sampleCount: number, lift: number | null): number | null {
  const lower = wilsonLowerBound(hitCount, sampleCount)
  if (lower == null) return null
  const liftBoost = lift == null ? 0 : Math.max(-10, Math.min(18, (lift - 1) * 28))
  const sampleBoost = Math.min(8, Math.log10(Math.max(1, sampleCount)) * 2.5)
  return Math.max(0, Math.min(100, lower * 100 + liftBoost + sampleBoost))
}

function selectedHit(row: LabelRow, direction: TargetDirection): boolean {
  if (direction === 'up') return Number(row.up_label) === 1
  if (direction === 'down') return Number(row.down_label) === 1
  return Number(row.wait_label) === 1
}

function selectedAdverse(row: LabelRow, direction: TargetDirection): boolean {
  if (direction === 'up') return Number(row.down_label) === 1
  if (direction === 'down') return Number(row.up_label) === 1
  return Number(row.up_label) === 1 || Number(row.down_label) === 1
}

function selectedReturn(row: LabelRow, direction: TargetDirection): number | null {
  if (!finite(row.return_pct)) return null
  if (direction === 'down') return -row.return_pct
  if (direction === 'wait') return -Math.abs(row.return_pct)
  return row.return_pct
}

function selectedReward(row: LabelRow, direction: TargetDirection): number | null {
  if (direction === 'up') return row.reward_long
  if (direction === 'down') return row.reward_short
  return row.reward_wait
}

function makeAggregate(statusLabel: PhysicsStatus, horizonDays: number): Aggregate {
  return {
    statusLabel,
    targetDirection: STATUS_TARGET[statusLabel],
    horizonDays,
    startDate: null,
    endDate: null,
    sampleCount: 0,
    hitCount: 0,
    adverseCount: 0,
    returnSum: 0,
    returnCount: 0,
    maxReturnSum: 0,
    maxReturnCount: 0,
    minReturnSum: 0,
    minReturnCount: 0,
    returnBuckets: new Map(),
    rewardSum: 0,
    rewardCount: 0,
  }
}

function makeGlobal(direction: TargetDirection, horizonDays: number): GlobalAggregate {
  return { targetDirection: direction, horizonDays, sampleCount: 0, hitCount: 0 }
}

function noteDateRange(aggregate: Aggregate, date: string): void {
  aggregate.startDate = aggregate.startDate == null || date < aggregate.startDate ? date : aggregate.startDate
  aggregate.endDate = aggregate.endDate == null || date > aggregate.endDate ? date : aggregate.endDate
}

function pushAggregate(aggregate: Aggregate, row: LabelRow): void {
  noteDateRange(aggregate, row.date)
  aggregate.sampleCount += 1
  if (selectedHit(row, aggregate.targetDirection)) aggregate.hitCount += 1
  if (selectedAdverse(row, aggregate.targetDirection)) aggregate.adverseCount += 1

  const ret = selectedReturn(row, aggregate.targetDirection)
  if (finite(ret)) {
    aggregate.returnSum += ret
    aggregate.returnCount += 1
    const bucket = Math.round(ret * 100)
    aggregate.returnBuckets.set(bucket, (aggregate.returnBuckets.get(bucket) ?? 0) + 1)
  }
  if (finite(row.max_return_pct)) {
    aggregate.maxReturnSum += row.max_return_pct
    aggregate.maxReturnCount += 1
  }
  if (finite(row.min_return_pct)) {
    aggregate.minReturnSum += row.min_return_pct
    aggregate.minReturnCount += 1
  }
  const reward = selectedReward(row, aggregate.targetDirection)
  if (finite(reward)) {
    aggregate.rewardSum += reward
    aggregate.rewardCount += 1
  }
}

function pushGlobal(aggregate: GlobalAggregate, row: LabelRow): void {
  aggregate.sampleCount += 1
  if (selectedHit(row, aggregate.targetDirection)) aggregate.hitCount += 1
}

async function ensureTables(): Promise<void> {
  await execRun(`
    CREATE TABLE IF NOT EXISTS ml_physics_feature_statuses (
      feature_set TEXT NOT NULL,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      status_label TEXT NOT NULL,
      target_direction TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (feature_set, ticker, date)
    )
  `)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_feature_statuses_date_idx ON ml_physics_feature_statuses(feature_set, date, status_label)`)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_feature_statuses_status_idx ON ml_physics_feature_statuses(feature_set, status_label, date)`)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_short_labels_horizon_date_ticker_idx ON ml_short_labels(horizon_days, date, ticker)`)

  await execRun(`
    CREATE TABLE IF NOT EXISTS ml_physics_status_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      evaluation_date TEXT NOT NULL,
      feature_set TEXT NOT NULL,
      status_label TEXT NOT NULL,
      target_direction TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      start_date TEXT,
      end_date TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      adverse_count INTEGER NOT NULL DEFAULT 0,
      hit_rate REAL,
      base_rate REAL,
      lift REAL,
      confidence_score REAL,
      median_return_pct REAL,
      avg_return_pct REAL,
      avg_max_return_pct REAL,
      avg_min_return_pct REAL,
      adverse_rate REAL,
      metrics_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_status_evaluations_latest_idx ON ml_physics_status_evaluations(evaluation_date, horizon_days, status_label)`)
  await execRun(`CREATE INDEX IF NOT EXISTS ml_physics_status_evaluations_status_idx ON ml_physics_status_evaluations(status_label, horizon_days, evaluation_date)`)
}

async function loadMissingStatusRows(
  startDate: string | null,
  cursor: { ticker: string; date: string } | null,
): Promise<FeatureStatusRow[]> {
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
  if (cursor) {
    where.push('(f.ticker > ? OR (f.ticker = ? AND f.date > ?))')
    args.push(cursor.ticker, cursor.ticker, cursor.date)
  }
  where.push(`
    NOT EXISTS (
      SELECT 1
      FROM ml_physics_feature_statuses s
      WHERE s.feature_set = f.feature_set
        AND s.ticker = f.ticker
        AND s.date = f.date
    )
  `)

  return execAll<FeatureStatusRow>(
    `
    SELECT f.ticker, f.date, f.feature_json
    FROM ml_feature_vectors_v2 f INDEXED BY ml_feature_vectors_v2_feature_ticker_date_idx
    WHERE ${where.join(' AND ')}
    ORDER BY f.ticker ASC, f.date ASC
    LIMIT ?
    `,
    [...args, STATUS_CACHE_PAGE_ROWS],
  )
}

async function insertStatusCacheRows(rows: Array<{ ticker: string; date: string; statusLabel: PhysicsStatus }>): Promise<void> {
  for (let i = 0; i < rows.length; i += STATUS_CACHE_INSERT_ROWS) {
    const chunk = rows.slice(i, i + STATUS_CACHE_INSERT_ROWS)
    if (chunk.length === 0) continue
    const values = chunk.map(() => '(?, ?, ?, ?, ?, unixepoch())').join(', ')
    const args: string[] = []
    for (const row of chunk) {
      args.push(ML_PHYSICS_FEATURE_SET, row.ticker, row.date, row.statusLabel, STATUS_TARGET[row.statusLabel])
    }
    await execRun(
      `
      INSERT OR IGNORE INTO ml_physics_feature_statuses
        (feature_set, ticker, date, status_label, target_direction, created_at)
      VALUES ${values}
      `,
      args,
    )
  }
}

async function populateStatusCache(startDate: string | null): Promise<void> {
  let cursor: { ticker: string; date: string } | null = null
  let batches = 0
  let cachedRows = 0
  for (;;) {
    const rows = await loadMissingStatusRows(startDate, cursor)
    if (rows.length === 0) break
    const cacheRows: Array<{ ticker: string; date: string; statusLabel: PhysicsStatus }> = []
    for (const row of rows) {
      const profile = parseJson<Partial<PhysicsFeatureProfile> | null>(row.feature_json, null)
      const analysis = analyzePhysicsProfile(profile)
      cacheRows.push({ ticker: row.ticker, date: row.date, statusLabel: analysis.physicsStatus })
    }
    await insertStatusCacheRows(cacheRows)
    cachedRows += cacheRows.length
    batches += 1
    const lastRow = rows.at(-1)
    cursor = lastRow ? { ticker: lastRow.ticker, date: lastRow.date } : null
    if (batches % 10 === 0) {
      console.log(
        `physics status cache: batches=${batches}, cached=${cachedRows.toLocaleString()}, cursor>${cursor ? `${cursor.ticker}@${cursor.date}` : '-'}`,
      )
    }
    if (!cursor || rows.length < STATUS_CACHE_PAGE_ROWS) break
  }
  console.log(`physics status cache ready: feature_set=${ML_PHYSICS_FEATURE_SET}, added=${cachedRows.toLocaleString()}, start=${startDate ?? '-'}`)
}

async function cutoffDate(horizon: number): Promise<string | null> {
  if (RECENT_DAYS <= 0) return START_DATE
  const latest = END_DATE ?? (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days = ?`,
    [horizon],
  ))?.date ?? null
  if (!latest) return null
  const recentStart = (await execGet<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM ml_short_labels
      WHERE horizon_days = ?
        AND date <= ?
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [horizon, latest, RECENT_DAYS],
  ))?.date ?? null
  if (START_DATE && recentStart && START_DATE > recentStart) return START_DATE
  return recentStart
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

async function loadRows(horizon: number, dates: string[]): Promise<LabelRow[]> {
  if (dates.length === 0) return []
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<LabelRow>(
    `
    SELECT
      l.ticker,
      l.date,
      l.horizon_days,
      l.return_pct,
      l.max_return_pct,
      l.min_return_pct,
      l.up_label,
      l.down_label,
      l.wait_label,
      l.reward_long,
      l.reward_short,
      l.reward_wait,
      s.status_label
    FROM ml_short_labels l
    INNER JOIN ml_physics_feature_statuses s
      ON s.ticker = l.ticker
     AND s.date = l.date
     AND s.feature_set = ?
    WHERE l.horizon_days = ?
      AND l.date IN (${placeholders})
    `,
    [ML_PHYSICS_FEATURE_SET, horizon, ...dates],
  )
}

function metricsFor(aggregate: Aggregate, global: GlobalAggregate): Record<string, unknown> {
  const hitRate = aggregate.sampleCount ? aggregate.hitCount / aggregate.sampleCount : null
  const baseRate = global.sampleCount ? global.hitCount / global.sampleCount : null
  const lift = hitRate != null && baseRate != null && baseRate > 0 ? hitRate / baseRate : null
  return {
    featureSet: ML_PHYSICS_FEATURE_SET,
    statusLabel: aggregate.statusLabel,
    targetDirection: aggregate.targetDirection,
    horizonDays: aggregate.horizonDays,
    sampleCount: aggregate.sampleCount,
    hitCount: aggregate.hitCount,
    adverseCount: aggregate.adverseCount,
    hitRate: round(hitRate),
    baseRate: round(baseRate),
    lift: round(lift),
    confidenceScore: round(confidenceScore(aggregate.hitCount, aggregate.sampleCount, lift), 2),
    adverseRate: round(aggregate.sampleCount ? aggregate.adverseCount / aggregate.sampleCount : null),
    avgReward: round(avg(aggregate.rewardSum, aggregate.rewardCount)),
    medianReturnPct: round(medianFromBuckets(aggregate.returnBuckets, aggregate.returnCount)),
    avgReturnPct: round(avg(aggregate.returnSum, aggregate.returnCount)),
    avgMaxReturnPct: round(avg(aggregate.maxReturnSum, aggregate.maxReturnCount)),
    avgMinReturnPct: round(avg(aggregate.minReturnSum, aggregate.minReturnCount)),
    globalSampleCount: global.sampleCount,
    globalHitCount: global.hitCount,
  }
}

async function evaluateHorizon(horizon: number, startDate: string | null): Promise<HorizonEvaluation> {
  const aggregates = new Map<PhysicsStatus, Aggregate>()
  const globals = new Map<TargetDirection, GlobalAggregate>()
  for (const status of Object.keys(STATUS_TARGET) as PhysicsStatus[]) {
    aggregates.set(status, makeAggregate(status, horizon))
  }
  for (const direction of ['up', 'down', 'wait'] as const) {
    globals.set(direction, makeGlobal(direction, horizon))
  }

  let beforeDate: string | null = null
  let processedRows = 0
  let batches = 0
  for (;;) {
    const dates = await loadDateBatch(horizon, startDate, beforeDate)
    if (dates.length === 0) break
    const rows = await loadRows(horizon, dates)
    for (const row of rows) {
      if (LIMIT_ROWS > 0 && processedRows >= LIMIT_ROWS) break
      const aggregate = aggregates.get(row.status_label)
      if (aggregate) pushAggregate(aggregate, row)
      for (const direction of ['up', 'down', 'wait'] as const) {
        const global = globals.get(direction)
        if (global) pushGlobal(global, row)
      }
      processedRows += 1
    }
    batches += 1
    beforeDate = dates.at(-1) ?? null
    if (batches % 10 === 0) {
      console.log(`physics status eval horizon=${horizon}: batches=${batches}, rows=${processedRows.toLocaleString()}, cursor<${beforeDate ?? '-'}`)
    }
    if (!beforeDate || (LIMIT_ROWS > 0 && processedRows >= LIMIT_ROWS)) break
  }

  return { aggregates: [...aggregates.values()], globals }
}

function statusWhere(startDate: string | null): { sql: string; args: Array<string | number> } {
  const where = [`l.horizon_days = ?`, `s.feature_set = ?`]
  const args: Array<string | number> = [0, ML_PHYSICS_FEATURE_SET]
  if (startDate) {
    where.push(`l.date >= ?`)
    args.push(startDate)
  }
  if (END_DATE) {
    where.push(`l.date <= ?`)
    args.push(END_DATE)
  }
  return { sql: where.join(' AND '), args }
}

async function evaluateHorizonSql(
  horizon: number,
  startDate: string | null,
): Promise<{ aggregates: SqlAggregateRow[] }> {
  const running = new Map<string, SqlRunningAggregate>()
  let beforeDate: string | null = null
  let batches = 0
  let globalSampleCount = 0
  let globalUpHitCount = 0
  let globalDownHitCount = 0
  let globalWaitHitCount = 0

  for (;;) {
    const dates = await loadDateBatch(horizon, startDate, beforeDate)
    if (dates.length === 0) break
    const placeholders = dates.map(() => '?').join(', ')
    const partials = await execAll<SqlPartialRow>(
      `
      SELECT
        s.status_label,
        s.target_direction,
        l.horizon_days,
        MIN(l.date) AS start_date,
        MAX(l.date) AS end_date,
        COUNT(*) AS sample_count,
        SUM(
          CASE s.target_direction
            WHEN 'up' THEN CASE WHEN l.up_label = 1 THEN 1 ELSE 0 END
            WHEN 'down' THEN CASE WHEN l.down_label = 1 THEN 1 ELSE 0 END
            ELSE CASE WHEN l.wait_label = 1 THEN 1 ELSE 0 END
          END
        ) AS hit_count,
        SUM(
          CASE s.target_direction
            WHEN 'up' THEN CASE WHEN l.down_label = 1 THEN 1 ELSE 0 END
            WHEN 'down' THEN CASE WHEN l.up_label = 1 THEN 1 ELSE 0 END
            ELSE CASE WHEN l.up_label = 1 OR l.down_label = 1 THEN 1 ELSE 0 END
          END
        ) AS adverse_count,
        SUM(
          CASE
            WHEN l.return_pct IS NULL THEN NULL
            WHEN s.target_direction = 'down' THEN -l.return_pct
            WHEN s.target_direction = 'wait' THEN -ABS(l.return_pct)
            ELSE l.return_pct
          END
        ) AS return_sum,
        SUM(CASE WHEN l.return_pct IS NULL THEN 0 ELSE 1 END) AS return_count,
        SUM(l.max_return_pct) AS max_return_sum,
        SUM(CASE WHEN l.max_return_pct IS NULL THEN 0 ELSE 1 END) AS max_return_count,
        SUM(l.min_return_pct) AS min_return_sum,
        SUM(CASE WHEN l.min_return_pct IS NULL THEN 0 ELSE 1 END) AS min_return_count,
        SUM(
          CASE s.target_direction
            WHEN 'up' THEN l.reward_long
            WHEN 'down' THEN l.reward_short
            ELSE l.reward_wait
          END
        ) AS reward_sum,
        SUM(
          CASE s.target_direction
            WHEN 'up' THEN CASE WHEN l.reward_long IS NULL THEN 0 ELSE 1 END
            WHEN 'down' THEN CASE WHEN l.reward_short IS NULL THEN 0 ELSE 1 END
            ELSE CASE WHEN l.reward_wait IS NULL THEN 0 ELSE 1 END
          END
        ) AS reward_count,
        SUM(CASE WHEN l.up_label = 1 THEN 1 ELSE 0 END) AS global_up_hit_count,
        SUM(CASE WHEN l.down_label = 1 THEN 1 ELSE 0 END) AS global_down_hit_count,
        SUM(CASE WHEN l.wait_label = 1 THEN 1 ELSE 0 END) AS global_wait_hit_count
      FROM ml_short_labels l INDEXED BY ml_short_labels_horizon_date_ticker_idx
      INNER JOIN ml_physics_feature_statuses s
        ON s.ticker = l.ticker
       AND s.date = l.date
       AND s.feature_set = ?
      WHERE l.horizon_days = ?
        AND l.date IN (${placeholders})
      GROUP BY s.status_label, s.target_direction, l.horizon_days
      HAVING sample_count > 0
      `,
      [ML_PHYSICS_FEATURE_SET, horizon, ...dates],
    )

    const batchSampleCount = partials.reduce((sum, row) => sum + Number(row.sample_count ?? 0), 0)
    globalSampleCount += batchSampleCount
    globalUpHitCount += partials.reduce((sum, row) => sum + Number(row.global_up_hit_count ?? 0), 0)
    globalDownHitCount += partials.reduce((sum, row) => sum + Number(row.global_down_hit_count ?? 0), 0)
    globalWaitHitCount += partials.reduce((sum, row) => sum + Number(row.global_wait_hit_count ?? 0), 0)
    for (const row of partials) {
      const key = row.status_label
      const current = running.get(key) ?? {
        status_label: row.status_label,
        target_direction: row.target_direction,
        horizon_days: horizon,
        start_date: null,
        end_date: null,
        sample_count: 0,
        hit_count: 0,
        adverse_count: 0,
        return_sum: 0,
        return_count: 0,
        max_return_sum: 0,
        max_return_count: 0,
        min_return_sum: 0,
        min_return_count: 0,
        reward_sum: 0,
        reward_count: 0,
        global_sample_count: 0,
        global_up_hit_count: 0,
        global_down_hit_count: 0,
        global_wait_hit_count: 0,
      }
      current.start_date = current.start_date == null || (row.start_date != null && row.start_date < current.start_date) ? row.start_date : current.start_date
      current.end_date = current.end_date == null || (row.end_date != null && row.end_date > current.end_date) ? row.end_date : current.end_date
      current.sample_count += Number(row.sample_count ?? 0)
      current.hit_count += Number(row.hit_count ?? 0)
      current.adverse_count += Number(row.adverse_count ?? 0)
      current.return_sum += Number(row.return_sum ?? 0)
      current.return_count += Number(row.return_count ?? 0)
      current.max_return_sum += Number(row.max_return_sum ?? 0)
      current.max_return_count += Number(row.max_return_count ?? 0)
      current.min_return_sum += Number(row.min_return_sum ?? 0)
      current.min_return_count += Number(row.min_return_count ?? 0)
      current.reward_sum += Number(row.reward_sum ?? 0)
      current.reward_count += Number(row.reward_count ?? 0)
      running.set(key, current)
    }

    batches += 1
    beforeDate = dates.at(-1) ?? null
    if (batches % 10 === 0) {
      const processedRows = [...running.values()].reduce((sum, row) => sum + row.sample_count, 0)
      console.log(`physics status eval sql horizon=${horizon}: batches=${batches}, rows=${processedRows.toLocaleString()}, cursor<${beforeDate ?? '-'}`)
    }
    if (!beforeDate) break
  }

  const aggregates: SqlAggregateRow[] = [...running.values()].map((row) => ({
    status_label: row.status_label,
    target_direction: row.target_direction,
    horizon_days: row.horizon_days,
    start_date: row.start_date,
    end_date: row.end_date,
    sample_count: row.sample_count,
    hit_count: row.hit_count,
    adverse_count: row.adverse_count,
    avg_return_pct: avg(row.return_sum, row.return_count),
    avg_max_return_pct: avg(row.max_return_sum, row.max_return_count),
    avg_min_return_pct: avg(row.min_return_sum, row.min_return_count),
    avg_reward: avg(row.reward_sum, row.reward_count),
    global_sample_count: globalSampleCount,
    global_up_hit_count: globalUpHitCount,
    global_down_hit_count: globalDownHitCount,
    global_wait_hit_count: globalWaitHitCount,
  }))

  return { aggregates }
}

function metricsForSql(aggregate: SqlAggregateRow): Record<string, unknown> {
  const globalHitCount =
    aggregate.target_direction === 'up'
      ? aggregate.global_up_hit_count
      : aggregate.target_direction === 'down'
        ? aggregate.global_down_hit_count
        : aggregate.global_wait_hit_count
  const hitRate = aggregate.sample_count ? aggregate.hit_count / aggregate.sample_count : null
  const baseRate = aggregate.global_sample_count ? globalHitCount / aggregate.global_sample_count : null
  const lift = hitRate != null && baseRate != null && baseRate > 0 ? hitRate / baseRate : null
  return {
    featureSet: ML_PHYSICS_FEATURE_SET,
    statusLabel: aggregate.status_label,
    targetDirection: aggregate.target_direction,
    horizonDays: aggregate.horizon_days,
    sampleCount: aggregate.sample_count,
    hitCount: aggregate.hit_count,
    adverseCount: aggregate.adverse_count,
    hitRate: round(hitRate),
    baseRate: round(baseRate),
    lift: round(lift),
    confidenceScore: round(confidenceScore(aggregate.hit_count, aggregate.sample_count, lift), 2),
    adverseRate: round(aggregate.sample_count ? aggregate.adverse_count / aggregate.sample_count : null),
    avgReward: round(aggregate.avg_reward),
    medianReturnPct: null,
    avgReturnPct: round(aggregate.avg_return_pct),
    avgMaxReturnPct: round(aggregate.avg_max_return_pct),
    avgMinReturnPct: round(aggregate.avg_min_return_pct),
    globalSampleCount: aggregate.global_sample_count,
    globalHitCount,
    aggregateMode: 'sql',
  }
}

async function main(): Promise<void> {
  if (HORIZONS.length === 0) {
    console.log('physics status eval: no horizons')
    return
  }
  await ensureTables()
  const startDates = new Map<number, string | null>()
  for (const horizon of HORIZONS) {
    startDates.set(horizon, await cutoffDate(horizon))
  }
  const cacheStartDate = [...startDates.values()]
    .filter((value): value is string => value != null)
    .sort()[0] ?? START_DATE
  const evaluationDate = new Date().toISOString().slice(0, 10)
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  if (SKIP_STATUS_CACHE) {
    console.log(`physics status cache skipped: ML_PHYSICS_STATUS_SKIP_CACHE=1, feature_set=${ML_PHYSICS_FEATURE_SET}`)
  } else {
    await populateStatusCache(cacheStartDate)
  }

  for (const horizon of HORIZONS) {
    const startDate = startDates.get(horizon) ?? null
    const horizonStatements: typeof statements = []
    const deleteHorizonStatement = {
      sql: `
        DELETE FROM ml_physics_status_evaluations
        WHERE evaluation_date = ?
          AND feature_set = ?
          AND horizon_days = ?
      `,
      args: [evaluationDate, ML_PHYSICS_FEATURE_SET, horizon],
    }
    if (SQL_AGGREGATE) {
      const { aggregates } = await evaluateHorizonSql(horizon, startDate)
      const total = aggregates.reduce((sum, aggregate) => sum + Number(aggregate.sample_count ?? 0), 0)
      for (const aggregate of aggregates) {
        const m = metricsForSql(aggregate)
        horizonStatements.push({
          sql: `
            INSERT OR REPLACE INTO ml_physics_status_evaluations
              (evaluation_id, evaluation_date, feature_set, status_label, target_direction,
               horizon_days, start_date, end_date, sample_count, hit_count, adverse_count,
               hit_rate, base_rate, lift, confidence_score, median_return_pct, avg_return_pct,
               avg_max_return_pct, avg_min_return_pct, adverse_rate, metrics_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
          `,
          args: [
            `${ML_PHYSICS_FEATURE_SET}_${aggregate.status_label}_h${horizon}_${evaluationDate}`,
            evaluationDate,
            ML_PHYSICS_FEATURE_SET,
            aggregate.status_label,
            aggregate.target_direction,
            horizon,
            aggregate.start_date,
            aggregate.end_date,
            aggregate.sample_count,
            aggregate.hit_count,
            aggregate.adverse_count,
            m.hitRate as number | null,
            m.baseRate as number | null,
            m.lift as number | null,
            m.confidenceScore as number | null,
            null,
            m.avgReturnPct as number | null,
            m.avgMaxReturnPct as number | null,
            m.avgMinReturnPct as number | null,
            m.adverseRate as number | null,
            JSON.stringify(m),
          ],
        })
      }
      console.log(`physics status eval horizon=${horizon}: rows=${total.toLocaleString()}, start=${startDate ?? '-'}, run=${evaluationDate}, mode=sql`)
      await execBatch([deleteHorizonStatement, ...horizonStatements])
      statements.push(...horizonStatements)
      console.log(`physics status eval horizon=${horizon}: saved=${horizonStatements.length}`)
      continue
    }

    const { aggregates, globals } = await evaluateHorizon(horizon, startDate)
    const total = aggregates.reduce((sum, aggregate) => sum + aggregate.sampleCount, 0)
    const nonEmptyAggregates = aggregates.filter((aggregate) => aggregate.sampleCount > 0)
    for (const aggregate of nonEmptyAggregates) {
      const global = globals.get(aggregate.targetDirection) ?? makeGlobal(aggregate.targetDirection, horizon)
      const m = metricsFor(aggregate, global)
      horizonStatements.push({
        sql: `
          INSERT OR REPLACE INTO ml_physics_status_evaluations
            (evaluation_id, evaluation_date, feature_set, status_label, target_direction,
             horizon_days, start_date, end_date, sample_count, hit_count, adverse_count,
             hit_rate, base_rate, lift, confidence_score, median_return_pct, avg_return_pct,
             avg_max_return_pct, avg_min_return_pct, adverse_rate, metrics_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          `${ML_PHYSICS_FEATURE_SET}_${aggregate.statusLabel}_h${horizon}_${evaluationDate}`,
          evaluationDate,
          ML_PHYSICS_FEATURE_SET,
          aggregate.statusLabel,
          aggregate.targetDirection,
          horizon,
          aggregate.startDate,
          aggregate.endDate,
          aggregate.sampleCount,
          aggregate.hitCount,
          aggregate.adverseCount,
          m.hitRate as number | null,
          m.baseRate as number | null,
          m.lift as number | null,
          m.confidenceScore as number | null,
          m.medianReturnPct as number | null,
          m.avgReturnPct as number | null,
          m.avgMaxReturnPct as number | null,
          m.avgMinReturnPct as number | null,
          m.adverseRate as number | null,
          JSON.stringify(m),
        ],
      })
    }
    console.log(`physics status eval horizon=${horizon}: rows=${total.toLocaleString()}, start=${startDate ?? '-'}, run=${evaluationDate}`)
    await execBatch([deleteHorizonStatement, ...horizonStatements])
    statements.push(...horizonStatements)
    console.log(`physics status eval horizon=${horizon}: saved=${horizonStatements.length}`)
  }

  const startSummary = HORIZONS.map((horizon) => `h${horizon}:${startDates.get(horizon) ?? '-'}`).join(',')
  console.log(`physics status eval complete: horizons=${HORIZONS.join('/')}, recent_days=${RECENT_DAYS || 'all'}, starts=${startSummary}, feature_set=${ML_PHYSICS_FEATURE_SET}, cache_skipped=${SKIP_STATUS_CACHE}, mode=${SQL_AGGREGATE ? 'sql' : 'js'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
