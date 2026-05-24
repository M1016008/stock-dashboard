// scripts/batch-technical-signals.ts
//
// 日足・週足 MA シグナル、複合シグナル、ML/RL 用 model_features を生成する。

import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  deriveCompositeSignals,
  evaluateMaSignals,
  patternCode,
  type SignalRecord,
} from '@/lib/backtest/signals'

type DailyRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type WeeklyRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma_5: number | null
  ma_13: number | null
  ma_25: number | null
}

type FeatureRow = {
  ticker: string
  date: string
  pattern_code: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma5_pos_pct: number | null
  ma25_pos_pct: number | null
  ma75_pos_pct: number | null
  ma_spread_pct: number | null
  rel_strength_20: number | null
  signal_codes: string
  feature_json: string
}

const DAILY_MAS = [5, 25, 75] as const
const WEEKLY_MAS = [5, 13, 25] as const
const CHUNK = 80
const PROGRESS_EVERY = 100
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || !Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

function pct(numerator: number | null, denominator: number | null): number | null {
  const ratio = safeRatio(numerator, denominator)
  return ratio == null ? null : (ratio - 1) * 100
}

function ratioPct(numerator: number | null, denominator: number | null): number | null {
  const ratio = safeRatio(numerator, denominator)
  return ratio == null ? null : ratio * 100
}

function average(values: Array<number | null | undefined>): number | null {
  const xs = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (xs.length === 0) return null
  return xs.reduce((sum, value) => sum + value, 0) / xs.length
}

function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values)
}

async function tickers(): Promise<string[]> {
  const filter = process.env.TICKERS?.split(',').map((value) => value.trim()).filter(Boolean)
  if (filter && filter.length > 0) return filter
  const rows = await execAll<{ ticker: string }>(`SELECT ticker FROM ticker_universe WHERE active = 1 ORDER BY ticker`)
  return rows.map((row) => row.ticker)
}

async function latestModelFeatureDate(ticker: string): Promise<string | null> {
  const row = await execGet<{ maxDate: string | null }>(
    `SELECT MAX(date) AS maxDate FROM model_features WHERE ticker = ?`,
    [ticker],
  )
  return row?.maxDate ?? null
}

function computeDailySignals(ticker: string, rows: DailyRow[], startIndex: number): Map<string, SignalRecord[]> {
  const byDate = new Map<string, SignalRecord[]>()
  for (let i = Math.max(1, startIndex); i < rows.length; i++) {
    const row = rows[i]
    const prev = rows[i - 1]
    const signals: SignalRecord[] = []
    for (const ma of DAILY_MAS) {
      signals.push(...evaluateMaSignals({
        ticker,
        date: row.date,
        timescale: 'daily',
        maPeriod: ma,
        prevClose: prev.close,
        prevMa: prev[`ma_${ma}` as keyof DailyRow] as number | null,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        ma: row[`ma_${ma}` as keyof DailyRow] as number | null,
      }))
    }
    byDate.set(row.date, signals)
  }
  return byDate
}

function computeWeeklySignals(ticker: string, rows: WeeklyRow[]): Map<string, SignalRecord[]> {
  const byDate = new Map<string, SignalRecord[]>()
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const prev = rows[i - 1]
    const signals: SignalRecord[] = []
    for (const ma of WEEKLY_MAS) {
      signals.push(...evaluateMaSignals({
        ticker,
        date: row.date,
        timescale: 'weekly',
        maPeriod: ma,
        prevClose: prev.close,
        prevMa: prev[`ma_${ma}` as keyof WeeklyRow] as number | null,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        ma: row[`ma_${ma}` as keyof WeeklyRow] as number | null,
      }))
    }
    byDate.set(row.date, signals)
  }
  return byDate
}

function latestWeeklySignals(weeklyByDate: Map<string, SignalRecord[]>, date: string): SignalRecord[] {
  let latest = ''
  for (const key of weeklyByDate.keys()) {
    if (key <= date && key > latest) latest = key
  }
  return latest ? weeklyByDate.get(latest) ?? [] : []
}

function trueRange(row: DailyRow, prev: DailyRow | undefined): number {
  if (!prev) return row.high - row.low
  return Math.max(row.high - row.low, Math.abs(row.high - prev.close), Math.abs(row.low - prev.close))
}

