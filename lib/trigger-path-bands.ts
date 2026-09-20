import { PATH_DIMENSIONS, PATH_SEGMENTATION_VERSION, type PathDimension } from '@/lib/trigger-path-research-contract'
import type { TriggerPathWindow } from '@/lib/trigger-path-contract'

export { PATH_SEGMENTATION_VERSION }

type Band = { id: string; label: string }
const DEPTH: readonly Band[] = [
  { id: 'NOT_BREACHED', label: '下抜けなし' },
  { id: 'D0_1', label: '0〜-1%' },
  { id: 'D1_2', label: '-1〜-2%' },
  { id: 'D2_3', label: '-2〜-3%' },
  { id: 'D3_5', label: '-3〜-5%' },
  { id: 'D5_8', label: '-5〜-8%' },
  { id: 'D8_PLUS', label: '-8%以下' },
  { id: 'UNKNOWN', label: '不明・未確定' },
]
const DURATION: readonly Band[] = [
  { id: 'ZERO', label: '0' }, { id: 'S1_2', label: '1〜2' },
  { id: 'S3_5', label: '3〜5' }, { id: 'S6_10', label: '6〜10' },
  { id: 'S11_PLUS', label: '11以上' }, { id: 'UNKNOWN', label: '不明・未確定' },
]
const RECLAIM: readonly Band[] = [
  { id: 'NOT_BREACHED', label: '下抜けなし' },
  { id: 'S0_1', label: '0〜1営業日' }, { id: 'S2_3', label: '2〜3営業日' },
  { id: 'S4_5', label: '4〜5営業日' }, { id: 'S6_10', label: '6〜10営業日' },
  { id: 'S11_20', label: '11〜20営業日' }, { id: 'S21_PLUS', label: '21営業日以上' },
  { id: 'NOT_RECLAIMED', label: '未回復' }, { id: 'UNKNOWN', label: '不明・未確定' },
]

export const PATH_BAND_REGISTRY: Readonly<Record<PathDimension, readonly Band[]>> = {
  pathDepthLow: DEPTH,
  pathDepthClose: DEPTH,
  timeToDeepest: [
    { id: 'NOT_BREACHED', label: '下抜けなし' },
    { id: 'S1_2', label: '1〜2営業日' }, { id: 'S3_5', label: '3〜5営業日' },
    { id: 'S6_10', label: '6〜10営業日' }, { id: 'S11_20', label: '11〜20営業日' },
    { id: 'S21_PLUS', label: '21営業日以上' }, { id: 'UNKNOWN', label: '不明・未確定' },
  ],
  belowZoneDuration: DURATION,
  longestBelowStreak: DURATION,
  reclaimSpeed: RECLAIM,
  reclaimStatus: [
    { id: 'NOT_BREACHED', label: '終値下抜けなし' },
    { id: 'BREACHED_NOT_RECLAIMED', label: '下抜け・未回復' },
    { id: 'LOWER_RECLAIMED', label: 'Zone内へ回復' },
    { id: 'UPPER_RECLAIMED', label: 'Zone上限を回復' },
    { id: 'UNKNOWN', label: '不明・未確定' },
  ],
  zoneWidthDepth: [
    { id: 'NOT_BREACHED', label: '下抜けなし' },
    { id: 'R_LT_025', label: '0.25倍未満' }, { id: 'R025_05', label: '0.25〜0.5倍' },
    { id: 'R05_1', label: '0.5〜1倍' }, { id: 'R1_2', label: '1〜2倍' },
    { id: 'R2_PLUS', label: '2倍以上' }, { id: 'UNKNOWN', label: '不明・未確定' },
  ],
  atrDepth: [
    { id: 'NOT_BREACHED', label: '下抜けなし' },
    { id: 'R_LT_05', label: '0.5 ATR未満' }, { id: 'R05_1', label: '0.5〜1 ATR' },
    { id: 'R1_15', label: '1〜1.5 ATR' }, { id: 'R15_2', label: '1.5〜2 ATR' },
    { id: 'R2_PLUS', label: '2 ATR以上' }, { id: 'UNKNOWN', label: '不明・未確定' },
  ],
}

