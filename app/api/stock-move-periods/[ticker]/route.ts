import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import {
  buildChartWindowWithMa,
  buildVolumeSummary,
  pct,
  type MoveDirection,
  type OhlcvPoint,
  type StagePoint,
} from '@/lib/backtest/detail-analysis'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type ServingMoveRow = {
  direction: MoveDirection
  rank: number
  start_date: string
  end_date: string
  return_pct: number
  trading_days: number
  stage_path_json: string
  payload_json: string
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

type MoveCandidate = {
  direction: MoveDirection
  rank: number
  startDate: string
  endDate: string
  startPrice: number | null
  endPrice: number | null
  returnPct: number | null
  tradingDays: number | null
  stagePath: StagePoint[]
}

function parseStagePath(value: string): StagePoint[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is StagePoint => item && typeof item.date === 'string' && typeof item.code === 'string')
      : []
  } catch {
    return []
  }
}

function stageCode(row: StageRow): string {
  const values = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  if (values.every((value) => value == null)) return '------'
  return values.map((value) => value == null ? '-' : String(value)).join('')
}

async function stagePath(ticker: string, startDate: string, endDate: string): Promise<StagePoint[]> {
  const rows = await execAll<StageRow>(
    `
    SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
    FROM daily_snapshots
    WHERE ticker = ? AND date >= ? AND date <= ?
    ORDER BY date
    `,
    [ticker, startDate, endDate],
  )
  const path: StagePoint[] = []
  for (const row of rows) {
    const code = stageCode(row)
    if (code === '------') continue
    if (path[path.length - 1]?.code !== code) path.push({ date: row.date, code })
  }
  return path.length <= 10 ? path : [...path.slice(0, 4), ...path.slice(-6)]
}

function detectMoves(history: OhlcvPoint[], direction: MoveDirection): MoveCandidate[] {
  const moves: MoveCandidate[] = []
  if (history.length < 2) return moves
  if (direction === 'up') {
    let lowIndex = 0
    for (let i = 1; i < history.length; i += 1) {
      const lowClose = history[lowIndex]?.close
      const currentClose = history[i]?.close
      if (lowClose == null || currentClose == null) continue
      if (currentClose < lowClose) lowIndex = i
      const returnPct = pct(lowClose, currentClose)
      if ((returnPct ?? 0) >= 30 && i - lowIndex >= 5) {
        moves.push({
          direction,
          rank: 0,
          startDate: history[lowIndex].date,
          endDate: history[i].date,
          startPrice: lowClose,
          endPrice: currentClose,
          returnPct,
          tradingDays: i - lowIndex,
          stagePath: [],
        })
        lowIndex = i
      }
    }
  } else {
    let highIndex = 0
    for (let i = 1; i < history.length; i += 1) {
      const highClose = history[highIndex]?.close
      const currentClose = history[i]?.close
      if (highClose == null || currentClose == null) continue
      if (currentClose > highClose) highIndex = i
      const returnPct = pct(highClose, currentClose)
      if ((returnPct ?? 0) <= -20 && i - highIndex >= 5) {
        moves.push({
          direction,
          rank: 0,
          startDate: history[highIndex].date,
          endDate: history[i].date,
          startPrice: highClose,
          endPrice: currentClose,
          returnPct,
          tradingDays: i - highIndex,
          stagePath: [],
        })
        highIndex = i
      }
    }
  }
  return moves
    .sort((a, b) => direction === 'up' ? (b.returnPct ?? 0) - (a.returnPct ?? 0) : (a.returnPct ?? 0) - (b.returnPct ?? 0))
    .slice(0, 4)
    .map((move, index) => ({ ...move, rank: index + 1 }))
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await context.params
    const ticker = decodeURIComponent(rawTicker).replace(/\.T$/i, '')
    const { searchParams } = new URL(request.url)
    const limit = Math.min(12, Math.max(1, Number(searchParams.get('limit') ?? 8)))

    const history = await execAll<OhlcvPoint>(
      `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
      ORDER BY date
      `,
      [ticker],
    )

    const serving = await execAll<ServingMoveRow>(
      `
      SELECT direction, rank, start_date, end_date, return_pct, trading_days, stage_path_json, payload_json
      FROM serving_stock_move_periods
      WHERE ticker = ?
      ORDER BY direction, rank
      LIMIT ?
      `,
      [ticker, limit],
    )

    let moves: MoveCandidate[] = serving.map((row) => {
      const start = history.find((item) => item.date === row.start_date)
      const end = history.find((item) => item.date === row.end_date)
      return {
        direction: row.direction,
        rank: row.rank,
        startDate: row.start_date,
        endDate: row.end_date,
        startPrice: start?.close ?? null,
        endPrice: end?.close ?? null,
        returnPct: row.return_pct,
        tradingDays: row.trading_days,
        stagePath: parseStagePath(row.stage_path_json),
      }
    })

    if (moves.length === 0) {
      moves = [
        ...detectMoves(history, 'up'),
        ...detectMoves(history, 'down'),
      ].slice(0, limit)
    }

    const enriched = await Promise.all(moves.map(async (move) => {
      const path = move.stagePath.length > 0 ? move.stagePath : await stagePath(ticker, move.startDate, move.endDate)
      return {
        ...move,
        stagePath: path,
        chartSeries: buildChartWindowWithMa(history, move.startDate, move.endDate),
        volumeSummary: buildVolumeSummary(history, move.startDate, move.endDate),
      }
    }))

    return NextResponse.json({ ticker, moves: enriched })
  } catch (error) {
    console.error('Stock move periods API error:', error)
    return NextResponse.json(
      { error: 'Stock move periods failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
