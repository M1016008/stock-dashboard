import { NextRequest, NextResponse } from 'next/server'
import {
  isIsoDate,
  isUsBacktestHorizon,
  queryUsBacktest,
  type UsBacktestQuery,
} from '@/lib/server/us-backtest'
import { isUsMarketTradingDate } from '@/lib/server/us-data-freshness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function finiteParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key)
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const horizon = Number(params.get('horizon') ?? 40)
  const date = params.get('date')?.trim() || null
  if (!isUsBacktestHorizon(horizon)) return NextResponse.json({ error: 'invalid_horizon' }, { status: 400 })
  if (date && !isIsoDate(date)) return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
  if (date && !isUsMarketTradingDate(date)) {
    return NextResponse.json({ error: 'non_trading_date' }, { status: 400 })
  }
  if (['sector', 'industry', 'exchange'].some((key) => params.has(key))) {
    return NextResponse.json({
      error: 'historical_classification_filter_unavailable',
      message: '過去時点で有効なUS分類履歴を保証できないため、分類フィルターは使用できません。',
    }, { status: 422 })
  }
  const stageCode = params.get('stageCode')?.trim() || null
  if (stageCode && !/^[1-6]{6}$/.test(stageCode)) {
    return NextResponse.json({ error: 'invalid_stage_code' }, { status: 400 })
  }
  const returnMetric = params.get('returnMetric')
  const sort = params.get('sort')
  const target = finiteParam(params, 'targetPct')
  const input: UsBacktestQuery = {
    date,
    horizon,
    search: params.get('search')?.trim().slice(0, 40) || null,
    stageCode,
    signal: params.get('signal')?.trim().slice(0, 80) || null,
    returnMetric: returnMetric === 'period' || returnMetric === 'min' ? returnMetric : 'max',
    returnMin: finiteParam(params, 'returnMin'),
    returnMax: finiteParam(params, 'returnMax'),
    targetPct: target === 10 || target === 20 || target === 40 ? target : null,
    sort: sort === 'minReturn' || sort === 'periodReturn' || sort === 'volume' || sort === 'ticker' ? sort : 'maxReturn',
    page: finiteParam(params, 'page') ?? 1,
    pageSize: finiteParam(params, 'pageSize') ?? 50,
  }
  try {
    const result = await queryUsBacktest(input)
    return NextResponse.json({
      ...result,
      pit: true,
      classificationAvailability: 'OMITTED_HISTORICAL_PIT_UNAVAILABLE',
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('US backtest query failed:', error)
    return NextResponse.json({ error: 'us_backtest_query_failed' }, { status: 500 })
  }
}
