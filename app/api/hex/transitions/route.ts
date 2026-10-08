import { NextRequest, NextResponse } from 'next/server'
import { parseUniverseFilter } from '@/lib/market-universe'
import {
  StageTransitionInputError,
  getStageTransitionFilterOptions,
  searchStageTransitions,
} from '@/lib/queries/stage-transition-scanner'
import {
  STAGE_CODE_AXES,
  STAGE_TRANSITION_AVERAGE_SESSIONS,
  parseOptionalNonNegativeNumber,
  parseStageTransitionPeriod,
  parseStageTransitionSort,
  parseStageTransitionSortDirection,
  type StageTransitionSearchInput,
} from '@/lib/stage-transition-scanner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function stringParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim()
  return value ? value.slice(0, 120) : null
}

function integerParam(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function searchInput(params: URLSearchParams): StageTransitionSearchInput {
  return {
    fromCode: stringParam(params, 'from') ?? '211111',
    toCode: stringParam(params, 'to') ?? '111111',
    universeFilter: parseUniverseFilter(params.get('universe')),
    period: parseStageTransitionPeriod(stringParam(params, 'period')),
    customFrom: stringParam(params, 'dateFrom'),
    customTo: stringParam(params, 'dateTo'),
    industry33: stringParam(params, 'industry33'),
    marketSegment: stringParam(params, 'marketSegment'),
    minPrice: parseOptionalNonNegativeNumber(stringParam(params, 'minPrice')),
    maxPrice: parseOptionalNonNegativeNumber(stringParam(params, 'maxPrice')),
    minAvgVolume: parseOptionalNonNegativeNumber(stringParam(params, 'minAvgVolume')),
    maxAvgVolume: parseOptionalNonNegativeNumber(stringParam(params, 'maxAvgVolume')),
    minAvgTurnover: parseOptionalNonNegativeNumber(stringParam(params, 'minAvgTurnover')),
    maxAvgTurnover: parseOptionalNonNegativeNumber(stringParam(params, 'maxAvgTurnover')),
    sort: parseStageTransitionSort(stringParam(params, 'sort')),
    direction: parseStageTransitionSortDirection(stringParam(params, 'direction')),
    page: integerParam(params.get('page'), 1),
    pageSize: integerParam(params.get('pageSize'), 50),
  }
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const input = searchInput(request.nextUrl.searchParams)
    const [result, options] = await Promise.all([
      searchStageTransitions(input),
      getStageTransitionFilterOptions(),
    ])
    return NextResponse.json({
      success: true,
      data: result.rows,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
      meta: {
        source: 'daily_snapshots + ohlcv_daily + ticker_universe',
        pit: true,
        classificationBasis: 'CURRENT_TICKER_UNIVERSE',
        stageCodeOrder: STAGE_CODE_AXES,
        averageSessions: STAGE_TRANSITION_AVERAGE_SESSIONS,
        missingStagePolicy: 'EXCLUDE_AND_DO_NOT_BRIDGE',
        range: result.range,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      options,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof StageTransitionInputError) {
      return NextResponse.json(
        { success: false, error: error.code, message: error.message },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    console.error('Stage transition scanner failed:', error)
    return NextResponse.json(
      { success: false, error: 'stage_transition_search_failed', message: '遷移銘柄の検索に失敗しました。' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