function buildFeatures(
  ticker: string,
  rows: DailyRow[],
  dailyByDate: Map<string, SignalRecord[]>,
  weeklyByDate: Map<string, SignalRecord[]>,
  startIndex: number,
): { features: FeatureRow[]; compositeSignals: SignalRecord[] } {
  const features: FeatureRow[] = []
  const compositeSignals: SignalRecord[] = []

  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i]
    const prev = rows[i - 1]
    const trailing20 = rows.slice(Math.max(0, i - 19), i + 1)
    const trailing60 = rows.slice(Math.max(0, i - 59), i + 1)
    const prev60 = rows.slice(Math.max(0, i - 60), i)
    const avgVolume20 = average(trailing20.map((bar) => bar.volume))
    const rangePct = ratioPct(row.high - row.low, row.close)
    const avgRange20Pct = average(trailing20.map((bar) => ratioPct(bar.high - bar.low, bar.close)))
    const atr20 = average(trailing20.map((bar, offset) => trueRange(bar, rows[Math.max(0, i - 19) + offset - 1])))
    const atr20Pct = ratioPct(atr20, row.close)
    const high60 = max(trailing60.map((bar) => bar.high))
    const prevHigh60 = max(prev60.map((bar) => bar.high))
    const volumeRatio20 = safeRatio(row.volume, avgVolume20)
    const ma5PosPct = pct(row.close, row.ma_5)
    const ma25PosPct = pct(row.close, row.ma_25)
    const ma75PosPct = pct(row.close, row.ma_75)
    const maValues = [row.ma_5, row.ma_25, row.ma_75].filter((value): value is number => value != null && Number.isFinite(value))
    const maSpreadPct = maValues.length >= 2 && row.close > 0
      ? ((Math.max(...maValues) - Math.min(...maValues)) / row.close) * 100
      : null

    const dailySignals = dailyByDate.get(row.date) ?? []
    const weeklySignals = latestWeeklySignals(weeklyByDate, row.date)
    const composites = deriveCompositeSignals({
      ticker,
      date: row.date,
      close: row.close,
      high: row.high,
      low: row.low,
      volume: row.volume,
      avgVolume20,
      rangePct,
      avgRange20Pct,
      atr20Pct,
      ma5PosPct,
      ma25PosPct,
      ma75PosPct,
      maSpreadPct,
      high60,
      prevHigh60,
      dailyAStage: row.daily_a_stage,
      dailyBStage: row.daily_b_stage,
      weeklyAStage: row.weekly_a_stage,
      weeklyBStage: row.weekly_b_stage,
      monthlyAStage: row.monthly_a_stage,
      monthlyBStage: row.monthly_b_stage,
      prevDailyAStage: prev?.daily_a_stage ?? null,
      prevDailyBStage: prev?.daily_b_stage ?? null,
      dailySignalCodes: dailySignals.map((signal) => signal.signalCode),
      weeklySignalCodes: weeklySignals.map((signal) => signal.signalCode),
    })
    compositeSignals.push(...composites)

    const codes = Array.from(new Set([
      ...dailySignals,
      ...weeklySignals,
      ...composites,
    ].map((signal) => signal.signalCode))).sort()

    const pcode = patternCode({
      dailyAStage: row.daily_a_stage,
      dailyBStage: row.daily_b_stage,
      weeklyAStage: row.weekly_a_stage,
      weeklyBStage: row.weekly_b_stage,
      monthlyAStage: row.monthly_a_stage,
      monthlyBStage: row.monthly_b_stage,
    })

    features.push({
      ticker,
      date: row.date,
      pattern_code: pcode,
      daily_a_stage: row.daily_a_stage,
      daily_b_stage: row.daily_b_stage,
      weekly_a_stage: row.weekly_a_stage,
      weekly_b_stage: row.weekly_b_stage,
      monthly_a_stage: row.monthly_a_stage,
      monthly_b_stage: row.monthly_b_stage,
      close: row.close,
      volume: row.volume,
      volume_ratio_20: volumeRatio20,
      range_pct: rangePct,
      atr20_pct: atr20Pct,
      ma5_pos_pct: ma5PosPct,
      ma25_pos_pct: ma25PosPct,
      ma75_pos_pct: ma75PosPct,
      ma_spread_pct: maSpreadPct,
      rel_strength_20: null,
      signal_codes: codes.join(','),
      feature_json: JSON.stringify({
        avgVolume20,
        avgRange20Pct,
        high60,
        prevHigh60,
        dailySignals: dailySignals.map((signal) => signal.signalCode),
        weeklySignals: weeklySignals.map((signal) => signal.signalCode),
        compositeSignals: composites.map((signal) => signal.signalCode),
      }),
    })
  }

  return { features, compositeSignals }
}

async function insertSignals(signals: SignalRecord[]): Promise<void> {
  for (let i = 0; i < signals.length; i += CHUNK) {
    const chunk = signals.slice(i, i + CHUNK)
    const args: Array<string | number | null> = []
    const values = chunk.map((signal) => {
      args.push(
        signal.ticker,
        signal.date,
        signal.timescale,
        signal.maPeriod,
        signal.signalCode,
        signal.signalStrength,
        signal.direction,
        signal.label,
        signal.scoreComponent,
        signal.valueJson ?? null,
      )
      return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    }).join(', ')

    await execRun(
      `
      INSERT OR REPLACE INTO technical_signals
        (ticker, date, timescale, ma_period, signal_code, signal_strength, direction, label, score_component, value_json, computed_at)
      VALUES ${values}
      `,
      args,
    )
  }
}

