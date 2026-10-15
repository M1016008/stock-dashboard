// components/us/trigger-discovery/usTriggerDiscoveryShared.ts
//
// /us/trigger-discovery の入力・表示で共有する定数と純関数。
// - Status / Score / 距離はサーバー (決定的エンジン) の値をそのまま表示し、ここでは再計算しない
// - クライアントで行う変換は「平均売買代金 $M → USD」の単位換算だけ
// - 円表記は使わない (米国株は USD)

import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoveryStageAxis,
  type TriggerDiscoveryStageFilters,
} from '@/lib/trigger-discovery-contract'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG, type TriggerStatus } from '@/lib/trigger-discovery-engine'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { UsTriggerDiscoverySearchResponse } from '@/lib/us-trigger-discovery-contract'
import { fmtUsd } from '@/components/us/UsMarketMomentumParts'

/* ---------- 既定値 ---------- */

/** 画面に「編集できる既定値」として明示する初期条件 */
export const US_TRIGGER_DEFAULTS = {
  timeframe: 'MONTHLY',
  ma1Period: 20,
  ma2Period: 25,
  maxDistancePct: 5,
  nearDistancePct: 2,
  priceMinUsd: 5,
  tradingValueMinUsdM: 5,
  liquidityLookbackSessions: 20,
  pageSize: 50,
} as const

export const US_TRIGGER_PAGE_SIZES = [25, 50, 100] as const
export type UsTriggerPageSize = (typeof US_TRIGGER_PAGE_SIZES)[number]

export type UsTriggerStatusFilter = TriggerDiscoverySearchRequest['statusFilter']

export interface UsTriggerViewConfig {
  sort: TriggerDiscoverySearchRequest['sort']
  pageSize: UsTriggerPageSize
  statusFilter: UsTriggerStatusFilter
}

export interface UsTriggerDraft {
  asOf: string
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: string
  ma2Period: string
  maxDistance: string
  nearDistance: string
  spreadExpansionEnabled: boolean
  spreadLookbackIntervals: string
  minExpansionRatioPct: string
  belowZoneToleranceEnabled: boolean
  maxBelowZonePct: string
  priceMin: string
  priceMax: string
  /** 平均売買代金の下限・上限は $M 単位で入力し、送信時に USD へ換算する */
  tradingValueMinM: string
  tradingValueMaxM: string
  volumeMin: string
  volumeMax: string
  liquidityLookbackSessions: string
  exchanges: string[]
  stageFilters: TriggerDiscoveryStageFilters
}

/** 自由入力の文字列欄だけ (足種のような選択値は含めない) */
export type UsTriggerDraftStringKey = {
  [Key in keyof UsTriggerDraft]-?: string extends UsTriggerDraft[Key] ? Key : never
}[keyof UsTriggerDraft]

export function defaultUsTriggerDraft(latestAsOf: string | null): UsTriggerDraft {
  return {
    asOf: latestAsOf ?? '',
    timeframe: US_TRIGGER_DEFAULTS.timeframe,
    ma1Period: String(US_TRIGGER_DEFAULTS.ma1Period),
    ma2Period: String(US_TRIGGER_DEFAULTS.ma2Period),
    maxDistance: String(US_TRIGGER_DEFAULTS.maxDistancePct),
    nearDistance: String(US_TRIGGER_DEFAULTS.nearDistancePct),
    spreadExpansionEnabled: false,
    spreadLookbackIntervals: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals),
    minExpansionRatioPct: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio * 100),
    belowZoneToleranceEnabled: false,
    maxBelowZonePct: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct),
    priceMin: String(US_TRIGGER_DEFAULTS.priceMinUsd),
    priceMax: '',
    tradingValueMinM: String(US_TRIGGER_DEFAULTS.tradingValueMinUsdM),
    tradingValueMaxM: '',
    volumeMin: '',
    volumeMax: '',
    liquidityLookbackSessions: String(US_TRIGGER_DEFAULTS.liquidityLookbackSessions),
    exchanges: [],
    stageFilters: {},
  }
}

/** 既定値から変わっているか (基準日は除く)。「既定値に戻す」の有効化だけに使う */
export function isDefaultUsTriggerDraft(draft: UsTriggerDraft): boolean {
  const base = defaultUsTriggerDraft(draft.asOf)
  return JSON.stringify(base) === JSON.stringify(draft)
}

/* ---------- 日付 ---------- */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** 最新データ日より前の基準日。取引所の条件は使えず、母集団は価格履歴のカバレッジになる */
export function isPastUsTriggerDate(asOf: string, latestAsOf: string | null): boolean {
  return latestAsOf != null && isValidDate(asOf) && asOf < latestAsOf
}

