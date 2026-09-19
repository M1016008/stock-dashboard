import {
  TRIGGER_DISCOVERY_SORT_KEYS,
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoverySortDirection,
  type TriggerDiscoverySortKey,
  type TriggerDiscoveryStageFilters,
  type TriggerDiscoveryStageFilterValue,
} from '@/lib/trigger-discovery-contract'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  TRIGGER_ENGINE_VERSION,
  validateMaZoneTriggerConfig,
} from '@/lib/trigger-discovery-engine'
import { TRIGGER_SCORE_VERSION } from '@/lib/trigger-score'
import {
  DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'

export const SAVED_TRIGGER_CONTRACT_VERSION = 'saved-trigger-definition-v1'
export const SAVED_TRIGGER_EVALUATION_CONFIG_VERSION = 2
export const SAVED_TRIGGER_NAME_MAX_LENGTH = 80
export const SAVED_TRIGGER_PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS = 3
export const DEFAULT_TRIGGER_LIQUIDITY_LOOKBACK_SESSIONS = 20

export interface SavedTriggerEvaluationConfig {
  timeframe: TriggerDiscoveryTimeframe
  triggerCore: {
    ma1Period: number
    ma2Period: number
    bothRising: true
    fromAbove: true
    slopeLookbackSessions: number
    approachLookbackSessions: number
    minimumAboveZoneRatio: number
    maxApproachDistancePct: number
    nearDistancePct: number
    spreadExpansionEnabled: boolean
    spreadLookbackIntervals: number
    minExpansionRatio: number
    requireBullishMaOrder: boolean
    belowZoneToleranceEnabled: boolean
    maxBelowZonePct: number
  }
  universe: {
    markets: Array<string | null>
    priceMin: number | null
    priceMax: number | null
    averageVolumeMin: number | null
    averageVolumeMax: number | null
    averageTradingValueMin: number | null
    averageTradingValueMax: number | null
    liquidityLookbackSessions: number
    maxPriceStalenessSessions: number
  }
  stageFilters: TriggerDiscoveryStageFilters
}

export interface SavedTriggerViewConfig {
  sort: {
    key: TriggerDiscoverySortKey
    direction: TriggerDiscoverySortDirection
  } | null
  pageSize: (typeof SAVED_TRIGGER_PAGE_SIZES)[number]
  statusFilter?: TriggerDiscoverySearchRequest['statusFilter']
}

export interface SavedTriggerDefinition {
  id: string
  name: string
  evaluationConfig: SavedTriggerEvaluationConfig
  viewConfig: SavedTriggerViewConfig
  evaluationVersion: number
  engineVersion: number
  scoreVersion: number
  evaluationSignature: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface SavedTriggerListResponse {
  contractVersion: typeof SAVED_TRIGGER_CONTRACT_VERSION
  definitions: SavedTriggerDefinition[]
}

export interface SavedTriggerDetailResponse {
  contractVersion: typeof SAVED_TRIGGER_CONTRACT_VERSION
  definition: SavedTriggerDefinition
}

export class SavedTriggerValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedTriggerValidationError'
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SavedTriggerValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SavedTriggerValidationError(`${label} must be a finite number`)
  }
  return value
}

