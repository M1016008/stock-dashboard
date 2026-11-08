import { NextRequest, NextResponse } from 'next/server'
import type { MarketCode } from '@/lib/markets'
import {
  SAVED_TRIGGER_CONTRACT_VERSION,
  SavedTriggerValidationError,
  type SavedTriggerDetailResponse,
  type SavedTriggerListResponse,
} from '@/lib/trigger-definition'
import {
  TRIGGER_NOTIFICATION_CONTRACT_VERSION,
  TriggerNotificationValidationError,
  type TriggerNotificationSettingsResponse,
} from '@/lib/trigger-notification'
import type { TriggerDiscoverySearchResponse, TriggerDiscoverySearchRow } from '@/lib/trigger-discovery-contract'
import {
  TriggerDiscoveryInputError,
  filterTriggerDiscoveryRowsByStage,
  sortTriggerDiscoveryRows,
  type TriggerDiscoveryInput,
  type TriggerDiscoveryResult,
} from '@/lib/server/trigger-discovery-read-model'
import type { parseTriggerDiscoverySearchRequest } from '@/lib/server/trigger-discovery-search-request'
import {
  SavedTriggerNotFoundError,
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  getSavedTriggerDefinition,
  listSavedTriggerDefinitions,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import {
  TriggerEvaluationInProgressError,
  evaluateSavedTriggerDefinition,
} from '@/lib/server/trigger-evaluations'
import {
  getTriggerNotificationSettings,
  updateTriggerNotificationSettings,
} from '@/lib/server/trigger-notification-settings'

// Shared handlers for the JP (/api/trigger-discovery/saved/**) and US
// (/api/us/trigger-discovery/saved/**) saved Trigger routes. Route segment
// config stays in each route.ts; only the handler bodies live here.

export type TriggerDiscoveryRouteMarket = Extract<MarketCode, 'JP' | 'US'>

type SavedTriggerRouteContext = { params: Promise<{ id: string }> }

interface MarketRouteProfile {
  market: TriggerDiscoveryRouteMarket
  logScope: string
  serverTiming: boolean
}

const PROFILES: Record<TriggerDiscoveryRouteMarket, MarketRouteProfile> = {
  JP: { market: 'JP', logScope: 'trigger-discovery', serverTiming: true },
  US: { market: 'US', logScope: 'us/trigger-discovery', serverTiming: false },
}

function responseHeaders(
  profile: MarketRouteProfile,
  cacheControl: string,
  timing?: { name: string, startedAt: number },
): Record<string, string> {
  if (!profile.serverTiming || !timing) return { 'Cache-Control': cacheControl }
  return {
    'Cache-Control': cacheControl,
    'Server-Timing': `${timing.name};dur=${(performance.now() - timing.startedAt).toFixed(3)}`,
  }
}

function invalidJsonResponse(): NextResponse {
  return NextResponse.json({ error: 'invalid_request', message: 'JSON形式が正しくありません。' }, { status: 400 })
}

function savedTriggerErrorResponse(profile: MarketRouteProfile, error: unknown, action: string): NextResponse {
  if (error instanceof SavedTriggerValidationError) {
    return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
  }
  if (error instanceof SavedTriggerNotFoundError) {
    return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
  }
  console.error(`[${profile.logScope}/saved:${action}]`, error)
  return NextResponse.json({
    error: `saved_trigger_${action}_failed`,
    message: '保存済みTriggerを処理できませんでした。',
  }, { status: 500 })
}

function notificationSettingsErrorResponse(profile: MarketRouteProfile, error: unknown): NextResponse {
  if (error instanceof TriggerNotificationValidationError || error instanceof SavedTriggerValidationError) {
    return NextResponse.json({ error: 'invalid_notification_settings', message: error.message }, { status: 400 })
  }
  if (error instanceof SavedTriggerNotFoundError) {
    return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
  }
  console.error(`[${profile.logScope}/notification-settings]`, error)
  return NextResponse.json({
    error: 'notification_settings_failed',
    message: '通知設定を処理できませんでした。',
  }, { status: 500 })
}

/** /saved — GET list, POST create */
export function savedTriggerCollectionHandlers(market: TriggerDiscoveryRouteMarket) {
  const profile = PROFILES[market]

  async function GET() {
    const startedAt = performance.now()
    try {
      const response: SavedTriggerListResponse = {
        contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
        definitions: await listSavedTriggerDefinitions(profile.market),
      }
      return NextResponse.json(response, {
        headers: responseHeaders(profile, 'private, max-age=0, must-revalidate', { name: 'saved-trigger-list', startedAt }),
      })
    } catch (error) {
      console.error(`[${profile.logScope}/saved:list]`, error)
      return NextResponse.json({
        error: 'saved_trigger_list_failed',
        message: '保存済みTriggerを取得できませんでした。',
      }, { status: 500 })
    }
  }

  async function POST(request: NextRequest) {
    const startedAt = performance.now()
    try {
      const body = await request.json() as Record<string, unknown>
      const response: SavedTriggerDetailResponse = {
        contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
        definition: await createSavedTriggerDefinition({
          market: profile.market,
          name: body.name,
          evaluationConfig: body.evaluationConfig,
          viewConfig: body.viewConfig,
        }),
      }
      return NextResponse.json(response, {
        status: 201,
        headers: responseHeaders(profile, 'no-store', { name: 'saved-trigger-create', startedAt }),
      })
    } catch (error) {
      if (error instanceof SyntaxError) return invalidJsonResponse()
      if (error instanceof SavedTriggerValidationError) {
        return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
      }
      console.error(`[${profile.logScope}/saved:create]`, error)
      return NextResponse.json({
        error: 'saved_trigger_create_failed',
        message: 'Trigger条件を保存できませんでした。',
      }, { status: 500 })
    }
  }

  return { GET, POST }
}

/** /saved/[id] — GET read, PATCH update, DELETE archive */
export function savedTriggerDetailHandlers(market: TriggerDiscoveryRouteMarket) {
  const profile = PROFILES[market]

  async function GET(_request: NextRequest, context: SavedTriggerRouteContext) {
    const startedAt = performance.now()
    try {
      const { id } = await context.params
      const response: SavedTriggerDetailResponse = {
        contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
        definition: await getSavedTriggerDefinition(id, profile.market),
      }
      return NextResponse.json(response, {
        headers: responseHeaders(profile, 'private, max-age=0, must-revalidate', { name: 'saved-trigger-read', startedAt }),
      })
    } catch (error) {
      return savedTriggerErrorResponse(profile, error, 'read')
    }
  }

  async function PATCH(request: NextRequest, context: SavedTriggerRouteContext) {
    const startedAt = performance.now()
    try {
      const { id } = await context.params
      const body = await request.json() as Record<string, unknown>
      const response: SavedTriggerDetailResponse = {
        contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
        definition: await updateSavedTriggerDefinition(id, {
          name: body.name,
          evaluationConfig: body.evaluationConfig,
          viewConfig: body.viewConfig,
        }, profile.market),
      }
      return NextResponse.json(response, {
        headers: responseHeaders(profile, 'no-store', { name: 'saved-trigger-update', startedAt }),
      })
    } catch (error) {
      if (error instanceof SyntaxError) return invalidJsonResponse()
      return savedTriggerErrorResponse(profile, error, 'update')
    }
  }

  async function DELETE(_request: NextRequest, context: SavedTriggerRouteContext) {
    const startedAt = performance.now()
    try {
      const { id } = await context.params
      await archiveSavedTriggerDefinition(id, profile.market)
      return NextResponse.json({
        contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
        id,
        archived: true,
      }, {
        headers: responseHeaders(profile, 'no-store', { name: 'saved-trigger-archive', startedAt }),
      })
    } catch (error) {
      return savedTriggerErrorResponse(profile, error, 'archive')
    }
  }

  return { GET, PATCH, DELETE }
}

/** /saved/[id]/evaluate — POST */
export function savedTriggerEvaluateHandlers(market: TriggerDiscoveryRouteMarket) {
  const profile = PROFILES[market]

  async function POST(request: NextRequest, context: SavedTriggerRouteContext) {
    const startedAt = performance.now()
    try {
      const { id } = await context.params
      const body = await request.json() as Record<string, unknown>
      if (typeof body.requestedAsOf !== 'string') {
        throw new SavedTriggerValidationError('requestedAsOf is required')
      }
      const response = await evaluateSavedTriggerDefinition(id, body.requestedAsOf, { market: profile.market })
      return NextResponse.json(response, {
        headers: responseHeaders(profile, 'no-store', { name: 'trigger-evaluation', startedAt }),
      })
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SavedTriggerValidationError
        || error instanceof TriggerDiscoveryInputError) {
        return NextResponse.json({ error: 'invalid_trigger_evaluation', message: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 })
      }
      if (error instanceof SavedTriggerNotFoundError) {
        return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
      }
      if (error instanceof TriggerEvaluationInProgressError) {
        return NextResponse.json({ error: 'trigger_evaluation_in_progress', message: error.message }, { status: 409 })
      }
      console.error(`[${profile.logScope}/evaluate]`, error)
      return NextResponse.json({ error: 'trigger_evaluation_failed', message: 'Trigger評価を完了できませんでした。' }, { status: 500 })
    }
  }

  return { POST }
}

