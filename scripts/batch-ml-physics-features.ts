// scripts/batch-ml-physics-features.ts
//
// 1〜2週間のチャート形状判断向けに、SMAの速度・加速度・距離変化を特徴量化する。

import { execAll, execBatch, execRun } from '@/lib/db/client'
import {
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_VERSION,
  physicsFeatureVector,
  type PhysicsFeatureProfile,
} from '@/lib/backtest/ml-physics'

type Row = {
  date: string
  close: number | null
  high: number | null
  low: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

const CHUNK = Number(process.env.ML_PHYSICS_BATCH_CHUNK ?? 500)
const RECENT_DAYS = Number(process.env.ML_PHYSICS_RECENT_DAYS ?? 260)
const MIN_HISTORY_DAYS = Number(process.env.ML_PHYSICS_MIN_HISTORY_DAYS ?? (RECENT_DAYS > 0 ? 220 : 1))
const START_DATE = process.env.ML_PHYSICS_START_DATE?.trim() || null
const END_DATE = process.env.ML_PHYSICS_END_DATE?.trim() || null
const TICKER_LIMIT = Number(process.env.ML_PHYSICS_TICKER_LIMIT ?? 0)
const TICKER_START = process.env.ML_PHYSICS_TICKER_START?.trim() || null
const TICKER_END = process.env.ML_PHYSICS_TICKER_END?.trim() || null

function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function pct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (!finite(from) || !finite(to) || from === 0) return null
  return ((to - from) / from) * 100
}

function diff(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (!finite(current) || !finite(previous)) return null
  return current - previous
}

function stageCode(row: Row): string {
  return [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ].map((value) => value == null ? '-' : String(value)).join('')
}

function smaSeries(rows: Row[], period: number): Array<number | null> {
  const out: Array<number | null> = []
  let sum = 0
  let valid = 0
  for (let i = 0; i < rows.length; i += 1) {
    const close = rows[i]?.close
    if (finite(close)) {
      sum += close
      valid += 1
    }
    if (i >= period) {
      const oldClose = rows[i - period]?.close
      if (finite(oldClose)) {
        sum -= oldClose
        valid -= 1
      }
    }
    out.push(i >= period - 1 && valid === period ? round(sum / period, 2) : null)
  }
  return out
}

function maOrder(sma: PhysicsFeatureProfile['sma']): string {
  return [
    { label: '5日', value: sma.sma5 },
    { label: '25日', value: sma.sma25 },
    { label: '75日', value: sma.sma75 },
    { label: '200日', value: sma.sma200 },
  ].filter((item): item is { label: string; value: number } => finite(item.value))
    .sort((a, b) => b.value - a.value)
    .map((item) => item.label)
    .join(' > ') || '-'
}

function extrema(rows: Row[], from: number, to: number, type: 'high' | 'low'): { date: string | null; value: number | null } {
  let date: string | null = null
  let value: number | null = null
  for (let i = Math.max(0, from); i <= Math.min(rows.length - 1, to); i += 1) {
    const current = type === 'high' ? rows[i]?.high : rows[i]?.low
    if (!finite(current)) continue
    if (value == null || (type === 'high' ? current > value : current < value)) {
      value = current
      date = rows[i].date
    }
  }
  return { date, value }
}

function gap(short: number | null | undefined, long: number | null | undefined): number | null {
  return round(pct(long, short))
}

function bundleWidthPct(close: number | null, values: Array<number | null>): number | null {
  const valid = values.filter(finite)
  if (valid.length < 2 || !finite(close) || close === 0) return null
  return round(((Math.max(...valid) - Math.min(...valid)) / close) * 100)
}

function touch(row: Row, sma: number | null): boolean {
  return finite(sma) && finite(row.low) && finite(row.high) && row.low <= sma && row.high >= sma
}

function crossUp(row: Row, prev: Row | undefined, sma: number | null, prevSma: number | null): boolean {
  return finite(row.close) && finite(prev?.close) && finite(sma) && finite(prevSma) && prev!.close! <= prevSma && row.close > sma
}

function crossDown(row: Row, prev: Row | undefined, sma: number | null, prevSma: number | null): boolean {
  return finite(row.close) && finite(prev?.close) && finite(sma) && finite(prevSma) && prev!.close! >= prevSma && row.close < sma
}

