// scripts/batch-technical-signals.ts
//
// 日足・週足 MA シグナル、複合シグナル、ML/RL 用 model_features を生成する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { spawn } from 'node:child_process'
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
const CHUNK = 1000
const WRITE_BATCH_STATEMENTS = 5
const PROGRESS_EVERY = 100
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)
const TICKER_PROCESS_CHUNK = Math.max(1, Number(process.env.TECHNICAL_SIGNAL_TICKER_CHUNK ?? 50))
const PROCESS_CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.TECHNICAL_SIGNAL_PROCESS_CONCURRENCY ?? 1)))
const OUTPUT_INDEX_NAMES = [
  'tech_signal_date_idx',
  'tech_signal_code_idx',
  'tech_signal_date_ticker_idx',
  'tech_signal_ticker_code_date_idx',
  'model_features_date_idx',
  'model_features_pattern_idx',
  'model_features_ticker_date_idx',
] as const
const OUTPUT_INDEXES = [
  `CREATE INDEX IF NOT EXISTS tech_signal_date_idx ON technical_signals(date, signal_code)`,
  `CREATE INDEX IF NOT EXISTS tech_signal_code_idx ON technical_signals(signal_code, date)`,
  `CREATE INDEX IF NOT EXISTS tech_signal_date_ticker_idx ON technical_signals(date, ticker)`,
  `CREATE INDEX IF NOT EXISTS tech_signal_ticker_code_date_idx ON technical_signals(ticker, signal_code, date)`,
  `CREATE INDEX IF NOT EXISTS model_features_date_idx ON model_features(date)`,
  `CREATE INDEX IF NOT EXISTS model_features_pattern_idx ON model_features(pattern_code, date)`,
  `CREATE INDEX IF NOT EXISTS model_features_ticker_date_idx ON model_features(ticker, date)`,
] as const

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

function rollingAverage(values: Array<number | null>, window: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const added = values[i]
    if (added != null && Number.isFinite(added)) {
      sum += added
      count += 1
    }
    const removedIndex = i - window
    if (removedIndex >= 0) {
      const removed = values[removedIndex]
      if (removed != null && Number.isFinite(removed)) {
        sum -= removed
        count -= 1
      }
    }
    result[i] = count > 0 ? sum / count : null
  }
  return result
}

function rollingMax(values: number[], window: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null)
  const deque: number[] = []
  let head = 0
  for (let i = 0; i < values.length; i++) {
    while (head < deque.length && deque[head] <= i - window) head += 1
    while (deque.length > head && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
    result[i] = values[deque[head]]
    if (head > 1024 && head * 2 > deque.length) {
      deque.splice(0, head)
      head = 0
    }
  }
  return result
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
  const weeklyEntries = Array.from(weeklyByDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
  let weeklyIndex = -1
  const volumeAverage20 = rollingAverage(rows.map((row) => row.volume), 20)
  const rangePctValues = rows.map((row) => ratioPct(row.high - row.low, row.close))
  const rangeAverage20 = rollingAverage(rangePctValues, 20)
  const trueRangeAverage20 = rollingAverage(
    rows.map((row, index) => trueRange(row, rows[index - 1])),
    20,
  )
  const high60Values = rollingMax(rows.map((row) => row.high), 60)

  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i]
    const prev = rows[i - 1]
    const avgVolume20 = volumeAverage20[i]
    const rangePct = rangePctValues[i]
    const avgRange20Pct = rangeAverage20[i]
    const atr20 = trueRangeAverage20[i]
    const atr20Pct = ratioPct(atr20, row.close)
    const high60 = high60Values[i]
    const prevHigh60 = i > 0 ? high60Values[i - 1] : null
    const volumeRatio20 = safeRatio(row.volume, avgVolume20)
    const ma5PosPct = pct(row.close, row.ma_5)
    const ma25PosPct = pct(row.close, row.ma_25)
    const ma75PosPct = pct(row.close, row.ma_75)
    const maValues = [row.ma_5, row.ma_25, row.ma_75].filter((value): value is number => value != null && Number.isFinite(value))
    const maSpreadPct = maValues.length >= 2 && row.close > 0
      ? ((Math.max(...maValues) - Math.min(...maValues)) / row.close) * 100
      : null

    const dailySignals = dailyByDate.get(row.date) ?? []
    while (weeklyIndex + 1 < weeklyEntries.length && weeklyEntries[weeklyIndex + 1][0] <= row.date) {
      weeklyIndex += 1
    }
    const weeklySignals = weeklyIndex >= 0 ? weeklyEntries[weeklyIndex][1] : []
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

async function runInTickerProcesses(codes: string[]): Promise<void> {
  const chunks: string[][] = []
  for (let offset = 0; offset < codes.length; offset += TICKER_PROCESS_CHUNK) {
    chunks.push(codes.slice(offset, offset + TICKER_PROCESS_CHUNK))
  }
  let nextChunk = 0
  let completedTickers = 0
  console.log(
    `technical_signals bounded-memory driver: ${codes.length} tickers, `
    + `chunk=${TICKER_PROCESS_CHUNK}, concurrency=${PROCESS_CONCURRENCY}`,
  )

  const runChunk = async (chunk: string[]): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
        env: {
          ...process.env,
          TICKERS: chunk.join(','),
          TECHNICAL_SIGNAL_PROCESS_CHILD: '1',
          SKIP_SCHEMA_ENSURE: '1',
        },
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`technical signal ticker process failed: code=${code ?? 'null'} signal=${signal ?? 'none'}`))
      })
    })
  }

  const worker = async (): Promise<void> => {
    while (true) {
      const chunkIndex = nextChunk
      nextChunk += 1
      const chunk = chunks[chunkIndex]
      if (!chunk) return
      await runChunk(chunk)
      completedTickers += chunk.length
      const memory = process.memoryUsage()
      console.log(
        `technical_signals chunk complete: ${completedTickers}/${codes.length}, `
        + `driver_rss_mb=${(memory.rss / 1024 / 1024).toFixed(0)}`,
      )
    }
  }

  console.log('technical_signals bounded-memory driver: suspending serving indexes during rebuild')
  for (const name of OUTPUT_INDEX_NAMES) await execBatch([{ sql: `DROP INDEX IF EXISTS ${name}` }])
  try {
    await Promise.all(Array.from(
      { length: Math.min(PROCESS_CONCURRENCY, chunks.length) },
      () => worker(),
    ))
  } finally {
    console.log('technical_signals bounded-memory driver: restoring serving indexes')
    for (const sql of OUTPUT_INDEXES) await execBatch([{ sql }])
  }
}