/* ---------- リクエスト ---------- */

function parseOptionalNumber(value: string): number | null {
  const normalized = value.replaceAll(',', '').replace(/^\$/, '').trim()
  return normalized === '' ? null : Number(normalized)
}

/** $M (百万ドル) → USD。浮動小数の端数を出さないよう整数ドルに丸める */
export function usdFromMillions(value: number | null): number | null {
  return value == null ? null : Math.round(value * 1_000_000)
}

export function buildUsTriggerRequest(
  draft: UsTriggerDraft,
  view: UsTriggerViewConfig,
  latestAsOf: string | null,
): TriggerDiscoverySearchRequest {
  const ma1Period = Number(draft.ma1Period)
  const ma2Period = Number(draft.ma2Period)
  const maxApproachDistancePct = Number(draft.maxDistance)
  const nearDistancePct = Number(draft.nearDistance)
  const spreadLookbackIntervals = Number(draft.spreadLookbackIntervals)
  const minExpansionRatio = Number(draft.minExpansionRatioPct) / 100
  const maxBelowZonePct = Number(draft.maxBelowZonePct)
  const liquidityLookbackSessions = Number(draft.liquidityLookbackSessions)
  const unit = draft.timeframe === 'BIWEEKLY' ? '本' : 'か月'

  if (!isValidDate(draft.asOf)) throw new Error('基準日を YYYY-MM-DD 形式で指定してください。')
  if (![ma1Period, ma2Period].every((value) => Number.isInteger(value) && value >= 2 && value <= 120)) {
    throw new Error(`MA期間は2〜120${unit}の整数で指定してください。`)
  }
  if (ma1Period === ma2Period) throw new Error('MA 1 と MA 2 は異なる期間にしてください。')
  if (!Number.isFinite(maxApproachDistancePct) || maxApproachDistancePct < 0 || maxApproachDistancePct > 100) {
    throw new Error('Trigger距離は0〜100%で指定してください。')
  }
  if (!Number.isFinite(nearDistancePct) || nearDistancePct < 0 || nearDistancePct > maxApproachDistancePct) {
    throw new Error('Near距離は0以上、Trigger距離以下で指定してください。')
  }
  if (draft.spreadExpansionEnabled) {
    if (!Number.isInteger(spreadLookbackIntervals) || spreadLookbackIntervals < 2 || spreadLookbackIntervals > 24) {
      throw new Error('MA間隔の比較区間数は2〜24で指定してください。')
    }
    if (!Number.isFinite(minExpansionRatio) || minExpansionRatio < 0 || minExpansionRatio > 1) {
      throw new Error('最低拡大区間比率は0〜100%で指定してください。')
    }
  }
  if (draft.belowZoneToleranceEnabled && (!Number.isFinite(maxBelowZonePct) || maxBelowZonePct <= 0 || maxBelowZonePct > 20)) {
    throw new Error('最大下抜け幅は0より大きく20%以下で指定してください。')
  }
  if (!Number.isInteger(liquidityLookbackSessions) || liquidityLookbackSessions < 1 || liquidityLookbackSessions > 252) {
    throw new Error('平均期間は1〜252営業日の整数で指定してください。')
  }

  const ranges = [
    ['株価', parseOptionalNumber(draft.priceMin), parseOptionalNumber(draft.priceMax)],
    ['平均売買代金', parseOptionalNumber(draft.tradingValueMinM), parseOptionalNumber(draft.tradingValueMaxM)],
    ['平均出来高', parseOptionalNumber(draft.volumeMin), parseOptionalNumber(draft.volumeMax)],
  ] as const
  for (const [label, min, max] of ranges) {
    if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0))) {
      throw new Error(`${label}は0以上の数値で指定してください。`)
    }
    if (min != null && max != null && min > max) throw new Error(`${label}の下限が上限を超えています。`)
  }

  const past = isPastUsTriggerDate(draft.asOf, latestAsOf)
  const hasStageFilters = TRIGGER_DISCOVERY_STAGE_AXES.some((axis) => draft.stageFilters[axis]?.length)
  return {
    requestedAsOf: draft.asOf,
    timeframe: draft.timeframe,
    ma1Period,
    ma2Period,
    maxApproachDistancePct,
    nearDistancePct,
    spreadExpansionEnabled: draft.spreadExpansionEnabled,
    ...(draft.spreadExpansionEnabled ? { spreadLookbackIntervals, minExpansionRatio } : {}),
    belowZoneToleranceEnabled: draft.belowZoneToleranceEnabled,
    ...(draft.belowZoneToleranceEnabled ? { maxBelowZonePct } : {}),
    // 過去日は当時の取引所情報がないため送らない (サーバーも 422 で拒否する)
    markets: !past && draft.exchanges.length > 0
      ? draft.exchanges.map((exchange) => exchange === 'UNCLASSIFIED' ? null : exchange)
      : undefined,
    priceMin: ranges[0][1],
    priceMax: ranges[0][2],
    averageTradingValueMin: usdFromMillions(ranges[1][1]),
    averageTradingValueMax: usdFromMillions(ranges[1][2]),
    averageVolumeMin: ranges[2][1],
    averageVolumeMax: ranges[2][2],
    liquidityLookbackSessions,
    stageFilters: hasStageFilters ? draft.stageFilters : undefined,
    sort: view.sort,
    page: 1,
    pageSize: view.pageSize,
    statusFilter: view.statusFilter ?? null,
  }
}