function classifyRegimes(args: {
  maOrder: string
  sma5Velocity5: number | null
  sma25Velocity5: number | null
  sma5Acceleration5: number | null
  sma25Acceleration5: number | null
  gap5To25: number | null
  gap5To25Velocity5: number | null
  bundleWidthVelocity5: number | null
  priceToSma5: number | null
  priceToSma25: number | null
  crossUpSma5: boolean
  crossDownSma5: boolean
}): PhysicsFeatureProfile['regimes'] {
  const order = args.maOrder.replace(/\s/g, '')
  const bullishOrder = order.startsWith('5日>25日')
  const bearishOrder = order.startsWith('200日>75日') || order.endsWith('25日>5日')
  const trend =
    (args.sma5Velocity5 ?? 0) > 0.8 && (args.sma25Velocity5 ?? 0) > 0.25 && (args.sma5Acceleration5 ?? 0) > 0
      ? 'up_acceleration'
      : (args.sma5Velocity5 ?? 0) > 0.2 && (args.sma5Acceleration5 ?? 0) < -0.2
        ? 'up_deceleration'
        : (args.sma5Velocity5 ?? 0) < -0.8 && (args.sma25Velocity5 ?? 0) < -0.2 && (args.sma5Acceleration5 ?? 0) < 0
          ? 'down_acceleration'
          : (args.sma5Velocity5 ?? 0) < -0.2 && (args.sma5Acceleration5 ?? 0) > 0.2
            ? 'down_deceleration'
            : 'sideways'
  const spread =
    (args.bundleWidthVelocity5 ?? 0) < -1.5
      ? 'compression'
      : bullishOrder && (args.gap5To25 ?? 0) > 0 && (args.gap5To25Velocity5 ?? 0) > 0.4
        ? 'up_expansion'
        : bearishOrder && (args.gap5To25 ?? 0) < 0 && (args.gap5To25Velocity5 ?? 0) < -0.4
          ? 'down_expansion'
          : 'neutral'
  const turn =
    args.crossUpSma5 && (args.sma25Acceleration5 ?? 0) > 0
      ? 'bullish_turn'
      : args.crossDownSma5 && (args.sma25Acceleration5 ?? 0) < 0
        ? 'bearish_turn'
        : (args.priceToSma25 ?? 0) > -3 && (args.priceToSma5 ?? 0) > 0 && (args.sma5Acceleration5 ?? 0) > 0
          ? 'rebound_watch'
          : (args.priceToSma25 ?? 0) < 3 && (args.priceToSma5 ?? 0) < 0 && (args.sma5Acceleration5 ?? 0) < 0
            ? 'breakdown_watch'
            : 'none'
  return { trend, spread, turn }
}

