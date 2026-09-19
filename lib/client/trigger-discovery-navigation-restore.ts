import type {
  TriggerDiscoverySearchRequest,
  TriggerDiscoverySearchResponse,
  TriggerDiscoveryStageFilters,
} from '@/lib/trigger-discovery-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { SavedTriggerViewConfig } from '@/lib/trigger-definition'

export const TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY = 'stockboard:trigger-discovery:navigation-restore:v1'
export const TRIGGER_DISCOVERY_NAVIGATION_HISTORY_KEY = '__stockboardTriggerDiscoveryReturnV1'
export const TRIGGER_DISCOVERY_NAVIGATION_VERSION = 'trigger-discovery-navigation-v1'
export const TRIGGER_DISCOVERY_NAVIGATION_TTL_MS = 30 * 60 * 1000

export interface TriggerDiscoveryNavigationDraft {
  asOf: string
  ma1Period: string
  ma2Period: string
  maxDistance: string
  nearDistance: string
  spreadExpansionEnabled: boolean
  spreadLookbackIntervals: string
  minExpansionRatioPct: string
  requireBullishMaOrder: boolean
  belowZoneToleranceEnabled?: boolean
  maxBelowZonePct?: string
  priceMin: string
  priceMax: string
  averageVolumeMin: string
  averageVolumeMax: string
  averageTradingValueMin: string
  averageTradingValueMax: string
  liquidityLookbackSessions: string
}

export interface TriggerDiscoveryNavigationPayload {
  mode: 'current'
  timeframe: TriggerDiscoveryTimeframe
  draft: TriggerDiscoveryNavigationDraft
  selectedMarkets: Array<string | null>
  stageFilters: TriggerDiscoveryStageFilters
  effectiveEngineConfig: {
    slopeLookbackSessions: number
    approachLookbackSessions: number
    minimumAboveZoneRatio: number
    maxPriceStalenessSessions: number
  }
  viewConfig: SavedTriggerViewConfig
  response: TriggerDiscoverySearchResponse
  lastRequest: TriggerDiscoverySearchRequest
  builderOpen: boolean
  selectedSavedId: string
  activeSavedId: string | null
  scroll: {
    windowY: number
    resultsTableX: number
    resultsTableY: number
  }
}

export interface TriggerDiscoveryNavigationEnvelope {
  version: typeof TRIGGER_DISCOVERY_NAVIGATION_VERSION
  savedAt: number
  returnToken: string
  returnUrl: string
  payload: TriggerDiscoveryNavigationPayload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNavigationPayload(value: unknown): value is TriggerDiscoveryNavigationPayload {
  if (!isRecord(value) || value.mode !== 'current') return false
  if (value.timeframe !== 'MONTHLY' && value.timeframe !== 'BIWEEKLY') return false
  if (!isRecord(value.draft) || !Array.isArray(value.selectedMarkets) || !isRecord(value.stageFilters)) return false
  if (!isRecord(value.effectiveEngineConfig) || !isRecord(value.viewConfig)) return false
  if (!isRecord(value.response) || value.response.contractVersion !== 'trigger-discovery-search-v1') return false
  if (!isRecord(value.response.meta) || !Array.isArray(value.response.rows)) return false
  if (!isRecord(value.lastRequest) || typeof value.lastRequest.requestedAsOf !== 'string') return false
  if (typeof value.builderOpen !== 'boolean' || typeof value.selectedSavedId !== 'string') return false
  if (value.activeSavedId !== null && typeof value.activeSavedId !== 'string') return false
  if (!isRecord(value.scroll)) return false
  return Number.isFinite(value.scroll.windowY)
    && Number.isFinite(value.scroll.resultsTableX)
    && Number.isFinite(value.scroll.resultsTableY)
}

export function serializeTriggerDiscoveryNavigationSnapshot(input: {
  returnToken: string
  returnUrl: string
  payload: TriggerDiscoveryNavigationPayload
  savedAt?: number
}): string {
  return JSON.stringify({
    version: TRIGGER_DISCOVERY_NAVIGATION_VERSION,
    savedAt: input.savedAt ?? Date.now(),
    returnToken: input.returnToken,
    returnUrl: input.returnUrl,
    payload: input.payload,
  } satisfies TriggerDiscoveryNavigationEnvelope)
}

export function parseTriggerDiscoveryNavigationSnapshot(input: {
  serialized: string | null
  historyToken: unknown
  currentUrl: string
  now?: number
}): TriggerDiscoveryNavigationEnvelope | null {
  if (!input.serialized || typeof input.historyToken !== 'string') return null
  const now = input.now ?? Date.now()
  try {
    const value = JSON.parse(input.serialized) as unknown
    if (!isRecord(value)) return null
    if (value.version !== TRIGGER_DISCOVERY_NAVIGATION_VERSION) return null
    if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
    if (value.savedAt > now + 60_000 || now - value.savedAt > TRIGGER_DISCOVERY_NAVIGATION_TTL_MS) return null
    if (value.returnToken !== input.historyToken || typeof value.returnUrl !== 'string') return null
    if (value.returnUrl !== input.currentUrl || !isNavigationPayload(value.payload)) return null
    return value as unknown as TriggerDiscoveryNavigationEnvelope
  } catch {
    return null
  }
}
