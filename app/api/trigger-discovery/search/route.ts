import { NextRequest, NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import type { TriggerDiscoverySearchResponse } from '@/lib/trigger-discovery-contract'
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

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

async function getBaseResult(parsed: ReturnType<typeof parseTriggerDiscoverySearchRequest>): Promise<{
  result: TriggerDiscoveryResult
  cacheHit: boolean
}> {
  const key = triggerDiscoveryBaseSearchKey(parsed.input, parsed.timeframe)
  return getCachedTriggerDiscoveryBase(
    'JP',
    key,
    () => getTriggerDiscovery(triggerDiscoveryBaseInput(parsed), { timeframe: parsed.timeframe }),
  )
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const parsed = parseTriggerDiscoverySearchRequest(await request.json())
    const base = await getBaseResult(parsed)
    const result = base.result
    const { sorted, pageRows } = pageTriggerDiscoveryRows(result, parsed)
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
      criteria: triggerDiscoverySearchCriteria(result, parsed),
      rows: pageRows.map(toTriggerDiscoverySearchRow),
      performance: triggerDiscoverySearchPerformance(result, base.cacheHit, startedAt),
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
