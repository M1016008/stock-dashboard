// scripts/batch-forward-extrema.ts
//
// 指定日から各 horizon 内に「どこまで上がったか / 下がったか」を計算する。
// forward_returns は終端日の騰落率だけなので、到達率分析と ML/RL ラベル用に別テーブルへ保存する。

import { execAll, execBatch } from '@/lib/db/client'
import { HORIZONS as DEFAULT_HORIZONS } from '@/lib/backtest/signals'
import {
  computeForwardExtremaRows,
  type ForwardExtremaBar as Bar,
  type ForwardExtremaRow as ExtremaRow,
} from '@/lib/backtest/forward-extrema'

const EXTREMA_BINDINGS_PER_ROW = 17
const SQLITE_SAFE_BIND_LIMIT = 32_766
const DEFAULT_CHUNK = 1_000
const requestedChunk = Number(process.env.FORWARD_EXTREMA_CHUNK ?? DEFAULT_CHUNK)
const CHUNK = Number.isFinite(requestedChunk) && requestedChunk > 0
  ? Math.min(Math.floor(requestedChunk), Math.floor(SQLITE_SAFE_BIND_LIMIT / EXTREMA_BINDINGS_PER_ROW))
  : DEFAULT_CHUNK
const PROGRESS_EVERY = Number(process.env.FORWARD_EXTREMA_PROGRESS_EVERY ?? 100)
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)
const START_DATE = process.env.FORWARD_EXTREMA_START_DATE?.trim() || null
const END_DATE = process.env.FORWARD_EXTREMA_END_DATE?.trim() || null
const TICKER_START = process.env.FORWARD_EXTREMA_TICKER_START?.trim() || null
const TICKER_END = process.env.FORWARD_EXTREMA_TICKER_END?.trim() || null
const ACTIVE_ONLY = process.env.FORWARD_EXTREMA_ACTIVE_ONLY === '1'
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

async function tickers(): Promise<string[]> {
  const filter = process.env.TICKERS?.split(',').map((value) => value.trim()).filter(Boolean)
  if (filter && filter.length > 0) return filter
  const where: string[] = []
  const args: string[] = []
  if (ACTIVE_ONLY) where.push(`active = 1`)
  if (TICKER_START) {
    where.push(`ticker >= ?`)
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push(`ticker <= ?`)
    args.push(TICKER_END)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  if (ACTIVE_ONLY) {
    try {
      const rows = await execAll<{ ticker: string }>(
        `SELECT ticker FROM ticker_universe ${whereSql} GROUP BY ticker ORDER BY ticker`,
        args,
      )
      if (rows.length > 0) return rows.map((row) => row.ticker)
      console.warn('FORWARD_EXTREMA_ACTIVE_ONLY=1 but ticker_universe returned no rows; falling back to ohlcv_daily')
    } catch (error) {
      console.warn(
        `FORWARD_EXTREMA_ACTIVE_ONLY=1 fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  const ohlcvWhere = [
    ...(TICKER_START ? [`ticker >= ?`] : []),
    ...(TICKER_END ? [`ticker <= ?`] : []),
  ]
  const ohlcvWhereSql = ohlcvWhere.length > 0 ? `WHERE ${ohlcvWhere.join(' AND ')}` : ''
  const ohlcvArgs = [
    ...(TICKER_START ? [TICKER_START] : []),
    ...(TICKER_END ? [TICKER_END] : []),
  ]
  const rows = await execAll<{ ticker: string }>(
    `SELECT ticker FROM ohlcv_daily ${ohlcvWhereSql} GROUP BY ticker ORDER BY ticker`,
    ohlcvArgs,
  )
  return rows.map((row) => row.ticker)
}

function computeTicker(ticker: string, bars: Bar[]): ExtremaRow[] {
  const recentIndex = RECENT_DAYS > 0 ? Math.max(0, bars.length - RECENT_DAYS) : 0
  const startDateIndex = START_DATE ? bars.findIndex((bar) => bar.date >= START_DATE) : -1
  const startIndex = Math.max(recentIndex, startDateIndex >= 0 ? startDateIndex : 0)
  return computeForwardExtremaRows({ ticker, bars, horizons: HORIZONS, startIndex, endDate: END_DATE })
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
  if (ACTIVE_ONLY) console.log('forward_extrema active_only=on')
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
