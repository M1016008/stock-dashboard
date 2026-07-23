// scripts/batch-ml-physics-features.ts
//
// 1〜2週間のチャート形状判断向けに、SMAの速度・加速度・距離変化を特徴量化する。

import { execAll, execBatch, execRun } from '@/lib/db/client'
import {
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_VERSION,
  physicsFeatureVector,
  type PhysicsFeatureProfile,
  type PhysicsUpperTimeframeProfile,
} from '@/lib/backtest/ml-physics'
import { waitForMemoryHeadroom } from '@/lib/system/memory-guard'
import { resampleOhlcv } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

type Row = {
  date: string
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  volume: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  weekly_ma_5: number | null
  weekly_ma_13: number | null
  weekly_ma_25: number | null
  weekly_ma_50: number | null
  weekly_ma_100: number | null
  monthly_ma_3: number | null
  monthly_ma_5: number | null
  monthly_ma_10: number | null
  monthly_ma_20: number | null
  monthly_ma_25: number | null
}

type TickerMeta = {
  sector17Name: string
  sector33Name: string
}

type MarketContextRow = {
  date: string
  market_return_5: number | null
  market_return_20: number | null
  market_above_sma25_rate: number | null
}

type SectorContextRow = {
  date: string
  sector_type: string
  sector_name: string
  return_5: number | null
  return_20: number | null
  rank_pct: number | null
}

type ContextMaps = {
  market: Map<string, MarketContextRow>
  sector: Map<string, SectorContextRow>
}

type UpperMaSpec = {
  key: string
  label: string
}

type UpperGapSpec = {
  key: string
  shortKey: string
  longKey: string
}

type UpperSeriesMap = Record<string, Array<number | null>>

const CHUNK = Number(process.env.ML_PHYSICS_BATCH_CHUNK ?? 500)
const RECENT_DAYS = Number(process.env.ML_PHYSICS_RECENT_DAYS ?? 0)
const MIN_HISTORY_DAYS = Number(process.env.ML_PHYSICS_MIN_HISTORY_DAYS ?? (RECENT_DAYS > 0 ? 220 : 1))
const START_DATE = process.env.ML_PHYSICS_START_DATE?.trim() || null
const END_DATE = process.env.ML_PHYSICS_END_DATE?.trim() || null
const TICKER_LIMIT = Number(process.env.ML_PHYSICS_TICKER_LIMIT ?? 0)
const TICKER_START = process.env.ML_PHYSICS_TICKER_START?.trim() || null
const TICKER_END = process.env.ML_PHYSICS_TICKER_END?.trim() || null
const ACTIVE_ONLY = process.env.ML_PHYSICS_ACTIVE_ONLY === '1'
const DEFAULT_RECENT_HISTORY_LOOKBACK = Math.max(520, RECENT_DAYS + 260, RECENT_DAYS + MIN_HISTORY_DAYS + 80)
const HISTORY_LOOKBACK_DAYS = Number(process.env.ML_PHYSICS_HISTORY_LOOKBACK_DAYS ?? (RECENT_DAYS > 0 ? DEFAULT_RECENT_HISTORY_LOOKBACK : 0))
const MISSING_ONLY_DATE = process.env.ML_PHYSICS_MISSING_ONLY_DATE?.trim() || null

