// scripts/build-serving-stock.ts
//
// 個別銘柄ページをTursoで高速表示するための軽量テーブルを作る。
// 全履歴OHLCVから代表的な上昇/下落局面だけを圧縮保存し、巨大な中間特徴量は持ち込まない。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'

type TickerRow = {
  ticker: string
  name: string | null
  market_segment: string | null
  sector_large: string | null
  sector_small: string | null
}

type OhlcvRow = {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

type StageRow = {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type MovePeriod = {
  direction: 'up' | 'down'
  startDate: string
  endDate: string
  startPrice: number
  endPrice: number
  returnPct: number
  tradingDays: number
}

const CHUNK = 250
const TICKER_LIMIT = Number(process.env.SERVING_STOCK_LIMIT ?? 0)
const TICKER_FILTER = process.env.SERVING_STOCK_TICKER?.trim()
const UP_THRESHOLD = Number(process.env.SERVING_STOCK_UP_THRESHOLD ?? 30)
const DOWN_THRESHOLD = Number(process.env.SERVING_STOCK_DOWN_THRESHOLD ?? -20)
const MAX_PERIODS = Number(process.env.SERVING_STOCK_PERIODS ?? 5)

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100
}

function stageCode(row: StageRow | undefined): string {
  if (!row) return '------'
  const values = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  if (values.some((value) => value == null)) return '------'
  return values.map(String).join('')
}

function compactStagePath(stages: StageRow[], startDate: string, endDate: string): Array<{ date: string; code: string }> {
  const inRange = stages.filter((row) => row.date >= startDate && row.date <= endDate)
  const path: Array<{ date: string; code: string }> = []
  for (const row of inRange) {
    const code = stageCode(row)
    if (code === '------') continue
    if (path[path.length - 1]?.code !== code) path.push({ date: row.date, code })
  }
  if (path.length <= 10) return path
  const sampled = [
    ...path.slice(0, 3),
    ...path.slice(Math.max(3, Math.floor(path.length / 2) - 2), Math.floor(path.length / 2) + 2),
    ...path.slice(-3),
  ]
  const seen = new Set<string>()
  return sampled.filter((item) => {
    const key = `${item.date}:${item.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function detectMovePeriods(rows: OhlcvRow[], direction: 'up' | 'down'): MovePeriod[] {
  const periods: MovePeriod[] = []
  if (rows.length < 2) return periods

  if (direction === 'up') {
    let lowIndex = 0
    for (let i = 1; i < rows.length; i += 1) {
      const lowClose = rows[lowIndex]?.close
      const currentClose = rows[i]?.close
      if (!lowClose || !currentClose) continue
      if (currentClose < lowClose) lowIndex = i
      const returnPct = pct(lowClose, currentClose)
      if (returnPct >= UP_THRESHOLD && i - lowIndex >= 5) {
        periods.push({
          direction,
          startDate: rows[lowIndex].date,
          endDate: rows[i].date,
          startPrice: lowClose,
          endPrice: currentClose,
          returnPct,
          tradingDays: i - lowIndex,
        })
        lowIndex = i
      }
    }
  } else {
    let highIndex = 0
    for (let i = 1; i < rows.length; i += 1) {
      const highClose = rows[highIndex]?.close
      const currentClose = rows[i]?.close
      if (!highClose || !currentClose) continue
      if (currentClose > highClose) highIndex = i
      const returnPct = pct(highClose, currentClose)
      if (returnPct <= DOWN_THRESHOLD && i - highIndex >= 5) {
        periods.push({
          direction,
          startDate: rows[highIndex].date,
          endDate: rows[i].date,
          startPrice: highClose,
          endPrice: currentClose,
          returnPct,
          tradingDays: i - highIndex,
        })
        highIndex = i
      }
    }
  }

  return periods
    .sort((a, b) => direction === 'up' ? b.returnPct - a.returnPct : a.returnPct - b.returnPct)
    .slice(0, MAX_PERIODS)
}

async function buildTicker(ticker: TickerRow): Promise<Array<{ sql: string; args: Array<string | number | null> }>> {
  const history = await execAll<OhlcvRow>(
    `SELECT date, open, high, low, close, volume FROM ohlcv_daily WHERE ticker = ? ORDER BY date`,
    [ticker.ticker],
  )
  if (history.length === 0) return []

  const latest = history[history.length - 1]
  const year = latest.date.slice(0, 4)
  const ytd = history.filter((row) => row.date.startsWith(year))
  const firstYtd = ytd[0]
  const highYtd = ytd.reduce((best, row) => (row.high ?? -Infinity) > (best.high ?? -Infinity) ? row : best, ytd[0])
  const lowYtd = ytd.reduce((best, row) => (row.low ?? Infinity) < (best.low ?? Infinity) ? row : best, ytd[0])
  const previousEarnings = await execGet<{ announce_date: string | null }>(
    `SELECT MAX(announce_date) AS announce_date FROM earnings_calendar WHERE ticker = ? AND announce_date <= ?`,
    [ticker.ticker, latest.date],
  )
  const nextEarnings = await execGet<{ announce_date: string | null }>(
    `SELECT MIN(announce_date) AS announce_date FROM earnings_calendar WHERE ticker = ? AND announce_date > ?`,
    [ticker.ticker, latest.date],
  )

  const stages = await execAll<StageRow>(
    `
    SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
    FROM daily_snapshots
    WHERE ticker = ?
    ORDER BY date
    `,
    [ticker.ticker],
  )
  const movePeriods = [
    ...detectMovePeriods(history, 'up'),
    ...detectMovePeriods(history, 'down'),
  ]

  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [
    {
      sql: `DELETE FROM serving_stock_move_periods WHERE ticker = ?`,
      args: [ticker.ticker],
    },
    {
      sql: `
      INSERT OR REPLACE INTO serving_stock_metrics
        (ticker, as_of_date, payload_json, computed_at)
      VALUES (?, ?, ?, unixepoch())
    `,
    args: [
      ticker.ticker,
      latest.date,
      JSON.stringify({
        ticker: ticker.ticker,
        name: ticker.name,
        marketSegment: ticker.market_segment,
        sectorLarge: ticker.sector_large,
        sectorSmall: ticker.sector_small,
        latest,
        range: {
          startDate: history[0].date,
          endDate: latest.date,
          tradingDays: history.length,
        },
        ytd: firstYtd ? {
          year,
          startDate: firstYtd.date,
          startClose: firstYtd.close,
          high: highYtd?.high ?? null,
          highDate: highYtd?.date ?? null,
          low: lowYtd?.low ?? null,
          lowDate: lowYtd?.date ?? null,
          returnPct: firstYtd.close && latest.close ? pct(firstYtd.close, latest.close) : null,
        } : null,
        earnings: {
          previousDate: previousEarnings?.announce_date ?? null,
          nextDate: nextEarnings?.announce_date ?? null,
        },
        stageCode: stageCode(stages[stages.length - 1]),
      }),
    ],
    },
  ]

  for (const direction of ['up', 'down'] as const) {
    let rank = 1
    for (const period of movePeriods.filter((item) => item.direction === direction)) {
      const stagePath = compactStagePath(stages, period.startDate, period.endDate)
      statements.push({
        sql: `
          INSERT OR REPLACE INTO serving_stock_move_periods
            (ticker, direction, rank, start_date, end_date, return_pct, trading_days, stage_path_json, payload_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          ticker.ticker,
          direction,
          rank,
          period.startDate,
          period.endDate,
          Number(period.returnPct.toFixed(3)),
          period.tradingDays,
          JSON.stringify(stagePath),
          JSON.stringify(period),
        ],
      })
      rank += 1
    }
  }
  return statements
}

