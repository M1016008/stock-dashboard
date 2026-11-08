import { NextRequest, NextResponse } from 'next/server'
import type { UniverseFilterValue } from '@/lib/market-universe'
import {
  StageTransitionInputError,
  type StageTransitionFilterOptions,
  type StageTransitionSearchResult,
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

// JP / US の遷移スキャナー API 共通の GET フロー。
// 市場固有の universe・検索ローダー・meta・500 エラーは各 route が明示的に渡す。
interface StageTransitionRouteConfig {
  universeFilter: (params: URLSearchParams) => UniverseFilterValue
  load: (input: StageTransitionSearchInput) => Promise<[StageTransitionSearchResult, StageTransitionFilterOptions]>
  meta: Record<string, unknown>
  logLabel: string
  failure: { error: string; message: string }
}

function stringParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim()
  return value ? value.slice(0, 120) : null
}

function integerParam(value: string | null, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function searchInput(params: URLSearchParams, universeFilter: UniverseFilterValue): StageTransitionSearchInput {
  return {
    fromCode: stringParam(params, 'from') ?? '211111',
    toCode: stringParam(params, 'to') ?? '111111',
    universeFilter,
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

export async function stageTransitionRouteResponse(request: NextRequest, config: StageTransitionRouteConfig) {
  const startedAt = performance.now()
  try {
    const params = request.nextUrl.searchParams
    const [result, options] = await config.load(searchInput(params, config.universeFilter(params)))
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
        ...config.meta,
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
    console.error(`${config.logLabel} failed:`, error)
    return NextResponse.json(
      { success: false, ...config.failure },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