const WEEKLY_MA_SPECS: UpperMaSpec[] = [
  { key: 'ma5', label: '5週' },
  { key: 'ma13', label: '13週' },
  { key: 'ma25', label: '25週' },
  { key: 'ma50', label: '50週' },
  { key: 'ma100', label: '100週' },
]
const WEEKLY_GAP_SPECS: UpperGapSpec[] = [
  { key: 'ma5To13', shortKey: 'ma5', longKey: 'ma13' },
  { key: 'ma13To25', shortKey: 'ma13', longKey: 'ma25' },
  { key: 'ma25To50', shortKey: 'ma25', longKey: 'ma50' },
]
const MONTHLY_MA_SPECS: UpperMaSpec[] = [
  { key: 'ma3', label: '3か月' },
  { key: 'ma5', label: '5か月' },
  { key: 'ma10', label: '10か月' },
  { key: 'ma20', label: '20か月' },
  { key: 'ma25', label: '25か月' },
]
const MONTHLY_GAP_SPECS: UpperGapSpec[] = [
  { key: 'ma3To5', shortKey: 'ma3', longKey: 'ma5' },
  { key: 'ma5To10', shortKey: 'ma5', longKey: 'ma10' },
  { key: 'ma10To20', shortKey: 'ma10', longKey: 'ma20' },
]
const TWO_DAY_MA_SPECS: UpperMaSpec[] = [
  { key: 'ma5', label: '5本' },
  { key: 'ma25', label: '25本' },
  { key: 'ma75', label: '75本' },
  { key: 'ma200', label: '200本' },
]
const TWO_DAY_GAP_SPECS: UpperGapSpec[] = [
  { key: 'ma5To25', shortKey: 'ma5', longKey: 'ma25' },
  { key: 'ma25To75', shortKey: 'ma25', longKey: 'ma75' },
  { key: 'ma75To200', shortKey: 'ma75', longKey: 'ma200' },
]
const TWO_WEEK_MA_SPECS: UpperMaSpec[] = [
  { key: 'ma5', label: '5本' },
  { key: 'ma13', label: '13本' },
  { key: 'ma25', label: '25本' },
  { key: 'ma50', label: '50本' },
  { key: 'ma100', label: '100本' },
]
const TWO_WEEK_GAP_SPECS: UpperGapSpec[] = [
  { key: 'ma5To13', shortKey: 'ma5', longKey: 'ma13' },
  { key: 'ma13To25', shortKey: 'ma13', longKey: 'ma25' },
  { key: 'ma25To50', shortKey: 'ma25', longKey: 'ma50' },
]
const TWO_MONTH_MA_SPECS: UpperMaSpec[] = [
  { key: 'ma3', label: '3本' },
  { key: 'ma5', label: '5本' },
  { key: 'ma10', label: '10本' },
  { key: 'ma20', label: '20本' },
  { key: 'ma25', label: '25本' },
]
const TWO_MONTH_GAP_SPECS: UpperGapSpec[] = [
  { key: 'ma3To5', shortKey: 'ma3', longKey: 'ma5' },
  { key: 'ma5To10', shortKey: 'ma5', longKey: 'ma10' },
  { key: 'ma10To20', shortKey: 'ma10', longKey: 'ma20' },
]

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

function maOrderFromValues(items: Array<{ label: string; value: number | null | undefined }>): string {
  return items
    .filter((item): item is { label: string; value: number } => finite(item.value))
    .sort((a, b) => b.value - a.value)
    .map((item) => item.label)
    .join(' > ') || '-'
}

function upperGapAt(series: UpperSeriesMap, spec: UpperGapSpec, index: number): number | null {
  return gap(series[spec.shortKey]?.[index], series[spec.longKey]?.[index])
}

