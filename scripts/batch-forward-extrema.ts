// scripts/batch-forward-extrema.ts
//
// 指定日から各 horizon 内に「どこまで上がったか / 下がったか」を計算する。
// forward_returns は終端日の騰落率だけなので、到達率分析と ML/RL ラベル用に別テーブルへ保存する。

import { execAll, execBatch } from '@/lib/db/client'
import { HORIZONS as DEFAULT_HORIZONS, TARGET_PCTS } from '@/lib/backtest/signals'

type Bar = {
  date: string
  high: number
  low: number
  close: number
}

type ExtremaRow = {
  ticker: string
  date: string
  horizon_days: number
  return_pct: number
  end_date: string
  max_return_pct: number
  max_return_date: string
  days_to_max: number
  min_return_pct: number
  min_return_date: string
  days_to_min: number
  hit_10: number
  hit_20: number
  hit_40: number
  days_to_10: number | null
  days_to_20: number | null
  days_to_40: number | null
}

const CHUNK = Number(process.env.FORWARD_EXTREMA_CHUNK ?? 300)
const PROGRESS_EVERY = Number(process.env.FORWARD_EXTREMA_PROGRESS_EVERY ?? 100)
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)
const START_DATE = process.env.FORWARD_EXTREMA_START_DATE?.trim() || null
const END_DATE = process.env.FORWARD_EXTREMA_END_DATE?.trim() || null
const TICKER_START = process.env.FORWARD_EXTREMA_TICKER_START?.trim() || null
const TICKER_END = process.env.FORWARD_EXTREMA_TICKER_END?.trim() || null
const WRITE_MODEL_LABELS = process.env.FORWARD_EXTREMA_WRITE_MODEL_LABELS !== '0'

function parseHorizons(value: string | undefined): number[] {
  if (!value?.trim()) return [...DEFAULT_HORIZONS]
  const parsed = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
  if (parsed.length === 0) throw new Error('FORWARD_EXTREMA_HORIZONS に有効な営業日数がありません')
  return [...new Set(parsed)].sort((a, b) => a - b)
}

const HORIZONS = parseHorizons(process.env.FORWARD_EXTREMA_HORIZONS)
const HORIZON_SET = new Set(HORIZONS)
const MAX_HORIZON = Math.max(...HORIZONS)

async function tickers(): Promise<string[]> {
  const filter = process.env.TICKERS?.split(',').map((value) => value.trim()).filter(Boolean)
  if (filter && filter.length > 0) return filter
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
  const rows = await execAll<{ ticker: string }>(
    `SELECT ticker FROM ohlcv_daily ${whereSql} GROUP BY ticker ORDER BY ticker`,
    args,
  )
  return rows.map((row) => row.ticker)
}

function computeTicker(ticker: string, bars: Bar[]): ExtremaRow[] {
  const records: ExtremaRow[] = []
  const recentIndex = RECENT_DAYS > 0 ? Math.max(0, bars.length - RECENT_DAYS) : 0
  const startDateIndex = START_DATE ? bars.findIndex((bar) => bar.date >= START_DATE) : -1
  const startIndex = Math.max(recentIndex, startDateIndex >= 0 ? startDateIndex : 0)

  for (let i = startIndex; i < bars.length; i++) {
    const base = bars[i]
    if (!base || !Number.isFinite(base.close) || base.close <= 0) continue
    if (END_DATE && base.date > END_DATE) break

    let maxReturnPct = Number.NEGATIVE_INFINITY
    let minReturnPct = Number.POSITIVE_INFINITY
    let maxReturnDate = ''
    let minReturnDate = ''
    let daysToMax = 0
    let daysToMin = 0
    const targetDays: Record<number, number | null> = { 10: null, 20: null, 40: null }
    const maxFutureDays = Math.min(MAX_HORIZON, bars.length - i - 1)

    for (let day = 1; day <= maxFutureDays; day++) {
      const bar = bars[i + day]
      const highReturn = ((bar.high - base.close) / base.close) * 100
      const lowReturn = ((bar.low - base.close) / base.close) * 100
      if (highReturn > maxReturnPct) {
        maxReturnPct = highReturn
        maxReturnDate = bar.date
        daysToMax = day
      }
      if (lowReturn < minReturnPct) {
        minReturnPct = lowReturn
        minReturnDate = bar.date
        daysToMin = day
      }
      for (const target of TARGET_PCTS) {
        if (targetDays[target] == null && highReturn >= target) targetDays[target] = day
      }

      if (HORIZON_SET.has(day)) {
        const returnPct = ((bar.close - base.close) / base.close) * 100
        records.push({
          ticker,
          date: base.date,
          horizon_days: day,
          return_pct: returnPct,
          end_date: bar.date,
          max_return_pct: maxReturnPct,
          max_return_date: maxReturnDate,
          days_to_max: daysToMax,
          min_return_pct: minReturnPct,
          min_return_date: minReturnDate,
          days_to_min: daysToMin,
          hit_10: targetDays[10] == null ? 0 : 1,
          hit_20: targetDays[20] == null ? 0 : 1,
          hit_40: targetDays[40] == null ? 0 : 1,
          days_to_10: targetDays[10],
          days_to_20: targetDays[20],
          days_to_40: targetDays[40],
        })
      }
    }
  }

  return records
}