export function pathBandOrder(dimension: PathDimension): string[] {
  return PATH_BAND_REGISTRY[dimension].map((band) => band.id)
}

export function pathBandLabel(dimension: PathDimension, id: string): string {
  return PATH_BAND_REGISTRY[dimension].find((band) => band.id === id)?.label ?? id
}

export function isPathDimension(value: string): value is PathDimension {
  return PATH_DIMENSIONS.includes(value as PathDimension)
}

export function pathBand(window: TriggerPathWindow | null, dimension: PathDimension): string {
  if (!window) return 'UNKNOWN'
  if (dimension === 'pathDepthLow' || dimension === 'pathDepthClose') {
    if (dimension === 'pathDepthLow' && !window.breachedZoneLower) return 'NOT_BREACHED'
    if (dimension === 'pathDepthClose' && !window.firstZoneLowerCloseBreachDate) return 'NOT_BREACHED'
    const value = dimension === 'pathDepthLow' ? window.maxZoneUndershootLowPct : window.maxZoneUndershootClosePct
    if (value == null || !Number.isFinite(value)) return 'UNKNOWN'
    if (value >= 0) return 'NOT_BREACHED'
    if (value > -1) return 'D0_1'
    if (value > -2) return 'D1_2'
    if (value > -3) return 'D2_3'
    if (value > -5) return 'D3_5'
    if (value > -8) return 'D5_8'
    return 'D8_PLUS'
  }
  if (dimension === 'reclaimStatus') return window.reclaimStatus ?? 'UNKNOWN'
  if (dimension === 'belowZoneDuration' || dimension === 'longestBelowStreak') {
    const value = dimension === 'belowZoneDuration'
      ? window.totalBelowZoneSessions : window.longestConsecutiveBelowZoneSessions
    if (!Number.isInteger(value) || value < 0) return 'UNKNOWN'
    if (value === 0) return 'ZERO'
    if (value <= 2) return 'S1_2'
    if (value <= 5) return 'S3_5'
    if (value <= 10) return 'S6_10'
    return 'S11_PLUS'
  }
  if (dimension === 'timeToDeepest') {
    if (!window.breachedZoneLower) return 'NOT_BREACHED'
    const value = window.tradingSessionsToDeepest
    if (value == null || value < 1) return 'UNKNOWN'
    if (value <= 2) return 'S1_2'
    if (value <= 5) return 'S3_5'
    if (value <= 10) return 'S6_10'
    if (value <= 20) return 'S11_20'
    return 'S21_PLUS'
  }
  if (dimension === 'reclaimSpeed') {
    if (!window.firstZoneLowerCloseBreachDate) return 'NOT_BREACHED'
    const value = window.sessionsFromHitToLowerReclaim
    if (value == null) return 'NOT_RECLAIMED'
    if (value <= 1) return 'S0_1'
    if (value <= 3) return 'S2_3'
    if (value <= 5) return 'S4_5'
    if (value <= 10) return 'S6_10'
    if (value <= 20) return 'S11_20'
    return 'S21_PLUS'
  }
  if (!window.breachedZoneLower) return 'NOT_BREACHED'
  const value = dimension === 'zoneWidthDepth'
    ? window.undershootToZoneWidthRatio : window.undershootAtrMultiple
  if (value == null || !Number.isFinite(value) || value < 0) return 'UNKNOWN'
  if (dimension === 'zoneWidthDepth') {
    if (value < 0.25) return 'R_LT_025'
    if (value < 0.5) return 'R025_05'
    if (value < 1) return 'R05_1'
    if (value < 2) return 'R1_2'
    return 'R2_PLUS'
  }
  if (value < 0.5) return 'R_LT_05'
  if (value < 1) return 'R05_1'
  if (value < 1.5) return 'R1_15'
  if (value < 2) return 'R15_2'
  return 'R2_PLUS'
}
