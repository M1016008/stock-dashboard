import { NextRequest, NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import {
  filterTriggerDiscoveryRowsByStage,
  getTriggerDiscovery,
  sortTriggerDiscoveryRows,
  TriggerDiscoveryInputError,
  type TriggerDiscoveryResult,
} from '@/lib/server/trigger-discovery-read-model'
import {
  parseTriggerDiscoverySearchRequest,
  triggerDiscoveryBaseSearchKey,
} from '@/lib/server/trigger-discovery-search-request'
import {
  createUsTriggerDiscoveryDataSource,
  getUsTriggerLatestAsOf,
} from '@/lib/server/us-trigger-discovery'
import type { UsTriggerDiscoverySearchResponse } from '@/lib/us-trigger-discovery-contract'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 6
const globalForUsTriggerSearch = globalThis as typeof globalThis & {
  usTriggerDiscoverySearchCache?: Map<string, { expiresAt: number; result: TriggerDiscoveryResult }>
  usTriggerDiscoverySearchInFlight?: Map<string, Promise<TriggerDiscoveryResult>>
}
class UsTriggerHistoricalFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsTriggerHistoricalFilterError'
  }
}

async function getBaseResult(
  parsed: ReturnType<typeof parseTriggerDiscoverySearchRequest>,
): Promise<{ result: TriggerDiscoveryResult; latestAsOf: string | null; cacheHit: boolean }> {
  const latestAsOf = await getUsTriggerLatestAsOf()
  const isHistorical = latestAsOf != null && parsed.input.asOf < latestAsOf
  if (isHistorical && (parsed.request.markets?.length ?? 0) > 0) {
    throw new UsTriggerHistoricalFilterError(
      '過去日は当時の取引所情報を持たないため、取引所の条件を外してください。',
    )
  }
  const cache = globalForUsTriggerSearch.usTriggerDiscoverySearchCache ?? new Map()
  globalForUsTriggerSearch.usTriggerDiscoverySearchCache = cache
  const now = Date.now()
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key)
  const key = `US:${triggerDiscoveryBaseSearchKey(parsed.input, parsed.timeframe)}`
  const cached = cache.get(key)
  if (cached) return { result: cached.result, latestAsOf, cacheHit: true }

  const inFlight = globalForUsTriggerSearch.usTriggerDiscoverySearchInFlight ?? new Map()
  globalForUsTriggerSearch.usTriggerDiscoverySearchInFlight = inFlight
  const pending = inFlight.get(key)
  if (pending) return { result: await pending, latestAsOf, cacheHit: true }

  const task = getTriggerDiscovery({
    ...parsed.input,
    stageFilters: undefined,
    sortBy: undefined,
    sortDirection: undefined,
    limit: 10_000,
    offset: 0,
  }, {
    timeframe: parsed.timeframe,
    maPath: 'generic',
    dataSource: createUsTriggerDiscoveryDataSource(),
  })
  inFlight.set(key, task)
  try {
    const result = await task
    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return { result, latestAsOf, cacheHit: false }
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const parsed = parseTriggerDiscoverySearchRequest(await request.json())
    const base = await getBaseResult(parsed)
    const result = base.result
    const stageFiltered = filterTriggerDiscoveryRowsByStage(result.rows, parsed.request.stageFilters)
    const statusFiltered = parsed.request.statusFilter
      ? stageFiltered.filter((row) => row.triggerStatus === parsed.request.statusFilter)
      : stageFiltered
    const sorted = sortTriggerDiscoveryRows(
      statusFiltered,
      parsed.request.sort?.key,
      parsed.request.sort?.direction,
    )
    const offset = (parsed.page - 1) * parsed.pageSize
    const pageRows = sorted.slice(offset, offset + parsed.pageSize)
    const isLatest = result.resolvedAsOf != null && result.resolvedAsOf === base.latestAsOf
    const response: UsTriggerDiscoverySearchResponse = {
      contractVersion: 'us-trigger-discovery-search-v1',
      market: 'US',
      currency: 'USD',
      meta: {
        requestedAsOf: result.requestedAsOf,
        resolvedAsOf: result.resolvedAsOf,
        latestAsOf: base.latestAsOf,
        isLatest,
        universeBasis: isLatest ? 'CURRENT_ACTIVE' : 'TRADING_COVERAGE',
        classificationAvailability: isLatest ? 'CURRENT' : 'UNAVAILABLE',
        pitUniverseCount: result.diagnostics.counts.universe,
        currentPriceCount: result.diagnostics.counts.currentPrice,
        staleAcceptedCount: result.diagnostics.counts.staleAccepted,
        triggerEvaluatedCount: result.diagnostics.counts.evaluated,
        triggerMatchedCount: result.totalTriggerMatched,
        insufficientHistoryCount: result.diagnostics.rejected.INSUFFICIENT_HISTORY,
        rejected: result.diagnostics.rejected,
        matchedCount: sorted.length,
        returnedCount: pageRows.length,
        page: parsed.page,
        pageSize: parsed.pageSize,
        totalPages: sorted.length === 0 ? 0 : Math.ceil(sorted.length / parsed.pageSize),
        timeframe: parsed.timeframe,
      },
      criteria: {
        ma1Period: result.triggerConfig.ma1Period,
        ma2Period: result.triggerConfig.ma2Period,
        maxApproachDistancePct: result.triggerConfig.maxApproachDistancePct,
        nearDistancePct: result.triggerConfig.nearDistancePct,
        spreadExpansionEnabled: result.triggerConfig.spreadExpansionEnabled,
        spreadLookbackIntervals: result.triggerConfig.spreadLookbackIntervals,
        minExpansionRatio: result.triggerConfig.minExpansionRatio,
        requireBullishMaOrder: result.triggerConfig.requireBullishMaOrder,
        belowZoneToleranceEnabled: result.triggerConfig.belowZoneToleranceEnabled,
        maxBelowZonePct: result.triggerConfig.maxBelowZonePct,
        statusFilter: parsed.request.statusFilter ?? null,
        liquidityLookbackSessions: result.liquidityLookbackSessions,
        markets: parsed.request.markets ?? null,
        stageFilters: parsed.request.stageFilters ?? {},
        sort: parsed.request.sort ?? null,
      },
      rows: pageRows.map((row) => ({
        ticker: row.ticker,
        companyName: row.companyName,
        market: row.market,
        price: row.price,
        triggerStatus: row.triggerStatus,
        zoneDistancePct: row.zoneDistancePct,
        ma1DistancePct: row.ma1DistancePct,
        ma2DistancePct: row.ma2DistancePct,
        maSpreadPct: row.maSpreadPct,
        maSpreadSlope: row.maSpreadSlope,
        maSpreadExpansionRatio: row.maSpreadExpansionRatio,
        maSpreadExpanding: row.maSpreadExpanding,
        bullishMaOrder: row.bullishMaOrder,
        spreadExpansionAvailable: row.spreadExpansionAvailable,
        averageVolume: row.averageVolume,
        averageTradingValue: row.averageTradingValue,
        triggerScore: row.triggerScore,
        scoreBreakdown: row.scoreBreakdown,
        dayAStage: row.dayAStage,
        dayBStage: row.dayBStage,
        weekAStage: row.weekAStage,
        weekBStage: row.weekBStage,
        monthAStage: row.monthAStage,
        monthBStage: row.monthBStage,
        stageAvailable: row.stageAvailable,
        stageComplete: row.stageComplete,
        priceDate: row.priceDate,
        maDate: row.maDate,
        stageDate: row.stageDate,
        priceFreshness: row.priceFreshness,
        priceStalenessSessions: row.priceStalenessSessions,
        ma1Period: row.ma1Period,
        ma2Period: row.ma2Period,
      })),
      performance: {
        totalMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        dbQueryMs: base.cacheHit ? 0 : result.diagnostics.performance.dbQueryMs,
        maPreparationMs: base.cacheHit ? 0 : result.diagnostics.performance.maPreparationMs,
        engineEvaluationMs: base.cacheHit ? 0 : result.diagnostics.performance.engineEvaluationMs,
        stageJoinMs: base.cacheHit ? 0 : result.diagnostics.performance.stageJoinMs,
        queryCount: base.cacheHit ? 0 : result.diagnostics.performance.queryCount,
        cacheHit: base.cacheHit,
      },
    }
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `us-trigger-discovery;dur=${response.performance.totalMs}`,
      },
    })
  } catch (error) {
    if (error instanceof UsTriggerHistoricalFilterError) {
      return NextResponse.json({
        error: 'historical_exchange_unavailable',
        message: error.message,
      }, { status: 422 })
    }
    if (error instanceof TriggerDiscoveryInputError || error instanceof TriggerConfigError
      || error instanceof SyntaxError) {
      return NextResponse.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    console.error('[us/trigger-discovery/search]', error)
    return NextResponse.json({
      error: 'us_trigger_discovery_failed',
      message: 'US条件トリガーを取得できませんでした。時間をおいて再度お試しください。',
    }, { status: 500 })
  }
}