async function insertSignals(signals: SignalRecord[]): Promise<void> {
  for (let i = 0; i < signals.length; i += CHUNK * WRITE_BATCH_STATEMENTS) {
    const statements = []
    for (let j = i; j < Math.min(signals.length, i + CHUNK * WRITE_BATCH_STATEMENTS); j += CHUNK) {
      const chunk = signals.slice(j, j + CHUNK)
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
      statements.push({
        sql: `
          INSERT OR REPLACE INTO technical_signals
            (ticker, date, timescale, ma_period, signal_code, signal_strength, direction, label, score_component, value_json, computed_at)
          VALUES ${values}
        `,
        args,
      })
    }
    await execBatch(statements)
  }
}

async function insertFeatures(features: FeatureRow[]): Promise<void> {
  for (let i = 0; i < features.length; i += CHUNK * WRITE_BATCH_STATEMENTS) {
    const statements = []
    for (let j = i; j < Math.min(features.length, i + CHUNK * WRITE_BATCH_STATEMENTS); j += CHUNK) {
      const chunk = features.slice(j, j + CHUNK)
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
      statements.push({
        sql: `
          INSERT OR REPLACE INTO model_features
            (ticker, date, pattern_code, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
             monthly_a_stage, monthly_b_stage, close, volume, volume_ratio_20, range_pct, atr20_pct,
             ma5_pos_pct, ma25_pos_pct, ma75_pos_pct, ma_spread_pct, rel_strength_20, signal_codes, feature_json, computed_at)
          VALUES ${values}
        `,
        args,
      })
    }
    await execBatch(statements)
  }
}

async function main() {
  const codes = await tickers()
  if (!process.env.TICKERS && process.env.TECHNICAL_SIGNAL_PROCESS_CHILD !== '1') {
    await runInTickerProcesses(codes)
    console.log(`technical_signals/model_features complete: bounded-memory chunks=${Math.ceil(codes.length / TICKER_PROCESS_CHUNK)}`)
    return
  }
  let signalCount = 0
  let featureCount = 0
  let loadMs = 0
  let computeMs = 0
  let writeMs = 0
  const started = Date.now()
  console.log(`technical_signals/model_features build: ${codes.length} tickers, recent_days=${RECENT_DAYS || 'all'}`)

  for (const [index, ticker] of codes.entries()) {
    const loadStarted = Date.now()
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
    loadMs += Date.now() - loadStarted

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
    const computeStarted = Date.now()
    const dailyByDate = computeDailySignals(ticker, daily, startIndex)
    const weeklyByDate = computeWeeklySignals(ticker, weekly)
    const dailySignals = Array.from(dailyByDate.values()).flat()
    const weeklySignals = Array.from(weeklyByDate.values()).flat()
    const { features, compositeSignals } = buildFeatures(ticker, daily, dailyByDate, weeklyByDate, startIndex)
    const allSignals = [...dailySignals, ...weeklySignals, ...compositeSignals]
    const newSignals = lastModelDate
      ? allSignals.filter((signal) => signal.date > lastModelDate)
      : allSignals
    computeMs += Date.now() - computeStarted

    const writeStarted = Date.now()
    await insertSignals(newSignals)
    await insertFeatures(features)
    writeMs += Date.now() - writeStarted
    signalCount += newSignals.length
    featureCount += features.length

    if ((index + 1) % PROGRESS_EVERY === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(
        `[${index + 1}/${codes.length}] ${ticker}: signals=${newSignals.length}, features=${features.length}, `
        + `totalSignals=${signalCount}, elapsed=${elapsed}m, load=${(loadMs / 1000).toFixed(1)}s, `
        + `compute=${(computeMs / 1000).toFixed(1)}s, write=${(writeMs / 1000).toFixed(1)}s`,
      )
    }
  }

  console.log(`technical_signals/model_features complete: signals=${signalCount}, features=${featureCount}`)
}

main().catch((error) => {
  console.error('batch-technical-signals failed:', error)
  process.exit(1)
})