function inputNumber(value: number | null | undefined, divisor = 1): string {
  return value == null ? '' : String(value / divisor)
}

/** 保存済み定義の決定的requestを、USフォームの表示単位へ戻す。数値の意味は再計算しない。 */
export function usTriggerStateFromRequest(
  request: TriggerDiscoverySearchRequest,
  latestAsOf: string | null,
): { draft: UsTriggerDraft; view: UsTriggerViewConfig } {
  const base = defaultUsTriggerDraft(latestAsOf)
  return {
    draft: {
      ...base,
      asOf: request.requestedAsOf,
      timeframe: request.timeframe ?? base.timeframe,
      ma1Period: inputNumber(request.ma1Period ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.ma1Period),
      ma2Period: inputNumber(request.ma2Period ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.ma2Period),
      maxDistance: inputNumber(request.maxApproachDistancePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxApproachDistancePct),
      nearDistance: inputNumber(request.nearDistancePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.nearDistancePct),
      spreadExpansionEnabled: request.spreadExpansionEnabled ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadExpansionEnabled,
      spreadLookbackIntervals: inputNumber(request.spreadLookbackIntervals ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals),
      minExpansionRatioPct: inputNumber((request.minExpansionRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio) * 100),
      belowZoneToleranceEnabled: request.belowZoneToleranceEnabled ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.belowZoneToleranceEnabled,
      maxBelowZonePct: inputNumber(request.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct),
      priceMin: inputNumber(request.priceMin),
      priceMax: inputNumber(request.priceMax),
      tradingValueMinM: inputNumber(request.averageTradingValueMin, 1_000_000),
      tradingValueMaxM: inputNumber(request.averageTradingValueMax, 1_000_000),
      volumeMin: inputNumber(request.averageVolumeMin),
      volumeMax: inputNumber(request.averageVolumeMax),
      liquidityLookbackSessions: inputNumber(request.liquidityLookbackSessions ?? US_TRIGGER_DEFAULTS.liquidityLookbackSessions),
      exchanges: (request.markets ?? []).map((market) => market ?? 'UNCLASSIFIED'),
      stageFilters: request.stageFilters ?? {},
    },
    view: {
      sort: request.sort ?? null,
      pageSize: US_TRIGGER_PAGE_SIZES.includes(request.pageSize as UsTriggerPageSize)
        ? request.pageSize as UsTriggerPageSize
        : US_TRIGGER_DEFAULTS.pageSize,
      statusFilter: request.statusFilter ?? null,
    },
  }
}

/* ---------- 書式 ---------- */

