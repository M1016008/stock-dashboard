import { NextRequest, NextResponse } from 'next/server'
import { execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

type RangeCount = {
  start_date: string | null
  end_date: string | null
  days: number
}

async function rangeCount(sql: string, args: Array<string | number> = []): Promise<RangeCount> {
  const row = await execGet<RangeCount>(sql, args)
  return {
    start_date: row?.start_date ?? null,
    end_date: row?.end_date ?? null,
    days: Number(row?.days ?? 0),
  }
}

async function indexedDateRange(table: 'ohlcv_daily' | 'indices_daily' | 'model_features', indexName: string): Promise<RangeCount> {
  const [start, end, count] = await Promise.all([
    execGet<{ date: string | null }>(`SELECT date FROM ${table} INDEXED BY ${indexName} ORDER BY date ASC LIMIT 1`),
    execGet<{ date: string | null }>(`SELECT date FROM ${table} INDEXED BY ${indexName} ORDER BY date DESC LIMIT 1`),
    execGet<{ days: number }>(`SELECT COUNT(*) AS days FROM (SELECT DISTINCT date FROM ${table} INDEXED BY ${indexName})`),
  ])
  return {
    start_date: start?.date ?? null,
    end_date: end?.date ?? null,
    days: Number(count?.days ?? 0),
  }
}

function toPayload(row: RangeCount) {
  return {
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const horizon = Number(searchParams.get('horizon') ?? 40)
    const safeHorizon = [5, 20, 30, 40, 60, 90, 180].includes(horizon) ? horizon : 40

    const [market, indices, feature, backtest] = await Promise.all([
      indexedDateRange('ohlcv_daily', 'ohlcv_date_idx'),
      indexedDateRange('indices_daily', 'indices_date_idx'),
      indexedDateRange('model_features', 'model_features_date_idx'),
      rangeCount(`
        SELECT MIN(date) AS start_date, MAX(date) AS end_date, COUNT(DISTINCT date) AS days
        FROM forward_extrema INDEXED BY fext_horizon_date_idx
        WHERE horizon_days = ?
      `, [safeHorizon])
    ])
    const excludedDays = Math.max(0, market.days - backtest.days)

    return NextResponse.json({
      horizon: safeHorizon,
      market: toPayload(market),
      indices: toPayload(indices),
      feature: toPayload(feature),
      backtest: {
        ...toPayload(backtest),
        label: `${safeHorizon}営業日先まで結果を確認できる日数`,
      },
      excluded: {
        days: excludedDays,
        reasons: [
          '特徴量生成前',
          '将来horizon不足',
          '銘柄ごとの上場前',
          'データ欠損または売買停止',
        ],
      },
    })
  } catch (error) {
    console.error('Backtest coverage API error:', error)
    return NextResponse.json(
      { error: 'Backtest coverage failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
