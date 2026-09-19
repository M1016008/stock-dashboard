import { NextRequest, NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import type { TriggerDiscoverySearchResponse } from '@/lib/trigger-discovery-contract'
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

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 6
const globalForTriggerSearch = globalThis as typeof globalThis & {
  triggerDiscoverySearchCache?: Map<string, { expiresAt: number; result: TriggerDiscoveryResult }>
}

async function getBaseResult(parsed: ReturnType<typeof parseTriggerDiscoverySearchRequest>): Promise<{
  result: TriggerDiscoveryResult
  cacheHit: boolean
}> {
  const cache = globalForTriggerSearch.triggerDiscoverySearchCache ?? new Map()
  globalForTriggerSearch.triggerDiscoverySearchCache = cache
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  const key = triggerDiscoveryBaseSearchKey(parsed.input, parsed.timeframe)
  const cached = cache.get(key)
  if (cached) return { result: cached.result, cacheHit: true }
  const result = await getTriggerDiscovery({
      ...parsed.input,
      stageFilters: undefined,
      sortBy: undefined,
      sortDirection: undefined,
      limit: 10_000,
      offset: 0,
    }, { timeframe: parsed.timeframe })
  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS })
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return { result, cacheHit: false }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const parsed = parseTriggerDiscoverySearchRequest(await request.json())
    const base = await getBaseResult(parsed)
    const result = base.result
    const stageFiltered = filterTriggerDiscoveryRowsByStage(result.rows, parsed.request.stageFilters)
    const sorted = sortTriggerDiscoveryRows(
      stageFiltered,
      parsed.request.sort?.key,
      parsed.request.sort?.direction,
    )
    const offset = (parsed.page - 1) * parsed.pageSize
    const pageRows = sorted.slice(offset, offset + parsed.pageSize)
    const response: TriggerDiscoverySearchResponse = {
      contractVersion: 'trigger-discovery-search-v1',
      meta: {
        requestedAsOf: result.requestedAsOf,
        resolvedAsOf: result.resolvedAsOf,
        timeframe: parsed.timeframe,
        pitUniverseCount: result.diagnostics.counts.universe,
        currentPriceCount: result.diagnostics.counts.currentPrice,
        staleAcceptedCount: result.diagnostics.counts.staleAccepted,
        triggerEvaluatedCount: result.diagnostics.counts.evaluated,
        triggerMatchedCount: result.totalTriggerMatched,
        matchedCount: sorted.length,
        returnedCount: pageRows.length,
        page: parsed.page,
        pageSize: parsed.pageSize,
        totalPages: sorted.length === 0 ? 0 : Math.ceil(sorted.length / parsed.pageSize),
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
        totalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
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
        'Server-Timing': `trigger-discovery;dur=${response.performance.totalMs}`,
      },
    })
  } catch (error) {
    if (error instanceof TriggerDiscoveryInputError || error instanceof TriggerConfigError
      || error instanceof SyntaxError) {
      return NextResponse.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    console.error('[trigger-discovery/search]', error)
    return NextResponse.json({
      error: 'trigger_discovery_failed',
      message: 'Trigger候補を取得できませんでした。時間をおいて再度お試しください。',
    }, { status: 500 })
  }
}
