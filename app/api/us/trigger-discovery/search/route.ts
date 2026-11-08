import { NextRequest, NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import {
  getTriggerDiscovery,
  TriggerDiscoveryInputError,
  type TriggerDiscoveryResult,
} from '@/lib/server/trigger-discovery-read-model'
import {
  parseTriggerDiscoverySearchRequest,
  triggerDiscoveryBaseSearchKey,
} from '@/lib/server/trigger-discovery-search-request'
import {
  getCachedTriggerDiscoveryBase,
  pageTriggerDiscoveryRows,
  toTriggerDiscoverySearchRow,
  triggerDiscoveryBaseInput,
  triggerDiscoverySearchCriteria,
  triggerDiscoverySearchPerformance,
} from '@/lib/server/trigger-discovery-routes'
import {
  createUsTriggerDiscoveryDataSource,
  getUsTriggerLatestAsOf,
} from '@/lib/server/us-trigger-discovery'
import type { UsTriggerDiscoverySearchResponse } from '@/lib/us-trigger-discovery-contract'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

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
  const key = `US:${triggerDiscoveryBaseSearchKey(parsed.input, parsed.timeframe)}`
  const base = await getCachedTriggerDiscoveryBase(
    'US',
    key,
    () => getTriggerDiscovery(triggerDiscoveryBaseInput(parsed), {
      timeframe: parsed.timeframe,
      maPath: 'generic',
      dataSource: createUsTriggerDiscoveryDataSource(),
    }),
  )
  return { ...base, latestAsOf }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const parsed = parseTriggerDiscoverySearchRequest(await request.json())
    const base = await getBaseResult(parsed)
    const result = base.result
    const { sorted, pageRows } = pageTriggerDiscoveryRows(result, parsed)
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
      criteria: triggerDiscoverySearchCriteria(result, parsed),
      rows: pageRows.map(toTriggerDiscoverySearchRow),
      performance: triggerDiscoverySearchPerformance(result, base.cacheHit, startedAt),
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
