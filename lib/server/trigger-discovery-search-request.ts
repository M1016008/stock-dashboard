import {
  TRIGGER_DISCOVERY_SORT_KEYS,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoveryStageFilters,
} from '@/lib/trigger-discovery-contract'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  validateMaZoneTriggerConfig,
} from '@/lib/trigger-discovery-engine'
import {
  DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS,
  SavedTriggerValidationError,
  canonicalizeTriggerMarkets,
  canonicalizeTriggerStageFilters,
} from '@/lib/trigger-definition'
import { TriggerDiscoveryInputError, type TriggerDiscoveryInput } from '@/lib/server/trigger-discovery-read-model'
import {
  DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const PAGE_SIZES = new Set([25, 50, 100])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerDiscoveryInputError('request body must be an object')
  }
  return value as Record<string, unknown>
}

function optionalNumber(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key]
  if (value == null || value === '') return value === null ? null : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TriggerDiscoveryInputError(`${key} must be a finite number`)
  }
  return value
}

function integer(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TriggerDiscoveryInputError(`${key} must be an integer`)
  }
  return value
}

function boolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key] ?? fallback
  if (typeof value !== 'boolean') {
    throw new TriggerDiscoveryInputError(`${key} must be a boolean`)
  }
  return value
}

function parseMarkets(value: unknown): Array<string | null> | undefined {
  if (value == null) return undefined
  try {
    return canonicalizeTriggerMarkets(value)
  } catch (error) {
    if (error instanceof SavedTriggerValidationError) {
      throw new TriggerDiscoveryInputError(error.message)
    }
    throw error
  }
}

function parseStageFilters(value: unknown): TriggerDiscoveryStageFilters | undefined {
  if (value == null) return undefined
  try {
    return canonicalizeTriggerStageFilters(value)
  } catch (error) {
    if (error instanceof SavedTriggerValidationError) {
      throw new TriggerDiscoveryInputError(error.message)
    }
    throw error
  }
}

function parseTimeframe(value: unknown): TriggerDiscoveryTimeframe {
  const timeframe = value ?? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME
  if (timeframe !== 'MONTHLY' && timeframe !== 'BIWEEKLY') {
    throw new TriggerDiscoveryInputError('timeframe must be MONTHLY or BIWEEKLY')
  }
  return timeframe
}

export function triggerDiscoveryBaseSearchKey(input: TriggerDiscoveryInput, timeframe: TriggerDiscoveryTimeframe): string {
  return JSON.stringify({
    timeframe,
    asOf: input.asOf,
    triggerConfig: input.triggerConfig,
    markets: input.markets ?? null,
    priceMin: input.priceMin ?? null,
    priceMax: input.priceMax ?? null,
    averageVolumeMin: input.averageVolumeMin ?? null,
    averageVolumeMax: input.averageVolumeMax ?? null,
    averageTradingValueMin: input.averageTradingValueMin ?? null,
    averageTradingValueMax: input.averageTradingValueMax ?? null,
    liquidityLookbackSessions: input.liquidityLookbackSessions,
    maxPriceStalenessSessions: input.maxPriceStalenessSessions,
  })
}

