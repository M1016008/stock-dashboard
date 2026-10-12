import type {
  TriggerDiscoverySearchRequest,
  TriggerDiscoverySearchResponse,
} from '@/lib/trigger-discovery-contract'
import type { TriggerDiscoveryRejectionReason } from '@/lib/server/trigger-discovery-read-model'

export type UsTriggerUniverseBasis = 'CURRENT_ACTIVE' | 'TRADING_COVERAGE'

export interface UsTriggerDiscoveryOptionsResponse {
  contractVersion: 'us-trigger-discovery-options-v1'
  market: 'US'
  currency: 'USD'
  latestAsOf: string | null
  activeCount: number
  supportedTimeframes: Array<'MONTHLY' | 'BIWEEKLY'>
  exchanges: Array<{
    value: string
    label: string
    count: number
  }>
}

export type UsTriggerDiscoverySearchResponse = Omit<
  TriggerDiscoverySearchResponse,
  'contractVersion' | 'meta'
> & {
  contractVersion: 'us-trigger-discovery-search-v1'
  market: 'US'
  currency: 'USD'
  meta: TriggerDiscoverySearchResponse['meta'] & {
    latestAsOf: string | null
    isLatest: boolean
    universeBasis: UsTriggerUniverseBasis
    classificationAvailability: 'CURRENT' | 'UNAVAILABLE'
    insufficientHistoryCount: number
    rejected: Record<TriggerDiscoveryRejectionReason, number>
  }
}

export type UsTriggerDiscoveryRequest = TriggerDiscoverySearchRequest
