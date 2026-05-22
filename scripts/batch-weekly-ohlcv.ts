// scripts/batch-weekly-ohlcv.ts
//
// 日次 OHLCV から週足ローソクを生成する。週末日付は、その週の最終取引日。
// ML/RL 用の特徴量や週足 MA シグナルの前提テーブル。

import { execAll, execBatch } from '@/lib/db/client'

type DailyBar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type WeeklyBar = {
  ticker: string
  date: string
  week_start_date: string
  week_end_date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma_5: number | null
  ma_13: number | null
  ma_25: number | null
  ma_50: number | null
  ma_100: number | null
}

const MA_WINDOWS = [5, 13, 25, 50, 100] as const
const CHUNK = 400
const PROGRESS_EVERY = 100
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function weekStart(dateText: string): string {
  const date = new Date(`${dateText}T00:00:00Z`)
  const day = date.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setUTCDate(date.getUTCDate() + diff)
  return toIsoDate(date)
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function buildWeekly(ticker: string, daily: DailyBar[]): WeeklyBar[] {
  const grouped = new Map<string, DailyBar[]>()
  for (const bar of daily) {
    const key = weekStart(bar.date)
    const group = grouped.get(key) ?? []
    group.push(bar)
    grouped.set(key, group)
  }

  const weeks: WeeklyBar[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, bars]) => {
      const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      return {
        ticker,
        date: last.date,
        week_start_date: start,
        week_end_date: last.date,
        open: first.open,
        high: Math.max(...sorted.map((bar) => bar.high)),
        low: Math.min(...sorted.map((bar) => bar.low)),
        close: last.close,
        volume: sorted.reduce((sum, bar) => sum + Number(bar.volume ?? 0), 0),
        ma_5: null,
        ma_13: null,
        ma_25: null,
        ma_50: null,
        ma_100: null,
      }
    })

  for (let i = 0; i < weeks.length; i++) {
    for (const window of MA_WINDOWS) {
      if (i + 1 < window) continue
      const closes = weeks.slice(i + 1 - window, i + 1).map((bar) => bar.close)
      weeks[i][`ma_${window}` as keyof WeeklyBar] = average(closes) as never
    }
  }

  return weeks
}

async function tickers(): Promise<string[]> {
  const filter = process.env.TICKERS?.split(',').map((value) => value.trim()).filter(Boolean)
  if (filter && filter.length > 0) return filter
  const rows = await execAll<{ ticker: string }>(`SELECT ticker FROM ticker_universe WHERE active = 1 ORDER BY ticker`)
  return rows.map((row) => row.ticker)
}

async function insertWeekly(rows: WeeklyBar[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await execBatch(rows.slice(i, i + CHUNK).map((row) => ({
      sql: `
        INSERT OR REPLACE INTO weekly_ohlcv
          (ticker, date, week_start_date, week_end_date, open, high, low, close, volume, ma_5, ma_13, ma_25, ma_50, ma_100, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.ticker,
        row.date,
        row.week_start_date,
        row.week_end_date,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume,
        row.ma_5,
        row.ma_13,
        row.ma_25,
        row.ma_50,
        row.ma_100,
      ],
    })))
  }
}

async function main() {
  const codes = await tickers()
  let total = 0
  const started = Date.now()
  console.log(`weekly_ohlcv build: ${codes.length} tickers, recent_days=${RECENT_DAYS || 'all'}`)

  for (const [index, ticker] of codes.entries()) {
    const daily = await execAll<DailyBar>(
      `SELECT date, open, high, low, close, volume FROM ohlcv_daily WHERE ticker = ? ORDER BY date`,
      [ticker],
    )
    const cutoffDate = RECENT_DAYS > 0 && daily.length > RECENT_DAYS
      ? daily[daily.length - RECENT_DAYS].date
      : null
    const weekly = buildWeekly(ticker, daily)
    const targetWeeks = cutoffDate ? weekly.filter((row) => row.date >= cutoffDate) : weekly
    await insertWeekly(targetWeeks)
    total += targetWeeks.length

    if ((index + 1) % PROGRESS_EVERY === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`[${index + 1}/${codes.length}] ${ticker}: ${targetWeeks.length}/${weekly.length} weeks, total=${total}, elapsed=${elapsed}m`)
    }
  }

  console.log(`weekly_ohlcv complete: ${total} rows`)
}

main().catch((error) => {
  console.error('batch-weekly-ohlcv failed:', error)
  process.exit(1)
})
