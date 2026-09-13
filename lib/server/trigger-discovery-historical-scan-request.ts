import type { TriggerHistoricalScanRequest } from '@/lib/trigger-discovery-historical-scan-contract'
import {
  parseTriggerDiscoverySearchRequest,
} from '@/lib/server/trigger-discovery-search-request'
import {
  TriggerDiscoveryInputError,
  type TriggerDiscoveryInput,
} from '@/lib/server/trigger-discovery-read-model'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const DEFAULT_HISTORICAL_SCAN_EVENT_LIMIT = 500
export const MAX_HISTORICAL_SCAN_EVENT_LIMIT = 5_000

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerDiscoveryInputError('request body must be an object')
  }
  return value as Record<string, unknown>
}

function isoDate(source: Record<string, unknown>, key: 'startDate' | 'endDate'): string {
  const value = source[key]
  const parsed = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : null
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)
    || !parsed || Number.isNaN(parsed.valueOf())
    || parsed.toISOString().slice(0, 10) !== value) {
    throw new TriggerDiscoveryInputError(`${key} must use YYYY-MM-DD format`)
  }
  return value
}

function boundedInteger(
  source: Record<string, unknown>,
  key: 'eventOffset' | 'eventLimit',
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TriggerDiscoveryInputError(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parseTriggerHistoricalScanRequest(value: unknown): {
  request: TriggerHistoricalScanRequest
  input: Omit<TriggerDiscoveryInput, 'asOf' | 'limit' | 'offset' | 'sortBy' | 'sortDirection'>
  timeframe: TriggerDiscoveryTimeframe
  eventOffset: number
  eventLimit: number
} {
  const source = record(value)
  const startDate = isoDate(source, 'startDate')
  const endDate = isoDate(source, 'endDate')
  if (startDate > endDate) {
    throw new TriggerDiscoveryInputError('startDate must not be after endDate')
  }

  // Reuse the public single-day parser so every Trigger, liquidity, market and
  // Stage filter keeps the same validation and defaults.
  const parsed = parseTriggerDiscoverySearchRequest({
    ...source,
    requestedAsOf: endDate,
    page: 1,
    pageSize: 50,
    sort: null,
  })
  const eventOffset = boundedInteger(source, 'eventOffset', 0, 0, Number.MAX_SAFE_INTEGER)
  const eventLimit = boundedInteger(
    source,
    'eventLimit',
    DEFAULT_HISTORICAL_SCAN_EVENT_LIMIT,
    1,
    MAX_HISTORICAL_SCAN_EVENT_LIMIT,
  )
  const { asOf: _asOf, limit: _limit, offset: _offset, sortBy: _sortBy,
    sortDirection: _sortDirection, ...input } = parsed.input
  const {
    requestedAsOf: _requestedAsOf,
    sort: _sort,
    page: _page,
    pageSize: _pageSize,
    ...sharedRequest
  } = parsed.request
  const request: TriggerHistoricalScanRequest = {
    ...sharedRequest,
    startDate,
    endDate,
    eventOffset,
    eventLimit,
  }

  return { request, input, timeframe: parsed.timeframe, eventOffset, eventLimit }
}
