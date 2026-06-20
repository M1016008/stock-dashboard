// scripts/batch-ml-physics-status-evaluate.ts
//
// Physical Momentum の状態ラベルを、過去の forward extrema / ml_short_labels で
// 日次に客観検証する。これはオンライン強化学習ではなく、未来情報を現在の候補生成へ
// 直接混ぜない offline calibration として扱う。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
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

const HORIZONS = (process.env.ML_PHYSICS_STATUS_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const RECENT_DAYS = Number(process.env.ML_PHYSICS_STATUS_RECENT_DAYS ?? 1560)
const START_DATE = process.env.ML_PHYSICS_STATUS_START_DATE?.trim() || null
const END_DATE = process.env.ML_PHYSICS_STATUS_END_DATE?.trim() || null
const PAGE_DATES = Math.max(1, Number(process.env.ML_PHYSICS_STATUS_PAGE_DATES ?? 20))
const LIMIT_ROWS = Math.max(0, Number(process.env.ML_PHYSICS_STATUS_LIMIT_ROWS ?? 0))

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

async function cutoffDate(): Promise<string | null> {
  if (START_DATE || RECENT_DAYS <= 0) return START_DATE
  const latest = END_DATE ?? (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    HORIZONS,
  ))?.date ?? null
  if (!latest) return null
  return (await execGet<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM ml_short_labels
      WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})
        AND date <= ?
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [...HORIZONS, latest, RECENT_DAYS],
  ))?.date ?? null
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
      f.feature_json
    FROM ml_short_labels l
    INNER JOIN ml_feature_vectors_v2 f
      ON f.ticker = l.ticker
     AND f.date = l.date
     AND f.feature_set = ?
    WHERE l.horizon_days = ?
      AND l.date IN (${placeholders})
    ORDER BY l.date DESC, l.ticker
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
      const profile = parseJson<Partial<PhysicsFeatureProfile> | null>(row.feature_json, null)
      const analysis = analyzePhysicsProfile(profile)
      const aggregate = aggregates.get(analysis.physicsStatus)
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

async function main(): Promise<void> {
  if (HORIZONS.length === 0) {
    console.log('physics status eval: no horizons')
    return
  }
  await ensureTables()
  const startDate = await cutoffDate()
  const evaluationDate = new Date().toISOString().slice(0, 10)
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []

  await execRun(
    `
    DELETE FROM ml_physics_status_evaluations
    WHERE evaluation_date = ?
      AND feature_set = ?
      AND horizon_days IN (${HORIZONS.map(() => '?').join(', ')})
    `,
    [evaluationDate, ML_PHYSICS_FEATURE_SET, ...HORIZONS],
  )

  for (const horizon of HORIZONS) {
    const { aggregates, globals } = await evaluateHorizon(horizon, startDate)
    for (const aggregate of aggregates) {
      const global = globals.get(aggregate.targetDirection) ?? makeGlobal(aggregate.targetDirection, horizon)
      const m = metricsFor(aggregate, global)
      statements.push({
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
    const total = aggregates.reduce((sum, aggregate) => sum + aggregate.sampleCount, 0)
    console.log(`physics status eval horizon=${horizon}: rows=${total.toLocaleString()}, start=${startDate ?? '-'}, run=${evaluationDate}`)
  }

  await execBatch(statements)
  console.log(`physics status eval complete: horizons=${HORIZONS.join('/')}, recent_days=${RECENT_DAYS || 'all'}, start=${startDate ?? '-'}, feature_set=${ML_PHYSICS_FEATURE_SET}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