export function parseTriggerDiscoverySearchRequest(value: unknown): {
  request: TriggerDiscoverySearchRequest
  input: TriggerDiscoveryInput
  timeframe: TriggerDiscoveryTimeframe
  page: number
  pageSize: number
} {
  const source = record(value)
  const timeframe = parseTimeframe(source.timeframe)
  const requestedAsOf = source.requestedAsOf
  const parsedDate = typeof requestedAsOf === 'string' ? new Date(`${requestedAsOf}T00:00:00Z`) : null
  if (typeof requestedAsOf !== 'string' || !DATE_PATTERN.test(requestedAsOf)
    || !parsedDate || Number.isNaN(parsedDate.valueOf())
    || parsedDate.toISOString().slice(0, 10) !== requestedAsOf) {
    throw new TriggerDiscoveryInputError('requestedAsOf must use YYYY-MM-DD format')
  }
  const ma1Period = integer(source, 'ma1Period', 20)
  const ma2Period = integer(source, 'ma2Period', 25)
  const slopeLookbackSessions = integer(source, 'slopeLookbackSessions', DEFAULT_MA_ZONE_TRIGGER_CONFIG.slopeLookbackSessions)
  const approachLookbackSessions = integer(source, 'approachLookbackSessions', DEFAULT_MA_ZONE_TRIGGER_CONFIG.approachLookbackSessions)
  const minimumAboveZoneRatio = optionalNumber(source, 'minimumAboveZoneRatio') ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minimumAboveZoneRatio
  const maxApproachDistancePct = optionalNumber(source, 'maxApproachDistancePct') ?? 5
  const nearDistancePct = optionalNumber(source, 'nearDistancePct') ?? 2
  const spreadExpansionEnabled = boolean(
    source,
    'spreadExpansionEnabled',
    DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadExpansionEnabled,
  )
  const spreadLookbackIntervals = integer(
    source,
    'spreadLookbackIntervals',
    DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals,
  )
  const minExpansionRatio = optionalNumber(source, 'minExpansionRatio')
    ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio
  const requireBullishMaOrder = boolean(
    source,
    'requireBullishMaOrder',
    DEFAULT_MA_ZONE_TRIGGER_CONFIG.requireBullishMaOrder,
  )
  const belowZoneToleranceEnabled = boolean(source, 'belowZoneToleranceEnabled', false)
  const maxBelowZonePct = optionalNumber(source, 'maxBelowZonePct')
    ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct
  const statusFilter = source.statusFilter ?? null
  if (statusFilter !== null && statusFilter !== 'APPROACHING' && statusFilter !== 'NEAR'
    && statusFilter !== 'IN_ZONE' && statusFilter !== 'BELOW_ZONE') {
    throw new TriggerDiscoveryInputError('statusFilter must be APPROACHING, NEAR, IN_ZONE or BELOW_ZONE')
  }
  const liquidityLookbackSessions = integer(source, 'liquidityLookbackSessions', 20)
  const maxPriceStalenessSessions = integer(source, 'maxPriceStalenessSessions', DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS)
  if (liquidityLookbackSessions < 1 || liquidityLookbackSessions > 252) {
    throw new TriggerDiscoveryInputError('liquidityLookbackSessions must be between 1 and 252')
  }
  if (maxPriceStalenessSessions < 0 || maxPriceStalenessSessions > 60) {
    throw new TriggerDiscoveryInputError('maxPriceStalenessSessions must be between 0 and 60')
  }
  validateMaZoneTriggerConfig({
    ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
    ma1Period,
    ma2Period,
    slopeLookbackSessions,
    approachLookbackSessions,
    minimumAboveZoneRatio,
    maxApproachDistancePct,
    nearDistancePct,
    spreadExpansionEnabled,
    spreadLookbackIntervals,
    minExpansionRatio,
    requireBullishMaOrder,
    belowZoneToleranceEnabled,
    maxBelowZonePct,
  })
  const page = integer(source, 'page', 1)
  const pageSize = integer(source, 'pageSize', 50)
  if (page < 1) throw new TriggerDiscoveryInputError('page must be one or greater')
  if (!PAGE_SIZES.has(pageSize)) throw new TriggerDiscoveryInputError('pageSize must be 25, 50 or 100')

  const sortSource = source.sort == null ? null : record(source.sort)
  const sort = sortSource == null ? null : {
    key: sortSource.key,
    direction: sortSource.direction,
  }
  if (sort && (!TRIGGER_DISCOVERY_SORT_KEYS.includes(sort.key as never)
    || (sort.direction !== 'asc' && sort.direction !== 'desc'))) {
    throw new TriggerDiscoveryInputError('sort contains an invalid key or direction')
  }
  const markets = parseMarkets(source.markets)
  const stageFilters = parseStageFilters(source.stageFilters)
  const request: TriggerDiscoverySearchRequest = {
    requestedAsOf,
    timeframe,
    ma1Period,
    ma2Period,
    slopeLookbackSessions,
    approachLookbackSessions,
    minimumAboveZoneRatio,
    maxApproachDistancePct,
    nearDistancePct,
    spreadExpansionEnabled,
    spreadLookbackIntervals,
    minExpansionRatio,
    requireBullishMaOrder,
    belowZoneToleranceEnabled,
    maxBelowZonePct,
    statusFilter: statusFilter as TriggerDiscoverySearchRequest['statusFilter'],
    markets,
    priceMin: optionalNumber(source, 'priceMin'),
    priceMax: optionalNumber(source, 'priceMax'),
    averageVolumeMin: optionalNumber(source, 'averageVolumeMin'),
    averageVolumeMax: optionalNumber(source, 'averageVolumeMax'),
    averageTradingValueMin: optionalNumber(source, 'averageTradingValueMin'),
    averageTradingValueMax: optionalNumber(source, 'averageTradingValueMax'),
    liquidityLookbackSessions,
    maxPriceStalenessSessions,
    sort: sort as TriggerDiscoverySearchRequest['sort'],
    page,
    pageSize,
    stageFilters,
  }
  return {
    request,
    timeframe,
    page,
    pageSize,
    input: {
      asOf: requestedAsOf,
      triggerConfig: {
        ma1Period,
        ma2Period,
        slopeLookbackSessions,
        approachLookbackSessions,
        minimumAboveZoneRatio,
        maxApproachDistancePct,
        nearDistancePct,
        spreadExpansionEnabled,
        spreadLookbackIntervals,
        minExpansionRatio,
        requireBullishMaOrder,
        belowZoneToleranceEnabled,
        maxBelowZonePct,
      },
      markets,
      priceMin: request.priceMin,
      priceMax: request.priceMax,
      averageVolumeMin: request.averageVolumeMin,
      averageVolumeMax: request.averageVolumeMax,
      averageTradingValueMin: request.averageTradingValueMin,
      averageTradingValueMax: request.averageTradingValueMax,
      liquidityLookbackSessions,
      maxPriceStalenessSessions,
      stageFilters,
      sortBy: request.sort?.key,
      sortDirection: request.sort?.direction,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  }
}