async function main() {
  const limitSql = TICKER_LIMIT > 0 ? `LIMIT ?` : ''
  const filterSql = TICKER_FILTER ? `AND u.ticker = ?` : ''
  const args: Array<string | number> = []
  if (TICKER_FILTER) args.push(TICKER_FILTER)
  if (TICKER_LIMIT > 0) args.push(TICKER_LIMIT)
  const tickers = await execAll<TickerRow>(
    `
    SELECT u.ticker, u.name,
           COALESCE(u.market_segment, sm.market_segment) AS market_segment,
           COALESCE(u.sector17_name, sm.sector_large) AS sector_large,
           COALESCE(u.sector33_name, sm.sector_small) AS sector_small
    FROM ticker_universe u
    LEFT JOIN sector_master sm ON sm.ticker = u.ticker
    WHERE EXISTS (SELECT 1 FROM ohlcv_daily o WHERE o.ticker = u.ticker)
      ${filterSql}
    ORDER BY u.ticker
    ${limitSql}
    `,
    args,
  )
  console.log(`serving stock build: tickers=${tickers.length}`)

  let buffered: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const [index, ticker] of tickers.entries()) {
    buffered.push(...await buildTicker(ticker))
    if (buffered.length >= CHUNK) {
      await execBatch(buffered.splice(0, buffered.length))
    }
    if ((index + 1) % 100 === 0 || index + 1 === tickers.length) {
      console.log(`  ${index + 1}/${tickers.length}`)
    }
  }
  if (buffered.length > 0) await execBatch(buffered)
  console.log('serving stock build complete')
}

main().catch((error) => {
  console.error('build-serving-stock failed:', error)
  process.exit(1)
})