/** /saved/[id]/notification-settings — GET, PUT */
export function savedTriggerNotificationSettingsHandlers(market: TriggerDiscoveryRouteMarket) {
  const profile = PROFILES[market]

  async function GET(_request: NextRequest, context: SavedTriggerRouteContext) {
    try {
      const { id } = await context.params
      const response: TriggerNotificationSettingsResponse = {
        contractVersion: TRIGGER_NOTIFICATION_CONTRACT_VERSION,
        settings: await getTriggerNotificationSettings(id, profile.market),
      }
      return NextResponse.json(response, { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } })
    } catch (error) {
      return notificationSettingsErrorResponse(profile, error)
    }
  }

  async function PUT(request: NextRequest, context: SavedTriggerRouteContext) {
    try {
      const { id } = await context.params
      const response: TriggerNotificationSettingsResponse = {
        contractVersion: TRIGGER_NOTIFICATION_CONTRACT_VERSION,
        settings: await updateTriggerNotificationSettings(id, await request.json(), profile.market),
      }
      return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      if (error instanceof SyntaxError) return invalidJsonResponse()
      return notificationSettingsErrorResponse(profile, error)
    }
  }

  return { GET, PUT }
}

// Shared pieces of the JP (/api/trigger-discovery/search) and US
// (/api/us/trigger-discovery/search) search routes. Each route keeps its own
// cache globals, cache key, engine options and response envelope.