async function tickers(): Promise<string[]> {
  const where: string[] = []
  const args: string[] = []
  if (TICKER_START) {
    where.push(`ticker >= ?`)
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push(`ticker <= ?`)
    args.push(TICKER_END)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limitSql = TICKER_LIMIT > 0 ? ` LIMIT ${TICKER_LIMIT}` : ''
  const rows = await execAll<{ ticker: string }>(
    `SELECT ticker FROM ohlcv_daily ${whereSql} GROUP BY ticker ORDER BY ticker${limitSql}`,
    args,
  )
  return rows.map((row) => row.ticker)
}

async function history(ticker: string): Promise<Row[]> {
  return execAll<Row>(
    `
    SELECT
      o.date,
      o.close,
      o.high,
      o.low,
      d.daily_a_stage,
      d.daily_b_stage,
      d.weekly_a_stage,
      d.weekly_b_stage,
      d.monthly_a_stage,
      d.monthly_b_stage
    FROM ohlcv_daily o
    LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
    WHERE o.ticker = ?
    ORDER BY o.date
    `,
    [ticker],
  )
}

async function buildTicker(ticker: string): Promise<number> {
  const rows = await history(ticker)
  if (rows.length < Math.max(1, MIN_HISTORY_DAYS)) return 0
  const ma5 = smaSeries(rows, 5)
  const ma25 = smaSeries(rows, 25)
  const ma75 = smaSeries(rows, 75)
  const ma200 = smaSeries(rows, 200)
  const stageCodes = rows.map(stageCode)
  const bundleWidths = rows.map((row, i) => bundleWidthPct(row.close, [ma5[i], ma25[i], ma75[i], ma200[i]]))
  const gap5To25 = rows.map((_, i) => gap(ma5[i], ma25[i]))
  const gap25To75 = rows.map((_, i) => gap(ma25[i], ma75[i]))
  const gap75To200 = rows.map((_, i) => gap(ma75[i], ma200[i]))

  const daysAbove5: number[] = []
  const daysAbove25: number[] = []
  let above5 = 0
  let above25 = 0
  for (let i = 0; i < rows.length; i += 1) {
    above5 = finite(rows[i].close) && finite(ma5[i]) && rows[i].close! >= ma5[i]! ? above5 + 1 : 0
    above25 = finite(rows[i].close) && finite(ma25[i]) && rows[i].close! >= ma25[i]! ? above25 + 1 : 0
    daysAbove5[i] = above5
    daysAbove25[i] = above25
  }

  const minHistoryIndex = Math.max(0, MIN_HISTORY_DAYS - 1)
  const recentIndex = RECENT_DAYS > 0 ? Math.max(minHistoryIndex, rows.length - RECENT_DAYS) : minHistoryIndex
  const startDateIndex = START_DATE ? rows.findIndex((row) => row.date >= START_DATE) : -1
  const firstIndex = Math.max(recentIndex, startDateIndex >= 0 ? startDateIndex : 0)
  const stmts: Array<{ sql: string; args: Array<string | number | null> }> = []

  for (let i = firstIndex; i < rows.length; i += 1) {
    const row = rows[i]
    if (END_DATE && row.date > END_DATE) break
    const sma = { sma5: ma5[i] ?? null, sma25: ma25[i] ?? null, sma75: ma75[i] ?? null, sma200: ma200[i] ?? null }
    const order = maOrder(sma)
    const priorHigh = extrema(rows, i - 60, i - 1, 'high')
    const recentHigh = extrema(rows, i - 60, i, 'high')
    const priorLow = extrema(rows, i - 60, i - 1, 'low')
    const recentLow = extrema(rows, i - 60, i, 'low')
    const crossUpSma5 = crossUp(row, rows[i - 1], ma5[i], ma5[i - 1])
    const crossDownSma5 = crossDown(row, rows[i - 1], ma5[i], ma5[i - 1])
    const sma5Velocity5 = round(pct(ma5[i - 5], ma5[i]))
    const sma25Velocity5 = round(pct(ma25[i - 5], ma25[i]))
    const sma5Acceleration5 = round(diff(pct(ma5[i - 5], ma5[i]), pct(ma5[i - 10], ma5[i - 5])))
    const sma25Acceleration5 = round(diff(pct(ma25[i - 5], ma25[i]), pct(ma25[i - 10], ma25[i - 5])))
    const gap5Velocity5 = round(diff(gap5To25[i], gap5To25[i - 5]))
    const bundleWidthVelocity5 = round(diff(bundleWidths[i], bundleWidths[i - 5]))
    const priceToSma5 = round(pct(ma5[i], row.close))
    const priceToSma25 = round(pct(ma25[i], row.close))

    const profile: PhysicsFeatureProfile = {
      ticker,
      date: row.date,
      close: row.close,
      high: row.high,
      low: row.low,
      stageCode: stageCodes[i],
      prevStageCode: i > 0 ? stageCodes[i - 1] : null,
      maOrder: order,
      sma,
      velocities: {
        sma5: { d1: round(pct(ma5[i - 1], ma5[i])), d3: round(pct(ma5[i - 3], ma5[i])), d5: sma5Velocity5, d10: round(pct(ma5[i - 10], ma5[i])) },
        sma25: { d1: round(pct(ma25[i - 1], ma25[i])), d3: round(pct(ma25[i - 3], ma25[i])), d5: sma25Velocity5, d10: round(pct(ma25[i - 10], ma25[i])) },
        sma75: { d1: round(pct(ma75[i - 1], ma75[i])), d3: round(pct(ma75[i - 3], ma75[i])), d5: round(pct(ma75[i - 5], ma75[i])), d10: round(pct(ma75[i - 10], ma75[i])) },
        sma200: { d1: round(pct(ma200[i - 1], ma200[i])), d3: round(pct(ma200[i - 3], ma200[i])), d5: round(pct(ma200[i - 5], ma200[i])), d10: round(pct(ma200[i - 10], ma200[i])) },
      },
      accelerations: {
        sma5: { d5: sma5Acceleration5, d10: round(diff(pct(ma5[i - 10], ma5[i]), pct(ma5[i - 20], ma5[i - 10]))) },
        sma25: { d5: sma25Acceleration5, d10: round(diff(pct(ma25[i - 10], ma25[i]), pct(ma25[i - 20], ma25[i - 10]))) },
        sma75: { d5: round(diff(pct(ma75[i - 5], ma75[i]), pct(ma75[i - 10], ma75[i - 5]))), d10: round(diff(pct(ma75[i - 10], ma75[i]), pct(ma75[i - 20], ma75[i - 10]))) },
        sma200: { d5: round(diff(pct(ma200[i - 5], ma200[i]), pct(ma200[i - 10], ma200[i - 5]))), d10: round(diff(pct(ma200[i - 10], ma200[i]), pct(ma200[i - 20], ma200[i - 10]))) },
      },
      gaps: {
        sma5To25Pct: gap5To25[i],
        sma25To75Pct: gap25To75[i],
        sma75To200Pct: gap75To200[i],
      },
      gapVelocity: {
        sma5To25D5: gap5Velocity5,
        sma25To75D5: round(diff(gap25To75[i], gap25To75[i - 5])),
        sma75To200D5: round(diff(gap75To200[i], gap75To200[i - 5])),
        sma5To25D10: round(diff(gap5To25[i], gap5To25[i - 10])),
        sma25To75D10: round(diff(gap25To75[i], gap25To75[i - 10])),
        sma75To200D10: round(diff(gap75To200[i], gap75To200[i - 10])),
      },
      gapAcceleration: {
        sma5To25D5: round(diff(diff(gap5To25[i], gap5To25[i - 5]), diff(gap5To25[i - 5], gap5To25[i - 10]))),
        sma25To75D5: round(diff(diff(gap25To75[i], gap25To75[i - 5]), diff(gap25To75[i - 5], gap25To75[i - 10]))),
      },
      pricePosition: {
        sma5: priceToSma5,
        sma25: priceToSma25,
        sma75: round(pct(ma75[i], row.close)),
        sma200: round(pct(ma200[i], row.close)),
      },
      priceVelocity: {
        d1: round(pct(rows[i - 1]?.close, row.close)),
        d3: round(pct(rows[i - 3]?.close, row.close)),
        d5: round(pct(rows[i - 5]?.close, row.close)),
        d10: round(pct(rows[i - 10]?.close, row.close)),
      },
      priceAcceleration: {
        d3: round(diff(pct(rows[i - 3]?.close, row.close), pct(rows[i - 6]?.close, rows[i - 3]?.close))),
        d5: round(diff(pct(rows[i - 5]?.close, row.close), pct(rows[i - 10]?.close, rows[i - 5]?.close))),
      },
      bundleWidthPct: bundleWidths[i],
      bundleWidthVelocity5,
      bundleWidthVelocity10: round(diff(bundleWidths[i], bundleWidths[i - 10])),
      daysAboveSma5: daysAbove5[i] || null,
      daysAboveSma25: daysAbove25[i] || null,
      crosses: {
        upSma5: crossUpSma5,
        downSma5: crossDownSma5,
        upSma25: crossUp(row, rows[i - 1], ma25[i], ma25[i - 1]),
        downSma25: crossDown(row, rows[i - 1], ma25[i], ma25[i - 1]),
      },
      touches: {
        sma5: touch(row, ma5[i]),
        sma25: touch(row, ma25[i]),
        sma75: touch(row, ma75[i]),
        sma200: touch(row, ma200[i]),
      },
      recentHighDate: recentHigh.date,
      recentHigh: recentHigh.value,
      distanceToRecentHighPct: round(pct(recentHigh.value, row.close)),
      recentLowDate: recentLow.date,
      recentLow: recentLow.value,
      distanceToRecentLowPct: round(pct(recentLow.value, row.close)),
      brokeRecentHigh: finite(priorHigh.value) && finite(row.close) ? row.close > priorHigh.value : false,
      brokeRecentLow: finite(priorLow.value) && finite(row.close) ? row.close < priorLow.value : false,
      regimes: classifyRegimes({
        maOrder: order,
        sma5Velocity5,
        sma25Velocity5,
        sma5Acceleration5,
        sma25Acceleration5,
        gap5To25: gap5To25[i],
        gap5To25Velocity5: gap5Velocity5,
        bundleWidthVelocity5,
        priceToSma5,
        priceToSma25,
        crossUpSma5,
        crossDownSma5,
      }),
    }
    const vector = physicsFeatureVector(profile)
    stmts.push({
      sql: `
        INSERT OR REPLACE INTO ml_feature_vectors_v2
          (ticker, date, feature_set, version, stage_code, feature_json, vector_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [ticker, row.date, ML_PHYSICS_FEATURE_SET, ML_PHYSICS_VERSION, profile.stageCode, JSON.stringify(profile), JSON.stringify(vector)],
    })
  }

  for (let i = 0; i < stmts.length; i += CHUNK) await execBatch(stmts.slice(i, i + CHUNK))
  return stmts.length
}

async function main() {
  await execRun(`DELETE FROM ml_feature_vectors_v2 WHERE feature_set = ? AND 1 = 0`, [ML_PHYSICS_FEATURE_SET])
  const codes = await tickers()
  let featureCount = 0
  const started = Date.now()
  console.log(
    `ml physics features: tickers=${codes.length}, recent_days=${RECENT_DAYS || 'all'}, min_history_days=${MIN_HISTORY_DAYS}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}`,
  )
  if (TICKER_START || TICKER_END) console.log(`ml physics ticker range: ${TICKER_START ?? '-'}..${TICKER_END ?? '-'}`)
  for (const [index, ticker] of codes.entries()) {
    featureCount += await buildTicker(ticker)
    if ((index + 1) % 100 === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`ml physics ${index + 1}/${codes.length}: features=${featureCount.toLocaleString()} elapsed=${elapsed}m`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

