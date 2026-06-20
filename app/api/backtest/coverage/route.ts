import { NextRequest, NextResponse } from 'next/server'
import { execGet } from '@/lib/db/client'
import { readServingCache, writeServingCache } from '@/lib/api/serving-cache'

export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_NAMESPACE = 'backtest_coverage_v1'

type CoveragePayload = {
  horizon: number
  market: ReturnType<typeof toPayload>
  indices: ReturnType<typeof toPayload>
  feature: ReturnType<typeof toPayload>
  backtest: ReturnType<typeof toPayload> & { label: string }
  excluded: {
    days: number
    reasons: string[]
  }
  cache?: {
    hit: boolean
    generatedAt: string
  }
}

const coverageCache = new Map<number, { generatedAt: number; payload: CoveragePayload }>()

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

    const cached = coverageCache.get(safeHorizon)
    if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        ...cached.payload,
        cache: { hit: true, generatedAt: new Date(cached.generatedAt).toISOString() },
      })
    }
    const stored = await readServingCache<CoveragePayload>(CACHE_NAMESPACE, String(safeHorizon), CACHE_TTL_MS)
    if (stored) {
      coverageCache.set(safeHorizon, { generatedAt: stored.generatedAt, payload: stored.payload })
      return NextResponse.json({
        ...stored.payload,
        cache: { hit: true, generatedAt: new Date(stored.generatedAt).toISOString(), store: 'db' },
      })
    }

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

    const generatedAt = Date.now()
    const payload: CoveragePayload = {
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
      cache: { hit: false, generatedAt: new Date(generatedAt).toISOString() },
    }
    coverageCache.set(safeHorizon, { generatedAt, payload })
    await writeServingCache(CACHE_NAMESPACE, String(safeHorizon), payload, CACHE_TTL_MS, generatedAt)

    return NextResponse.json(payload)
  } catch (error) {
    console.error('Backtest coverage API error:', error)
    return NextResponse.json(
      { error: 'Backtest coverage failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