/** 金額の短縮表記 ($850K / $12.3M / $1.25B)。売買代金・条件サマリーで使う */
export function fmtUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const trim = (text: string) => text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  if (abs >= 1_000_000_000) return `$${trim((value / 1_000_000_000).toFixed(2))}B`
  if (abs >= 1_000_000) return `$${trim((value / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `$${Math.round(value / 1_000).toLocaleString('en-US')}K`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function timeframeLabel(timeframe: TriggerDiscoveryTimeframe): string {
  return timeframe === 'BIWEEKLY' ? '2週足' : '月足'
}

/** 列見出し・チャート説明用の MA 期間表記 (20M / 20本) */
export function maPeriodCode(period: number, timeframe: TriggerDiscoveryTimeframe): string {
  return `${period}${timeframe === 'BIWEEKLY' ? '本' : 'M'}`
}

function rangeLabel(label: string, min: number | null | undefined, max: number | null | undefined, format: (value: number) => string): string | null {
  if (min == null && max == null) return null
  if (min != null && max != null) return `${label} ${format(min)}〜${format(max)}`
  return min != null ? `${label} ${format(min)}以上` : `${label} ${format(max!)}以下`
}

/** 適用済み条件を短い語の列にする (折りたたみ後のサマリー用) */
export function usTriggerCriteriaParts(
  request: TriggerDiscoverySearchRequest,
  exchangeLabel: (value: string | null) => string,
): string[] {
  const parts: string[] = [
    `Trigger距離 ${request.maxApproachDistancePct}%以内`,
    `Near ${request.nearDistancePct}%以内`,
    '2本とも上向き',
    '上から接近',
  ]
  const price = rangeLabel('株価', request.priceMin, request.priceMax, (value) => fmtUsd(value))
  if (price) parts.push(price)
  const tradingValue = rangeLabel('平均売買代金', request.averageTradingValueMin, request.averageTradingValueMax, fmtUsdCompact)
  if (tradingValue) parts.push(tradingValue)
  const volume = rangeLabel('平均出来高', request.averageVolumeMin, request.averageVolumeMax, (value) => `${value.toLocaleString('en-US')}株`)
  if (volume) parts.push(volume)
  if (request.liquidityLookbackSessions != null && request.liquidityLookbackSessions !== US_TRIGGER_DEFAULTS.liquidityLookbackSessions) {
    parts.push(`平均期間 ${request.liquidityLookbackSessions}営業日`)
  }
  if (request.markets?.length) parts.push(request.markets.map(exchangeLabel).join(' / '))
  const stageAxes = TRIGGER_DISCOVERY_STAGE_AXES.filter((axis) => request.stageFilters?.[axis]?.length).length
  if (stageAxes > 0) parts.push(`Stage ${stageAxes}軸`)
  if (request.spreadExpansionEnabled) {
    parts.push(`MA間隔拡大 ${request.spreadLookbackIntervals ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals}区間・${Math.round((request.minExpansionRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio) * 100)}%`)
  }
  if (request.belowZoneToleranceEnabled) parts.push(`Zone下抜け ${request.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct}%まで`)
  return parts
}

/* ---------- ラベル ---------- */

export const STAGE_AXIS_LABELS: Record<TriggerDiscoveryStageAxis, string> = {
  dayAStage: '日A',
  dayBStage: '日B',
  weekAStage: '週A',
  weekBStage: '週B',
  monthAStage: '月A',
  monthBStage: '月B',
}

export const STATUS_LABELS: Record<TriggerStatus, string> = {
  IN_ZONE: 'ゾーン内',
  NEAR: '近接',
  APPROACHING: '接近中',
  BELOW_ZONE: '下抜け',
  NOT_MATCHED: '対象外',
}

export const STATUS_STYLES: Record<TriggerStatus, string> = {
  IN_ZONE: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  NEAR: 'border-amber-200 bg-amber-50 text-amber-800',
  APPROACHING: 'border-sky-200 bg-sky-50 text-sky-800',
  BELOW_ZONE: 'border-slate-200 bg-slate-50 text-slate-600',
  NOT_MATCHED: 'border-slate-200 bg-slate-50 text-slate-600',
}

export type UsTriggerRejectionReason = keyof UsTriggerDiscoverySearchResponse['meta']['rejected']

/** 評価内訳の除外理由。件数はサーバーの診断値をそのまま表示する */
export const REJECTION_LABELS: Record<UsTriggerRejectionReason, string> = {
  PIT_UNIVERSE: '基準日の母集団外',
  MARKET_FILTER: '取引所の条件',
  STALE_PRICE: '価格が古い',
  PRICE_FILTER: '株価の条件',
  VOLUME_FILTER: '出来高の条件',
  TRADING_VALUE_FILTER: '売買代金の条件',
  INSUFFICIENT_HISTORY: '履歴不足',
  MA_NOT_BOTH_RISING: 'MAが2本とも上向きでない',
  MA_SPREAD_NOT_EXPANDING: 'MA間隔が拡大していない',
  NOT_FROM_ABOVE: '上からの接近でない',
  NOT_APPROACHING: 'Zoneへ接近していない',
  TOO_FAR: 'Trigger距離の外',
}

export const REJECTION_ORDER: readonly UsTriggerRejectionReason[] = [
  'PIT_UNIVERSE',
  'MARKET_FILTER',
  'STALE_PRICE',
  'PRICE_FILTER',
  'VOLUME_FILTER',
  'TRADING_VALUE_FILTER',
  'INSUFFICIENT_HISTORY',
  'MA_NOT_BOTH_RISING',
  'MA_SPREAD_NOT_EXPANDING',
  'NOT_FROM_ABOVE',
  'NOT_APPROACHING',
  'TOO_FAR',
]

/* ---------- Mini chart cache ---------- */

export function usMiniChartKey(input: {
  ticker: string
  timeframe: TriggerDiscoveryTimeframe
  date: string
  ma1Period: number
  ma2Period: number
}): string {
  return [input.ticker.toUpperCase(), input.timeframe, input.date, input.ma1Period, input.ma2Period].join('|')
}