function buildUpperTimeframeProfile(
  series: UpperSeriesMap,
  index: number,
  close: number | null | undefined,
  maSpecs: UpperMaSpec[],
  gapSpecs: UpperGapSpec[],
): PhysicsUpperTimeframeProfile {
  const ma: Record<string, number | null> = {}
  const velocities: PhysicsUpperTimeframeProfile['velocities'] = {}
  const accelerations: PhysicsUpperTimeframeProfile['accelerations'] = {}
  const gaps: PhysicsUpperTimeframeProfile['gaps'] = {}
  const gapVelocity: PhysicsUpperTimeframeProfile['gapVelocity'] = {}
  const pricePosition: PhysicsUpperTimeframeProfile['pricePosition'] = {}

  for (const spec of maSpecs) {
    const values = series[spec.key] ?? []
    const current = values[index] ?? null
    ma[spec.key] = current
    velocities[spec.key] = {
      d5: round(pct(values[index - 5], current)),
      d10: round(pct(values[index - 10], current)),
      d21: round(pct(values[index - 21], current)),
    }
    accelerations[spec.key] = {
      d5: round(diff(pct(values[index - 5], current), pct(values[index - 10], values[index - 5]))),
      d21: round(diff(pct(values[index - 21], current), pct(values[index - 42], values[index - 21]))),
    }
    pricePosition[spec.key] = round(pct(current, close))
  }

  for (const spec of gapSpecs) {
    const current = upperGapAt(series, spec, index)
    gaps[`${spec.key}Pct`] = current
    gapVelocity[spec.key] = {
      d5: round(diff(current, upperGapAt(series, spec, index - 5))),
      d21: round(diff(current, upperGapAt(series, spec, index - 21))),
    }
  }

  return {
    maOrder: maOrderFromValues(maSpecs.map((spec) => ({ label: spec.label, value: ma[spec.key] }))),
    ma,
    velocities,
    accelerations,
    gaps,
    gapVelocity,
    pricePosition,
    bundleWidthPct: bundleWidthPct(finite(close) ? close : null, maSpecs.map((spec) => ma[spec.key] ?? null)),
  }
}

function smaOhlcvSeries(rows: OHLCV[], period: number): Array<number | null> {
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

function buildResampledProfilesByDate(
  dailyRows: OHLCV[],
  spec: { timeframe: 'day' | 'week' | 'month'; multiplier: number },
  maSpecs: UpperMaSpec[],
  gapSpecs: UpperGapSpec[],
): Map<string, PhysicsUpperTimeframeProfile> {
  const candles = resampleOhlcv(dailyRows, spec)
  const series: UpperSeriesMap = {}
  for (const maSpec of maSpecs) {
    const period = Number(maSpec.key.replace(/^ma/, ''))
    series[maSpec.key] = Number.isFinite(period) ? smaOhlcvSeries(candles, period) : []
  }
  const map = new Map<string, PhysicsUpperTimeframeProfile>()
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]
    map.set(candle.date, buildUpperTimeframeProfile(series, i, candle.close, maSpecs, gapSpecs))
  }
  return map
}

function alignProfilesToDailyDates(
  rows: Row[],
  profilesByDate: Map<string, PhysicsUpperTimeframeProfile>,
): Array<PhysicsUpperTimeframeProfile | undefined> {
  const out: Array<PhysicsUpperTimeframeProfile | undefined> = []
  let latest: PhysicsUpperTimeframeProfile | undefined
  for (const row of rows) {
    const profile = profilesByDate.get(row.date)
    if (profile) latest = profile
    out.push(latest)
  }
  return out
}

function normalizedOrder(value: string): string {
  return value.replace(/\s/g, '')
}

function isDailyBullish(order: string): boolean {
  return normalizedOrder(order).startsWith('5日>25日')
}

function isDailyBearish(order: string): boolean {
  const normalized = normalizedOrder(order)
  return normalized.startsWith('200日>75日') || normalized.endsWith('25日>5日')
}

function isUpperBullish(order: string, first: string, second: string): boolean {
  return normalizedOrder(order).startsWith(`${first}>${second}`)
}

function isUpperBearish(order: string, first: string, second: string, tailFirst: string, tailSecond: string): boolean {
  const normalized = normalizedOrder(order)
  return normalized.startsWith(`${first}>${second}`) || normalized.endsWith(`${tailFirst}>${tailSecond}`)
}

function ratioScore(values: Array<boolean | null | undefined>): number {
  const valid = values.filter((value): value is boolean => value != null)
  if (valid.length === 0) return 0
  return round(valid.filter(Boolean).length / valid.length, 3) ?? 0
}

function positive(value: number | null | undefined): boolean | null {
  return finite(value) ? value > 0 : null
}