function integer(value: unknown, label: string, min: number, max: number): number {
  const parsed = finiteNumber(value, label)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SavedTriggerValidationError(`${label} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value == null) return fallback
  if (typeof value !== 'boolean') {
    throw new SavedTriggerValidationError(`${label} must be a boolean`)
  }
  return value
}

function optionalNonNegative(value: unknown, label: string): number | null {
  if (value == null || value === '') return null
  const parsed = finiteNumber(value, label)
  if (parsed < 0) throw new SavedTriggerValidationError(`${label} must be zero or greater`)
  return parsed
}

function validateRange(min: number | null, max: number | null, label: string): void {
  if (min != null && max != null && min > max) {
    throw new SavedTriggerValidationError(`${label} minimum must not exceed maximum`)
  }
}

export function canonicalizeTriggerMarkets(value: unknown, allowedMarkets?: ReadonlySet<string | null>): Array<string | null> {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 50) {
    throw new SavedTriggerValidationError('markets must be an array with at most 50 values')
  }
  const normalized = value.map((entry) => {
    if (entry === null) return null
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new SavedTriggerValidationError('markets contains an invalid value')
    }
    return entry.trim()
  })
  const unique = [...new Set(normalized)].sort((left, right) => {
    if (left === null) return -1
    if (right === null) return 1
    return left.localeCompare(right, 'ja')
  })
  if (allowedMarkets && unique.some((market) => !allowedMarkets.has(market))) {
    throw new SavedTriggerValidationError('markets contains an unsupported market')
  }
  return unique
}

export function canonicalizeTriggerStageFilters(value: unknown): TriggerDiscoveryStageFilters {
  if (value == null) return {}
  const source = asRecord(value, 'stageFilters')
  for (const key of Object.keys(source)) {
    if (!TRIGGER_DISCOVERY_STAGE_AXES.includes(key as (typeof TRIGGER_DISCOVERY_STAGE_AXES)[number])) {
      throw new SavedTriggerValidationError(`unknown Stage axis: ${key}`)
    }
  }
  const result: TriggerDiscoveryStageFilters = {}
  for (const axis of TRIGGER_DISCOVERY_STAGE_AXES) {
    const raw = source[axis]
    if (raw == null) continue
    if (!Array.isArray(raw)) throw new SavedTriggerValidationError(`${axis} must be an array`)
    const values = raw.map((entry): TriggerDiscoveryStageFilterValue => {
      if (entry === 'unknown') return entry
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 6) {
        throw new SavedTriggerValidationError(`${axis} must contain Stage 1-6 or unknown`)
      }
      return entry as TriggerDiscoveryStageFilterValue
    })
    const unique = [...new Set(values)].sort((left, right) => {
      if (left === 'unknown') return 1
      if (right === 'unknown') return -1
      return left - right
    })
    if (unique.length) result[axis] = unique
  }
  return result
}

export function canonicalizeSavedTriggerEvaluationConfig(
  value: unknown,
  options: { allowedMarkets?: ReadonlySet<string | null>; allowLegacyTimeframe?: boolean } = {},
): SavedTriggerEvaluationConfig {
  const source = asRecord(value, 'evaluationConfig')
  const timeframe = source.timeframe == null
    ? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME
    : source.timeframe === 'monthly' && options.allowLegacyTimeframe
      ? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME
      : source.timeframe
  if (timeframe !== 'MONTHLY' && timeframe !== 'BIWEEKLY') {
    throw new SavedTriggerValidationError('timeframe must be MONTHLY or BIWEEKLY')
  }
  const core = asRecord(source.triggerCore, 'triggerCore')
  if (core.bothRising !== true || core.fromAbove !== true) {
    throw new SavedTriggerValidationError('bothRising and fromAbove must be true')
  }
  const triggerCore: SavedTriggerEvaluationConfig['triggerCore'] = {
    ma1Period: integer(core.ma1Period, 'ma1Period', 2, 120),
    ma2Period: integer(core.ma2Period, 'ma2Period', 2, 120),
    bothRising: true,
    fromAbove: true,
    slopeLookbackSessions: integer(core.slopeLookbackSessions, 'slopeLookbackSessions', 1, 120),
    approachLookbackSessions: integer(core.approachLookbackSessions, 'approachLookbackSessions', 2, 120),
    minimumAboveZoneRatio: finiteNumber(core.minimumAboveZoneRatio, 'minimumAboveZoneRatio'),
    maxApproachDistancePct: finiteNumber(core.maxApproachDistancePct, 'maxApproachDistancePct'),
    nearDistancePct: finiteNumber(core.nearDistancePct, 'nearDistancePct'),
    spreadExpansionEnabled: optionalBoolean(
      core.spreadExpansionEnabled,
      'spreadExpansionEnabled',
      DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadExpansionEnabled,
    ),
    spreadLookbackIntervals: integer(
      core.spreadLookbackIntervals ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals,
      'spreadLookbackIntervals',
      2,
      24,
    ),
    minExpansionRatio: finiteNumber(
      core.minExpansionRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio,
      'minExpansionRatio',
    ),
    requireBullishMaOrder: optionalBoolean(
      core.requireBullishMaOrder,
      'requireBullishMaOrder',
      DEFAULT_MA_ZONE_TRIGGER_CONFIG.requireBullishMaOrder,
    ),
    belowZoneToleranceEnabled: optionalBoolean(
      core.belowZoneToleranceEnabled,
      'belowZoneToleranceEnabled',
      DEFAULT_MA_ZONE_TRIGGER_CONFIG.belowZoneToleranceEnabled,
    ),
    maxBelowZonePct: finiteNumber(
      core.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct,
      'maxBelowZonePct',
    ),
  }
  try {
    validateMaZoneTriggerConfig({
      ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
      ...triggerCore,
    })
  } catch (error) {
    throw new SavedTriggerValidationError(error instanceof Error ? error.message : String(error))
  }
  const universeSource = asRecord(source.universe, 'universe')
  const universe: SavedTriggerEvaluationConfig['universe'] = {
    markets: canonicalizeTriggerMarkets(universeSource.markets, options.allowedMarkets),
    priceMin: optionalNonNegative(universeSource.priceMin, 'priceMin'),
    priceMax: optionalNonNegative(universeSource.priceMax, 'priceMax'),
    averageVolumeMin: optionalNonNegative(universeSource.averageVolumeMin, 'averageVolumeMin'),
    averageVolumeMax: optionalNonNegative(universeSource.averageVolumeMax, 'averageVolumeMax'),
    averageTradingValueMin: optionalNonNegative(universeSource.averageTradingValueMin, 'averageTradingValueMin'),
    averageTradingValueMax: optionalNonNegative(universeSource.averageTradingValueMax, 'averageTradingValueMax'),
    liquidityLookbackSessions: integer(universeSource.liquidityLookbackSessions, 'liquidityLookbackSessions', 1, 252),
    maxPriceStalenessSessions: integer(universeSource.maxPriceStalenessSessions, 'maxPriceStalenessSessions', 0, 60),
  }
  validateRange(universe.priceMin, universe.priceMax, 'price')
  validateRange(universe.averageVolumeMin, universe.averageVolumeMax, 'averageVolume')
  validateRange(universe.averageTradingValueMin, universe.averageTradingValueMax, 'averageTradingValue')
  return {
    timeframe,
    triggerCore,
    universe,
    stageFilters: canonicalizeTriggerStageFilters(source.stageFilters),
  }
}

export function canonicalizeSavedTriggerViewConfig(value: unknown): SavedTriggerViewConfig {
  const source = asRecord(value, 'viewConfig')
  const pageSize = source.pageSize
  if (typeof pageSize !== 'number' || !SAVED_TRIGGER_PAGE_SIZES.includes(pageSize as never)) {
    throw new SavedTriggerValidationError('pageSize must be 25, 50 or 100')
  }
  let sort: SavedTriggerViewConfig['sort'] = null
  if (source.sort != null) {
    const sortSource = asRecord(source.sort, 'sort')
    if (!TRIGGER_DISCOVERY_SORT_KEYS.includes(sortSource.key as never)
      || (sortSource.direction !== 'asc' && sortSource.direction !== 'desc')) {
      throw new SavedTriggerValidationError('sort contains an invalid key or direction')
    }
    sort = {
      key: sortSource.key as TriggerDiscoverySortKey,
      direction: sortSource.direction,
    }
  }
  const statusFilter = source.statusFilter ?? null
  if (statusFilter !== null && statusFilter !== 'APPROACHING' && statusFilter !== 'NEAR'
    && statusFilter !== 'IN_ZONE' && statusFilter !== 'BELOW_ZONE') {
    throw new SavedTriggerValidationError('statusFilter must be APPROACHING, NEAR, IN_ZONE or BELOW_ZONE')
  }
  return {
    sort, pageSize: pageSize as SavedTriggerViewConfig['pageSize'],
    ...(statusFilter ? { statusFilter: statusFilter as SavedTriggerViewConfig['statusFilter'] } : {}),
  }
}

export function savedTriggerConfigsFromSearchRequest(request: TriggerDiscoverySearchRequest): {
  evaluationConfig: SavedTriggerEvaluationConfig
  viewConfig: SavedTriggerViewConfig
} {
  return {
    evaluationConfig: canonicalizeSavedTriggerEvaluationConfig({
      timeframe: request.timeframe ?? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
      triggerCore: {
        ma1Period: request.ma1Period ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.ma1Period,
        ma2Period: request.ma2Period ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.ma2Period,
        bothRising: true,
        fromAbove: true,
        slopeLookbackSessions: request.slopeLookbackSessions ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.slopeLookbackSessions,
        approachLookbackSessions: request.approachLookbackSessions ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.approachLookbackSessions,
        minimumAboveZoneRatio: request.minimumAboveZoneRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minimumAboveZoneRatio,
        maxApproachDistancePct: request.maxApproachDistancePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxApproachDistancePct,
        nearDistancePct: request.nearDistancePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.nearDistancePct,
        spreadExpansionEnabled: request.spreadExpansionEnabled
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadExpansionEnabled,
        spreadLookbackIntervals: request.spreadLookbackIntervals
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals,
        minExpansionRatio: request.minExpansionRatio
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio,
        requireBullishMaOrder: request.requireBullishMaOrder
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.requireBullishMaOrder,
        belowZoneToleranceEnabled: request.belowZoneToleranceEnabled
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.belowZoneToleranceEnabled,
        maxBelowZonePct: request.maxBelowZonePct
          ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct,
      },
      universe: {
        markets: request.markets ?? [],
        priceMin: request.priceMin ?? null,
        priceMax: request.priceMax ?? null,
        averageVolumeMin: request.averageVolumeMin ?? null,
        averageVolumeMax: request.averageVolumeMax ?? null,
        averageTradingValueMin: request.averageTradingValueMin ?? null,
        averageTradingValueMax: request.averageTradingValueMax ?? null,
        liquidityLookbackSessions: request.liquidityLookbackSessions ?? DEFAULT_TRIGGER_LIQUIDITY_LOOKBACK_SESSIONS,
        maxPriceStalenessSessions: request.maxPriceStalenessSessions ?? DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS,
      },
      stageFilters: request.stageFilters ?? {},
    }),
    viewConfig: canonicalizeSavedTriggerViewConfig({
      sort: request.sort ?? null,
      pageSize: request.pageSize ?? 50,
      statusFilter: request.statusFilter ?? null,
    }),
  }
}

export function searchRequestFromSavedTrigger(
  definition: Pick<SavedTriggerDefinition, 'evaluationConfig' | 'viewConfig'>,
  requestedAsOf: string,
): TriggerDiscoverySearchRequest {
  const { timeframe, triggerCore, universe, stageFilters } = definition.evaluationConfig
  return {
    requestedAsOf,
    timeframe,
    ma1Period: triggerCore.ma1Period,
    ma2Period: triggerCore.ma2Period,
    slopeLookbackSessions: triggerCore.slopeLookbackSessions,
    approachLookbackSessions: triggerCore.approachLookbackSessions,
    minimumAboveZoneRatio: triggerCore.minimumAboveZoneRatio,
    maxApproachDistancePct: triggerCore.maxApproachDistancePct,
    nearDistancePct: triggerCore.nearDistancePct,
    spreadExpansionEnabled: triggerCore.spreadExpansionEnabled,
    spreadLookbackIntervals: triggerCore.spreadLookbackIntervals,
    minExpansionRatio: triggerCore.minExpansionRatio,
    requireBullishMaOrder: triggerCore.requireBullishMaOrder,
    belowZoneToleranceEnabled: triggerCore.belowZoneToleranceEnabled,
    maxBelowZonePct: triggerCore.maxBelowZonePct,
    markets: universe.markets.length ? universe.markets : undefined,
    priceMin: universe.priceMin,
    priceMax: universe.priceMax,
    averageVolumeMin: universe.averageVolumeMin,
    averageVolumeMax: universe.averageVolumeMax,
    averageTradingValueMin: universe.averageTradingValueMin,
    averageTradingValueMax: universe.averageTradingValueMax,
    liquidityLookbackSessions: universe.liquidityLookbackSessions,
    maxPriceStalenessSessions: universe.maxPriceStalenessSessions,
    stageFilters,
    sort: definition.viewConfig.sort,
    page: 1,
    pageSize: definition.viewConfig.pageSize,
    statusFilter: definition.viewConfig.statusFilter,
  }
}

export function savedTriggerVersions(): { engineVersion: number; scoreVersion: number } {
  return { engineVersion: TRIGGER_ENGINE_VERSION, scoreVersion: TRIGGER_SCORE_VERSION }
}