type ParsedTriggerDiscoverySearch = ReturnType<typeof parseTriggerDiscoverySearchRequest>

const SEARCH_CACHE_TTL_MS = 60_000
const SEARCH_CACHE_LIMIT = 6

type TriggerDiscoverySearchCacheGlobals = {
  triggerDiscoverySearchCache?: Map<string, { expiresAt: number; result: TriggerDiscoveryResult }>
  triggerDiscoverySearchInFlight?: Map<string, Promise<TriggerDiscoveryResult>>
  usTriggerDiscoverySearchCache?: Map<string, { expiresAt: number; result: TriggerDiscoveryResult }>
  usTriggerDiscoverySearchInFlight?: Map<string, Promise<TriggerDiscoveryResult>>
}

const SEARCH_CACHE_NAMES = {
  JP: { cache: 'triggerDiscoverySearchCache', inFlight: 'triggerDiscoverySearchInFlight' },
  US: { cache: 'usTriggerDiscoverySearchCache', inFlight: 'usTriggerDiscoverySearchInFlight' },
} as const satisfies Record<TriggerDiscoveryRouteMarket, {
  cache: keyof TriggerDiscoverySearchCacheGlobals
  inFlight: keyof TriggerDiscoverySearchCacheGlobals
}>

const globalForTriggerSearch = globalThis as typeof globalThis & TriggerDiscoverySearchCacheGlobals

/** Base (unfiltered, unsorted) evaluation with a 60s TTL cache and in-flight de-duplication. */
export async function getCachedTriggerDiscoveryBase(
  market: TriggerDiscoveryRouteMarket,
  key: string,
  evaluate: () => Promise<TriggerDiscoveryResult>,
): Promise<{ result: TriggerDiscoveryResult; cacheHit: boolean }> {
  const names = SEARCH_CACHE_NAMES[market]
  const cache = globalForTriggerSearch[names.cache] ?? new Map()
  globalForTriggerSearch[names.cache] = cache
  const now = Date.now()
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey)
  }
  const cached = cache.get(key)
  if (cached) return { result: cached.result, cacheHit: true }

  const inFlight = globalForTriggerSearch[names.inFlight] ?? new Map()
  globalForTriggerSearch[names.inFlight] = inFlight
  const pending = inFlight.get(key)
  if (pending) return { result: await pending, cacheHit: true }

  const task = evaluate()
  inFlight.set(key, task)
  try {
    const result = await task
    cache.set(key, { result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
    while (cache.size > SEARCH_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return { result, cacheHit: false }
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
}

/** Input for the cached base evaluation: view filters/sort/paging are applied per request. */
export function triggerDiscoveryBaseInput(parsed: ParsedTriggerDiscoverySearch): TriggerDiscoveryInput {
  return {
    ...parsed.input,
    stageFilters: undefined,
    sortBy: undefined,
    sortDirection: undefined,
    limit: 10_000,
    offset: 0,
  }
}

/** Stage filter → status filter → sort → page slice. */
export function pageTriggerDiscoveryRows(
  result: TriggerDiscoveryResult,
  parsed: ParsedTriggerDiscoverySearch,
): { sorted: TriggerDiscoveryResult['rows']; pageRows: TriggerDiscoveryResult['rows'] } {
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
  return { sorted, pageRows: sorted.slice(offset, offset + parsed.pageSize) }
}

export function triggerDiscoverySearchCriteria(
  result: TriggerDiscoveryResult,
  parsed: ParsedTriggerDiscoverySearch,
): TriggerDiscoverySearchResponse['criteria'] {
  return {
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
  }
}

export function toTriggerDiscoverySearchRow(row: TriggerDiscoveryResult['rows'][number]): TriggerDiscoverySearchRow {
  return {
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
  }
}

/** Engine timings are reported as 0 on a cache hit (no engine work ran for this request). */
export function triggerDiscoverySearchPerformance(
  result: TriggerDiscoveryResult,
  cacheHit: boolean,
  startedAt: number,
): TriggerDiscoverySearchResponse['performance'] {
  return {
    totalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    dbQueryMs: cacheHit ? 0 : result.diagnostics.performance.dbQueryMs,
    maPreparationMs: cacheHit ? 0 : result.diagnostics.performance.maPreparationMs,
    engineEvaluationMs: cacheHit ? 0 : result.diagnostics.performance.engineEvaluationMs,
    stageJoinMs: cacheHit ? 0 : result.diagnostics.performance.stageJoinMs,
    queryCount: cacheHit ? 0 : result.diagnostics.performance.queryCount,
    cacheHit,
  }
}