function negative(value: number | null | undefined): boolean | null {
  return finite(value) ? value < 0 : null
}

function buildUpperAlignment(
  dailyOrder: string,
  weekly: PhysicsUpperTimeframeProfile,
  monthly: PhysicsUpperTimeframeProfile,
): NonNullable<PhysicsFeatureProfile['multiTimeframe']>['alignment'] {
  const dailyBullish = isDailyBullish(dailyOrder)
  const dailyBearish = isDailyBearish(dailyOrder)
  const weeklyBullish = isUpperBullish(weekly.maOrder, '5週', '13週')
  const weeklyBearish = isUpperBearish(weekly.maOrder, '100週', '50週', '13週', '5週')
  const monthlyBullish = isUpperBullish(monthly.maOrder, '3か月', '5か月')
  const monthlyBearish = isUpperBearish(monthly.maOrder, '25か月', '20か月', '5か月', '3か月')

  return {
    dailyWeeklyBullish: dailyBullish && weeklyBullish ? 1 : dailyBullish || weeklyBullish ? 0.5 : 0,
    dailyWeeklyBearish: dailyBearish && weeklyBearish ? 1 : dailyBearish || weeklyBearish ? 0.5 : 0,
    weeklyMonthlyBullish: weeklyBullish && monthlyBullish ? 1 : weeklyBullish || monthlyBullish ? 0.5 : 0,
    weeklyMonthlyBearish: weeklyBearish && monthlyBearish ? 1 : weeklyBearish || monthlyBearish ? 0.5 : 0,
    upperSupport: ratioScore([
      weeklyBullish,
      monthlyBullish,
      positive(weekly.pricePosition.ma5),
      positive(weekly.pricePosition.ma13),
      positive(monthly.pricePosition.ma3),
      positive(monthly.pricePosition.ma5),
    ]),
    upperResistance: ratioScore([
      weeklyBearish,
      monthlyBearish,
      negative(weekly.pricePosition.ma5),
      negative(weekly.pricePosition.ma13),
      negative(monthly.pricePosition.ma3),
      negative(monthly.pricePosition.ma5),
    ]),
  }
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
  if (MISSING_ONLY_DATE) {
    const date = MISSING_ONLY_DATE === 'latest'
      ? (await execAll<{ date: string | null }>(`SELECT MAX(date) AS date FROM daily_snapshots`))[0]?.date
      : MISSING_ONLY_DATE
    if (!date) return []
    const where: string[] = [
      `d.date = ?`,
      `f.ticker IS NULL`,
    ]
    const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET, date]
    if (TICKER_START) {
      where.push(`d.ticker >= ?`)
      args.push(TICKER_START)
    }
    if (TICKER_END) {
      where.push(`d.ticker <= ?`)
      args.push(TICKER_END)
    }
    if (ACTIVE_ONLY) {
      where.push(`EXISTS (
        SELECT 1 FROM ticker_universe u
        WHERE u.ticker = d.ticker AND COALESCE(u.active, 1) = 1
      )`)
    }
    args.push(MIN_HISTORY_DAYS)
    const limitSql = TICKER_LIMIT > 0 ? ` LIMIT ${TICKER_LIMIT}` : ''
    const rows = await execAll<{ ticker: string }>(
      `
      SELECT d.ticker
      FROM daily_snapshots d
      LEFT JOIN ml_feature_vectors_v2 f
        ON f.ticker = d.ticker
       AND f.date = d.date
       AND f.feature_set = ?
      WHERE ${where.join(' AND ')}
        AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = d.ticker) >= ?
      ORDER BY d.ticker${limitSql}
      `,
      args,
    )
    return rows.map((row) => row.ticker)
  }

  const where: string[] = []
  const args: string[] = []
  if (TICKER_START) {
    where.push(`o.ticker >= ?`)
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push(`o.ticker <= ?`)
    args.push(TICKER_END)
  }
  if (ACTIVE_ONLY) {
    where.push(`EXISTS (
      SELECT 1 FROM ticker_universe u
      WHERE u.ticker = o.ticker AND COALESCE(u.active, 1) = 1
    )`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limitSql = TICKER_LIMIT > 0 ? ` LIMIT ${TICKER_LIMIT}` : ''
  const rows = await execAll<{ ticker: string }>(
    `SELECT o.ticker FROM ohlcv_daily o ${whereSql} GROUP BY o.ticker ORDER BY o.ticker${limitSql}`,
    args,
  )
  return rows.map((row) => row.ticker)
}

async function tickerMeta(): Promise<Map<string, TickerMeta>> {
  const rows = await execAll<{ ticker: string; sector17_name: string | null; sector33_name: string | null }>(
    `SELECT ticker, sector17_name, sector33_name FROM ticker_universe`,
  )
  return new Map(rows.map((row) => [row.ticker, {
    sector17Name: row.sector17_name?.trim() || '未分類',
    sector33Name: row.sector33_name?.trim() || '未分類',
  }]))
}

async function loadContextMaps(): Promise<ContextMaps> {
  const marketRows = await execAll<MarketContextRow>(
    `SELECT date, market_return_5, market_return_20, market_above_sma25_rate FROM ml_market_context_features`,
  )
  const sectorRows = await execAll<SectorContextRow>(
    `SELECT date, sector_type, sector_name, return_5, return_20, rank_pct FROM ml_sector_context_features`,
  )
  return {
    market: new Map(marketRows.map((row) => [row.date, row])),
    sector: new Map(sectorRows.map((row) => [`${row.date}\t${row.sector_type}\t${row.sector_name}`, row])),
  }
}

async function history(ticker: string): Promise<Row[]> {
  const dateWhere: string[] = [`o.ticker = ?`]
  const args: Array<string | number> = [ticker]
  if (END_DATE) {
    dateWhere.push(`o.date <= ?`)
    args.push(END_DATE)
  }
  if (HISTORY_LOOKBACK_DAYS > 0) {
    return execAll<Row>(
      `
      SELECT *
      FROM (
        SELECT
          o.date,
          o.open,
          o.close,
          o.high,
          o.low,
          o.volume,
          d.daily_a_stage,
          d.daily_b_stage,
          d.weekly_a_stage,
          d.weekly_b_stage,
          d.monthly_a_stage,
          d.monthly_b_stage,
          d.weekly_ma_5,
          d.weekly_ma_13,
          d.weekly_ma_25,
          d.weekly_ma_50,
          d.weekly_ma_100,
          d.monthly_ma_3,
          d.monthly_ma_5,
          d.monthly_ma_10,
          d.monthly_ma_20,
          d.monthly_ma_25
        FROM ohlcv_daily o
        LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
        WHERE ${dateWhere.join(' AND ')}
        ORDER BY o.date DESC
        LIMIT ?
      )
      ORDER BY date
      `,
      [...args, HISTORY_LOOKBACK_DAYS],
    )
  }

  return execAll<Row>(
    `
    SELECT
      o.date,
      o.open,
      o.close,
      o.high,
      o.low,
      o.volume,
      d.daily_a_stage,
      d.daily_b_stage,
      d.weekly_a_stage,
      d.weekly_b_stage,
      d.monthly_a_stage,
      d.monthly_b_stage,
      d.weekly_ma_5,
      d.weekly_ma_13,
      d.weekly_ma_25,
      d.weekly_ma_50,
      d.weekly_ma_100,
      d.monthly_ma_3,
      d.monthly_ma_5,
      d.monthly_ma_10,
      d.monthly_ma_20,
      d.monthly_ma_25
    FROM ohlcv_daily o
    LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
    WHERE o.ticker = ?
    ORDER BY o.date
    `,
    [ticker],
  )
}

async function buildTicker(ticker: string, contexts: ContextMaps, meta: TickerMeta | undefined): Promise<number> {
  const rows = await history(ticker)
  if (rows.length < Math.max(1, MIN_HISTORY_DAYS)) return 0
  const ma5 = smaSeries(rows, 5)
  const ma25 = smaSeries(rows, 25)
  const ma75 = smaSeries(rows, 75)
  const ma200 = smaSeries(rows, 200)
  const weeklySeries: UpperSeriesMap = {
    ma5: rows.map((row) => row.weekly_ma_5),
    ma13: rows.map((row) => row.weekly_ma_13),
    ma25: rows.map((row) => row.weekly_ma_25),
    ma50: rows.map((row) => row.weekly_ma_50),
    ma100: rows.map((row) => row.weekly_ma_100),
  }
  const monthlySeries: UpperSeriesMap = {
    ma3: rows.map((row) => row.monthly_ma_3),
    ma5: rows.map((row) => row.monthly_ma_5),
    ma10: rows.map((row) => row.monthly_ma_10),
    ma20: rows.map((row) => row.monthly_ma_20),
    ma25: rows.map((row) => row.monthly_ma_25),
  }
  const dailyOhlcv: OHLCV[] = rows
    .filter((row) => finite(row.open) && finite(row.high) && finite(row.low) && finite(row.close))
    .map((row) => ({
      date: row.date,
      open: row.open as number,
      high: row.high as number,
      low: row.low as number,
      close: row.close as number,
      volume: finite(row.volume) ? row.volume as number : 0,
    }))
  const twoDayProfiles = alignProfilesToDailyDates(
    rows,
    buildResampledProfilesByDate(dailyOhlcv, { timeframe: 'day', multiplier: 2 }, TWO_DAY_MA_SPECS, TWO_DAY_GAP_SPECS),
  )
  const twoWeekProfiles = alignProfilesToDailyDates(
    rows,
    buildResampledProfilesByDate(dailyOhlcv, { timeframe: 'week', multiplier: 2 }, TWO_WEEK_MA_SPECS, TWO_WEEK_GAP_SPECS),
  )
  const twoMonthProfiles = alignProfilesToDailyDates(
    rows,
    buildResampledProfilesByDate(dailyOhlcv, { timeframe: 'month', multiplier: 2 }, TWO_MONTH_MA_SPECS, TWO_MONTH_GAP_SPECS),
  )
  const stageCodes = rows.map(stageCode)
  const bundleWidths = rows.map((row, i) => bundleWidthPct(row.close, [ma5[i], ma25[i], ma75[i], ma200[i]]))
  const gap5To25 = rows.map((_, i) => gap(ma5[i], ma25[i]))
  const gap25To75 = rows.map((_, i) => gap(ma25[i], ma75[i]))
  const gap75To200 = rows.map((_, i) => gap(ma75[i], ma200[i]))

  const daysAbove5: number[] = []
  const daysAbove25: number[] = []
  let above5 = 0
  let above25 = 0
  const stageCodeAges: number[] = []
  const dailyAAges: number[] = []
  const dailyBAges: number[] = []
  const daysSinceCrossUp5: Array<number | null> = []
  const daysSinceTouch25: Array<number | null> = []
  let stageAge = 0
  let dailyAAge = 0
  let dailyBAge = 0
  let lastStageCode: string | null = null
  let lastDailyA: number | null = null
  let lastDailyB: number | null = null
  let lastCrossUp5Index: number | null = null
  let lastTouch25Index: number | null = null
  for (let i = 0; i < rows.length; i += 1) {
    above5 = finite(rows[i].close) && finite(ma5[i]) && rows[i].close! >= ma5[i]! ? above5 + 1 : 0
    above25 = finite(rows[i].close) && finite(ma25[i]) && rows[i].close! >= ma25[i]! ? above25 + 1 : 0
    daysAbove5[i] = above5
    daysAbove25[i] = above25
    stageAge = stageCodes[i] === lastStageCode ? stageAge + 1 : 1
    dailyAAge = rows[i].daily_a_stage === lastDailyA ? dailyAAge + 1 : 1
    dailyBAge = rows[i].daily_b_stage === lastDailyB ? dailyBAge + 1 : 1
    lastStageCode = stageCodes[i]
    lastDailyA = rows[i].daily_a_stage
    lastDailyB = rows[i].daily_b_stage
    stageCodeAges[i] = stageAge
    dailyAAges[i] = dailyAAge
    dailyBAges[i] = dailyBAge
    if (crossUp(rows[i], rows[i - 1], ma5[i], ma5[i - 1])) lastCrossUp5Index = i
    if (touch(rows[i], ma25[i])) lastTouch25Index = i
    daysSinceCrossUp5[i] = lastCrossUp5Index == null ? null : i - lastCrossUp5Index
    daysSinceTouch25[i] = lastTouch25Index == null ? null : i - lastTouch25Index
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
    const marketContext = contexts.market.get(row.date)
    const sector17Context = contexts.sector.get(`${row.date}\t17\t${meta?.sector17Name ?? '未分類'}`)
    const sector33Context = contexts.sector.get(`${row.date}\t33\t${meta?.sector33Name ?? '未分類'}`)
    const weeklyProfile = buildUpperTimeframeProfile(weeklySeries, i, row.close, WEEKLY_MA_SPECS, WEEKLY_GAP_SPECS)
    const monthlyProfile = buildUpperTimeframeProfile(monthlySeries, i, row.close, MONTHLY_MA_SPECS, MONTHLY_GAP_SPECS)

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
      context: {
        marketReturn5: marketContext?.market_return_5 ?? null,
        marketReturn20: marketContext?.market_return_20 ?? null,
        marketAboveSma25Rate: marketContext?.market_above_sma25_rate ?? null,
        sector17Return5: sector17Context?.return_5 ?? null,
        sector17RankPct: sector17Context?.rank_pct ?? null,
        sector33Return5: sector33Context?.return_5 ?? null,
        sector33RankPct: sector33Context?.rank_pct ?? null,
      },
      timeSince: {
        stageCodeAge: stageCodeAges[i] ?? null,
        dailyAStageAge: dailyAAges[i] ?? null,
        dailyBStageAge: dailyBAges[i] ?? null,
        daysSinceCrossUpSma5: daysSinceCrossUp5[i] ?? null,
        daysSinceTouchSma25: daysSinceTouch25[i] ?? null,
      },
      multiTimeframe: {
        weekly: weeklyProfile,
        monthly: monthlyProfile,
        twoDay: twoDayProfiles[i],
        twoWeek: twoWeekProfiles[i],
        twoMonth: twoMonthProfiles[i],
        alignment: buildUpperAlignment(order, weeklyProfile, monthlyProfile),
      },
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
  const [codes, contexts, metaByTicker] = await Promise.all([tickers(), loadContextMaps(), tickerMeta()])
  let featureCount = 0
  const started = Date.now()
  console.log(
    `ml physics features: tickers=${codes.length}, recent_days=${RECENT_DAYS || 'all'}, min_history_days=${MIN_HISTORY_DAYS}, history_lookback_days=${HISTORY_LOOKBACK_DAYS || 'all'}, missing_only_date=${MISSING_ONLY_DATE ?? '-'}, active_only=${ACTIVE_ONLY ? 'on' : 'off'}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}`,
  )
  if (TICKER_START || TICKER_END) console.log(`ml physics ticker range: ${TICKER_START ?? '-'}..${TICKER_END ?? '-'}`)
  for (const [index, ticker] of codes.entries()) {
    if (index > 0 && index % 100 === 0) {
      await waitForMemoryHeadroom({ label: `ml physics features ${index}/${codes.length}` })
    }
    featureCount += await buildTicker(ticker, contexts, metaByTicker.get(ticker))
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
