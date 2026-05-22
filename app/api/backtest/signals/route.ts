import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type LatestSignal = {
  date: string
  ticker: string
  rank: number
  score: number
  signal_codes: string
  summary_json: string
}

type SignalStat = {
  signal_code: string
  pattern_code: string
  horizon_days: number
  payload_json: string
}

async function latestServingDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM serving_latest_signals`))?.date ?? null
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') ?? await latestServingDate()
    const limit = Math.min(300, Math.max(1, Number(searchParams.get('limit') ?? 80)))

    if (!date) {
      return NextResponse.json({
        date: null,
        latest: [],
        stats: [],
        notice: 'serving_latest_signals が未作成です。batch:serving-backtest を実行してください。',
      })
    }

    const [latest, stats] = await Promise.all([
      execAll<LatestSignal>(
        `
        SELECT date, ticker, rank, score, signal_codes, summary_json
        FROM serving_latest_signals
        WHERE date = ?
        ORDER BY rank
        LIMIT ?
        `,
        [date, limit],
      ),
      execAll<SignalStat>(
        `
        SELECT signal_code, pattern_code, horizon_days, payload_json
        FROM serving_signal_stats
        WHERE horizon_days = 40
        ORDER BY json_extract(payload_json, '$.count') DESC
        LIMIT 80
        `,
      ),
    ])

    return NextResponse.json({
      date,
      latest: latest.map((row) => ({
        date: row.date,
        ticker: row.ticker,
        rank: row.rank,
        score: row.score,
        signalCodes: row.signal_codes.split(',').filter(Boolean),
        summary: parseJson(row.summary_json, {}),
      })),
      stats: stats.map((row) => ({
        signalCode: row.signal_code,
        patternCode: row.pattern_code,
        horizonDays: row.horizon_days,
        payload: parseJson(row.payload_json, {}),
      })),
    })
  } catch (error) {
    console.error('Backtest signals API error:', error)
    return NextResponse.json(
      { error: 'Backtest signals failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