async function insertRows(ticker: string, rows: ExtremaRow[]): Promise<void> {
  if (rows.length === 0) return
  const statements: Parameters<typeof execBatch>[0] = []
  const horizonPlaceholders = HORIZONS.map(() => '?').join(', ')
  const minDate = rows[0].date
  const maxDate = rows[rows.length - 1].date

  statements.push({
    sql: `
      DELETE FROM forward_extrema
      WHERE ticker = ?
        AND horizon_days IN (${horizonPlaceholders})
        AND date BETWEEN ? AND ?
    `,
    args: [ticker, ...HORIZONS, minDate, maxDate],
  })
  if (WRITE_MODEL_LABELS) {
    statements.push({
      sql: `
        DELETE FROM model_labels
        WHERE ticker = ?
          AND horizon_days IN (${horizonPlaceholders})
          AND date BETWEEN ? AND ?
      `,
      args: [ticker, ...HORIZONS, minDate, maxDate],
    })
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const extremaArgs: Array<string | number | null> = []
    const extremaValues = chunk.map((row) => {
      extremaArgs.push(
        row.ticker,
        row.date,
        row.horizon_days,
        row.return_pct,
        row.end_date,
        row.max_return_pct,
        row.max_return_date,
        row.days_to_max,
        row.min_return_pct,
        row.min_return_date,
        row.days_to_min,
        row.hit_10,
        row.hit_20,
        row.hit_40,
        row.days_to_10,
        row.days_to_20,
        row.days_to_40,
      )
      return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    }).join(', ')

    statements.push({
      sql: `
      INSERT INTO forward_extrema
        (ticker, date, horizon_days, return_pct, end_date, max_return_pct, max_return_date, days_to_max,
         min_return_pct, min_return_date, days_to_min, hit_10, hit_20, hit_40, days_to_10, days_to_20, days_to_40, computed_at)
      VALUES ${extremaValues}
      `,
      args: extremaArgs,
    })

    if (WRITE_MODEL_LABELS) {
      const labelArgs: Array<string | number | null> = []
      const labelValues = chunk.map((row) => {
        labelArgs.push(
          row.ticker,
          row.date,
          row.horizon_days,
          row.return_pct,
          row.max_return_pct,
          row.min_return_pct,
          row.days_to_max,
          row.hit_10,
          row.hit_20,
          row.hit_40,
          row.max_return_pct + Math.min(row.min_return_pct, 0),
          JSON.stringify({
            endDate: row.end_date,
            maxReturnDate: row.max_return_date,
            minReturnDate: row.min_return_date,
            daysToMin: row.days_to_min,
            daysTo10: row.days_to_10,
            daysTo20: row.days_to_20,
            daysTo40: row.days_to_40,
          }),
        )
        return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
      }).join(', ')

      statements.push({
        sql: `
        INSERT INTO model_labels
          (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, days_to_max,
           hit_10, hit_20, hit_40, reward_score, label_json, computed_at)
        VALUES ${labelValues}
        `,
        args: labelArgs,
      })
    }
  }

  if (statements.length > 0) await execBatch(statements)
}

async function main() {
  const codes = await tickers()
  let total = 0
  const started = Date.now()
  console.log(
    `forward_extrema build: ${codes.length} tickers, recent_days=${RECENT_DAYS || 'all'}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}, horizons=${HORIZONS.join('/')}, chunk=${CHUNK}, model_labels=${WRITE_MODEL_LABELS ? 'on' : 'off'}`,
  )
  if (TICKER_START || TICKER_END) console.log(`forward_extrema ticker range: ${TICKER_START ?? '-'}..${TICKER_END ?? '-'}`)

  for (const [index, ticker] of codes.entries()) {
    const bars = await execAll<Bar>(
      `SELECT date, high, low, close FROM ohlcv_daily WHERE ticker = ? ORDER BY date`,
      [ticker],
    )
    const rows = computeTicker(ticker, bars)
    await insertRows(ticker, rows)
    total += rows.length

    if ((index + 1) % PROGRESS_EVERY === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`[${index + 1}/${codes.length}] ${ticker}: ${rows.length} labels, total=${total}, elapsed=${elapsed}m`)
    }
  }

  console.log(`forward_extrema complete: ${total} rows`)
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error('batch-forward-extrema failed:', error)
  process.exit(1)
})
