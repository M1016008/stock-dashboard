import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

export const TRIGGER_PATH_CONTRACT_VERSION = 'trigger-path-v1' as const
export const TRIGGER_PATH_HORIZONS = [20, 60, 120, 245] as const
export type TriggerPathHorizon = typeof TRIGGER_PATH_HORIZONS[number]
export type TriggerPathZonePosition = 'ABOVE_ZONE' | 'IN_ZONE' | 'BELOW_ZONE'
export type TriggerPathReclaimStatus =
  | 'NOT_BREACHED'
  | 'BREACHED_NOT_RECLAIMED'
  | 'LOWER_RECLAIMED'
  | 'UPPER_RECLAIMED'

export interface TriggerPathPoint {
  date: string
  high: number
  low: number
  close: number
  ma1: number | null
  ma2: number | null
  zoneUpper: number | null
  zoneLower: number | null
  zoneDistancePct: number | null
  dynamicUndershootLowPct: number | null
  dynamicUndershootClosePct: number | null
  fixedAnchorUndershootLowPct: number | null
  fixedAnchorUndershootClosePct: number | null
  atr20: number | null
  marketSession: number | null
}

export interface TriggerPathWindow {
  observedSessions: number
  maxUpsideToDate: number | null
  maxUpsideDate: string | null
  maxDownsideToDate: number | null
  maxDownsideDate: string | null
  breachedZoneLower: boolean
  firstZoneLowerBreachDate: string | null
  firstZoneLowerCloseBreachDate: string | null
  deepestDate: string | null
  deepestLow: number | null
  deepestClose: number | null
  zoneUpperAtDeepest: number | null
  zoneLowerAtDeepest: number | null
  dynamicUndershootLowPctAtDeepest: number | null
  dynamicUndershootClosePctAtDeepest: number | null
  fixedAnchorUndershootLowPctAtDeepest: number | null
  fixedAnchorUndershootClosePctAtDeepest: number | null
  maxZoneUndershootLowPct: number | null
  maxZoneUndershootClosePct: number | null
  fixedAnchorUndershootLowPct: number | null
  fixedAnchorUndershootClosePct: number | null
  tradingSessionsToDeepest: number | null
  totalBelowZoneSessions: number
  longestConsecutiveBelowZoneSessions: number
  intradayOnlyUndershootOccurred: boolean
  firstZoneLowerReclaimDate: string | null
  firstZoneUpperReclaimDate: string | null
  sessionsFromHitToLowerReclaim: number | null
  sessionsFromDeepestToLowerReclaim: number | null
  reclaimStatus: TriggerPathReclaimStatus
  returnDeepestToLatest: number | null
  maxReboundFromDeepest: number | null
  maxReboundDate: string | null
  returnFromLowerReclaimToLatest: number | null
  maxUpsideAfterLowerReclaim: number | null
  maxUpsideAfterLowerReclaimDate: string | null
  zoneWidthPctAtDeepest: number | null
  undershootToZoneWidthRatio: number | null
  atrAtDeepest: number | null
  undershootAtrMultiple: number | null
}

export interface TriggerPathHorizonResult {
  horizonSessions: TriggerPathHorizon
  availability: boolean
  endDate: string | null
  /** Hit終値から、確定した期間末終値までの騰落率。availability=falseならnull。 */
  returnFromHit: number | null
  path: TriggerPathWindow | null
}

export interface TriggerPathProfile extends TriggerPathWindow {
  eventKey: string
  ticker: string
  companyName: string
  eventDate: string
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  analysisCutoffDate: string
  anchorPrice: number
  anchorZoneUpper: number
  anchorZoneLower: number
  zoneWidthPctAtHit: number
  latestDate: string | null
  latestClose: number | null
  returnToDate: number | null
  elapsedTradingSessions: number
  atrAtHit: number | null
  currentZonePosition: TriggerPathZonePosition | null
  horizonPaths: TriggerPathHorizonResult[]
}

export interface TriggerPathResponse {
  contractVersion: typeof TRIGGER_PATH_CONTRACT_VERSION
  event: TriggerHistoricalScanEvent
  pathProfile: TriggerPathProfile
  series: TriggerPathPoint[]
  meta: {
    scanJobId: string
    analysisCutoffDate: string
    preEventSessions: number
    atrPeriod: 20
    atrNormalizationBasis: 'DEEPEST_DATE'
    maxReboundExcludesDeepestSession: true
    derivedOnDemand: true
    performance: {
      artifactLookupMs: number
      sqlMs: number
      sqlQueryCount: number
      ohlcvLoadMs: number
      maZoneBuildMs: number
      atrMs: number
      pathCalculationMs: number
      peakHeapBytes: number
      totalMs: number
    }
  }
}