async function insertFeatures(features: FeatureRow[]): Promise<void> {
  for (let i = 0; i < features.length; i += CHUNK) {
    const chunk = features.slice(i, i + CHUNK)
    const args: Array<string | number | null> = []
    const values = chunk.map((row) => {
      args.push(
        row.ticker,
        row.date,
        row.pattern_code,
        row.daily_a_stage,
        row.daily_b_stage,
        row.weekly_a_stage,
        row.weekly_b_stage,
        row.monthly_a_stage,
        row.monthly_b_stage,
        row.close,
        row.volume,
        row.volume_ratio_20,
        row.range_pct,
        row.atr20_pct,
        row.ma5_pos_pct,
        row.ma25_pos_pct,
        row.ma75_pos_pct,
        row.ma_spread_pct,
        row.rel_strength_20,
        row.signal_codes,
        row.feature_json,
      )
      return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    }).join(', ')

    await execRun(
      `
      INSERT OR REPLACE INTO model_features
        (ticker, date, pattern_code, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
         monthly_a_stage, monthly_b_stage, close, volume, volume_ratio_20, range_pct, atr20_pct,
         ma5_pos_pct, ma25_pos_pct, ma75_pos_pct, ma_spread_pct, rel_strength_20, signal_codes, feature_json, computed_at)
      VALUES ${values}
      `,
      args,
    )
  }
}

async function main() {
  const codes = await tickers()
  let signalCount = 0
  let featureCount = 0
  const started = Date.now()
  console.log(`technical_signals/model_features build: ${codes.length} tickers, recent_days=${RECENT_DAYS || 'all'}`)

  for (const [index, ticker] of codes.entries()) {
    const [daily, weekly, lastModelDate] = await Promise.all([
      execAll<DailyRow>(
        `
        SELECT
          o.date, o.open, o.high, o.low, o.close, o.volume,
          s.ma_5, s.ma_25, s.ma_75,
          s.daily_a_stage, s.daily_b_stage, s.weekly_a_stage, s.weekly_b_stage, s.monthly_a_stage, s.monthly_b_stage
        FROM ohlcv_daily o
        LEFT JOIN daily_snapshots s ON s.ticker = o.ticker AND s.date = o.date
        WHERE o.ticker = ?
        ORDER BY o.date
        `,
        [ticker],
      ),
      execAll<WeeklyRow>(
        `SELECT date, open, high, low, close, volume, ma_5, ma_13, ma_25 FROM weekly_ohlcv WHERE ticker = ? ORDER BY date`,
        [ticker],
      ),
      latestModelFeatureDate(ticker),
    ])

    let startIndex = RECENT_DAYS > 0 ? Math.max(0, daily.length - RECENT_DAYS) : 0
    if (lastModelDate) {
      const nextIndex = daily.findIndex((row) => row.date > lastModelDate)
      if (nextIndex < 0) {
        if ((index + 1) % PROGRESS_EVERY === 0 || index === codes.length - 1) {
          const elapsed = ((Date.now() - started) / 60000).toFixed(1)
          console.log(`[${index + 1}/${codes.length}] ${ticker}: already fresh (${lastModelDate}), totalSignals=${signalCount}, elapsed=${elapsed}m`)
        }
        continue
      }
      startIndex = Math.max(1, nextIndex)
    }
    const dailyByDate = computeDailySignals(ticker, daily, startIndex)
    const weeklyByDate = computeWeeklySignals(ticker, weekly)
    const dailySignals = Array.from(dailyByDate.values()).flat()
    const weeklySignals = Array.from(weeklyByDate.values()).flat()
    const { features, compositeSignals } = buildFeatures(ticker, daily, dailyByDate, weeklyByDate, startIndex)
    const allSignals = [...dailySignals, ...weeklySignals, ...compositeSignals]
    const newSignals = lastModelDate
      ? allSignals.filter((signal) => signal.date > lastModelDate)
      : allSignals

    await insertSignals(newSignals)
    await insertFeatures(features)
    signalCount += newSignals.length
    featureCount += features.length

    if ((index + 1) % PROGRESS_EVERY === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`[${index + 1}/${codes.length}] ${ticker}: signals=${newSignals.length}, features=${features.length}, totalSignals=${signalCount}, elapsed=${elapsed}m`)
    }
  }

  console.log(`technical_signals/model_features complete: signals=${signalCount}, features=${featureCount}`)
}

main().catch((error) => {
  console.error('batch-technical-signals failed:', error)
  process.exit(1)
})
