import {
  TRIGGER_DISCOVERY_SORT_KEYS,
  type TriggerDiscoverySortDirection,
  type TriggerDiscoverySortKey,
} from '@/lib/trigger-discovery-contract'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import type { SavedTriggerViewConfig } from '@/lib/trigger-definition'
import type { TriggerLifecycleEventType } from '@/lib/trigger-lifecycle'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

export const TRIGGER_NOTIFICATION_CONTRACT_VERSION = 'trigger-notification-v1' as const
export const TRIGGER_NOTIFICATION_POLICY_VERSION = 1
export const DEFAULT_MAX_CANDIDATES_IN_DIGEST = 10
export const MAX_CANDIDATES_IN_DIGEST = 100

export type TriggerNotificationType = 'DAILY_DIGEST' | 'LIFECYCLE_ALERT'
export type TriggerNotificationOutboxStatus =
  | 'PENDING'
  | 'CANCELLED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'DELIVERY_UNKNOWN'

export interface TriggerNotificationSettingsValues {
  dailyDigestEnabled: boolean
  lifecycleAlertEnabled: boolean
  maxCandidatesInDigest: number
  includeNew: boolean
  includeReEntry: boolean
  includeStatusChangedToNear: boolean
  includeStatusChangedToInZone: boolean
  includeRebounded: boolean
  includeBrokeBelowZone: boolean
  includeCoreConditionExit: boolean
  includeStageFilterExit: boolean
  includeUniverseFilterExit: boolean
  includeDataUnavailable: boolean
  includeOtherExited: boolean
}

export interface TriggerNotificationSettings extends TriggerNotificationSettingsValues {
  definitionId: string
  createdAt: string | null
  updatedAt: string | null
}

export interface TriggerNotificationSettingsResponse {
  contractVersion: typeof TRIGGER_NOTIFICATION_CONTRACT_VERSION
  settings: TriggerNotificationSettings
}

export const DEFAULT_TRIGGER_NOTIFICATION_SETTINGS: Readonly<TriggerNotificationSettingsValues> = Object.freeze({
  dailyDigestEnabled: false,
  lifecycleAlertEnabled: false,
  maxCandidatesInDigest: DEFAULT_MAX_CANDIDATES_IN_DIGEST,
  includeNew: true,
  includeReEntry: true,
  includeStatusChangedToNear: true,
  includeStatusChangedToInZone: true,
  includeRebounded: true,
  includeBrokeBelowZone: true,
  includeCoreConditionExit: false,
  includeStageFilterExit: false,
  includeUniverseFilterExit: false,
  includeDataUnavailable: false,
  includeOtherExited: false,
})

export const TRIGGER_NOTIFICATION_BOOLEAN_SETTING_KEYS = [
  'dailyDigestEnabled',
  'lifecycleAlertEnabled',
  'includeNew',
  'includeReEntry',
  'includeStatusChangedToNear',
  'includeStatusChangedToInZone',
  'includeRebounded',
  'includeBrokeBelowZone',
  'includeCoreConditionExit',
  'includeStageFilterExit',
  'includeUniverseFilterExit',
  'includeDataUnavailable',
  'includeOtherExited',
] as const satisfies ReadonlyArray<keyof TriggerNotificationSettingsValues>

export class TriggerNotificationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerNotificationValidationError'
  }
}

export function mergeTriggerNotificationSettings(
  value: unknown,
  base: TriggerNotificationSettingsValues = { ...DEFAULT_TRIGGER_NOTIFICATION_SETTINGS },
): TriggerNotificationSettingsValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerNotificationValidationError('notification settings must be an object')
  }
  const source = value as Record<string, unknown>
  const allowed = new Set<string>([...TRIGGER_NOTIFICATION_BOOLEAN_SETTING_KEYS, 'maxCandidatesInDigest'])
  const unknown = Object.keys(source).find((key) => !allowed.has(key))
  if (unknown) throw new TriggerNotificationValidationError(`unknown notification setting: ${unknown}`)
  const merged = { ...base }
  for (const key of TRIGGER_NOTIFICATION_BOOLEAN_SETTING_KEYS) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'boolean') {
      throw new TriggerNotificationValidationError(`${key} must be a boolean`)
    }
    merged[key] = source[key]
  }
  if (source.maxCandidatesInDigest !== undefined) {
    const count = source.maxCandidatesInDigest
    if (typeof count !== 'number' || !Number.isInteger(count)
      || count < 1 || count > MAX_CANDIDATES_IN_DIGEST) {
      throw new TriggerNotificationValidationError(
        `maxCandidatesInDigest must be an integer between 1 and ${MAX_CANDIDATES_IN_DIGEST}`,
      )
    }
    merged.maxCandidatesInDigest = count
  }
  return merged
}

export interface TriggerNotificationCandidate {
  ticker: string
  companyName: string
  triggerStatus: TriggerStatus
  triggerScore: number
  price: number
  zoneDistancePct: number
  ma1DistancePct: number
  ma2DistancePct: number
  averageVolume: number | null
  averageTradingValue: number | null
  approachVelocity: number
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
  stockPath: string
}

export interface TriggerDailyDigestDefinition {
  definitionId: string
  definitionName: string
  evaluationId: string
  evaluationVersion: number
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  triggerPath: string
  finalCandidateCount: number
  displayedCandidateCount: number
  maxCandidatesInDigest: number
  sort: SavedTriggerViewConfig['sort']
  candidates: TriggerNotificationCandidate[]
}

export interface TriggerDailyDigestPayload {
  contractVersion: typeof TRIGGER_NOTIFICATION_CONTRACT_VERSION
  notificationPolicyVersion: typeof TRIGGER_NOTIFICATION_POLICY_VERSION
  notificationType: 'DAILY_DIGEST'
  batchId: string
  resolvedAsOf: string
  enabledDefinitionCount: number
  finalCandidateCount: number
  newCount: number
  lifecycleCounts: Partial<Record<TriggerLifecycleEventType, number>>
  lifecycleHighlights: {
    new: number
    reEntry: number
    statusChangedToNear: number
    statusChangedToInZone: number
    rebounded: number
    brokeBelowZone: number
  }
  definitions: TriggerDailyDigestDefinition[]
  failedDefinitions: Array<{
    definitionId: string
    definitionName: string
    errorCategory: string | null
  }>
}

export const TRIGGER_LIFECYCLE_ALERT_SECTION_KEYS = [
  'BROKE_BELOW_ZONE',
  'REBOUNDED',
  'STATUS_CHANGED_TO_IN_ZONE',
  'STATUS_CHANGED_TO_NEAR',
  'NEW',
  'RE_ENTRY',
  'CORE_CONDITION_EXIT',
  'STAGE_FILTER_EXIT',
  'UNIVERSE_FILTER_EXIT',
  'DATA_UNAVAILABLE',
  'OTHER_EXITED',
] as const

export type TriggerLifecycleAlertSectionKey = (typeof TRIGGER_LIFECYCLE_ALERT_SECTION_KEYS)[number]

export interface TriggerLifecycleAlertEvent {
  eventId: string
  definitionId: string
  definitionName: string
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  triggerPath: string
  ticker: string
  companyName: string
  stockPath: string
  eventType: TriggerLifecycleEventType
  previousTriggerStatus: TriggerStatus | null
  currentTriggerStatus: TriggerStatus | null
  previousScore: number | null
  currentScore: number | null
  previousPrice: number | null
  currentPrice: number | null
  zoneDistancePct: number | null
  stages: {
    dayA: number | null
    dayB: number | null
    weekA: number | null
    weekB: number | null
    monthA: number | null
    monthB: number | null
  }
  exitReason: string | null
}

export interface TriggerLifecycleAlertSection {
  key: TriggerLifecycleAlertSectionKey
  label: string
  events: TriggerLifecycleAlertEvent[]
}

export interface TriggerLifecycleAlertPayload {
  contractVersion: typeof TRIGGER_NOTIFICATION_CONTRACT_VERSION
  notificationPolicyVersion: typeof TRIGGER_NOTIFICATION_POLICY_VERSION
  notificationType: 'LIFECYCLE_ALERT'
  batchId: string
  resolvedAsOf: string
  enabledDefinitionCount: number
  eventCount: number
  lifecycleCounts: Partial<Record<TriggerLifecycleAlertSectionKey, number>>
  sections: TriggerLifecycleAlertSection[]
}

export type TriggerNotificationPayload = TriggerDailyDigestPayload | TriggerLifecycleAlertPayload

export interface BuiltTriggerNotification {
  notificationType: TriggerNotificationType
  subject: string
  textBody: string
  htmlBody: string
  payload: TriggerNotificationPayload
}

function sortableValue(candidate: TriggerNotificationCandidate, key: TriggerDiscoverySortKey): number | string | null {
  switch (key) {
    case 'ticker': return candidate.ticker
    case 'triggerStatus': return candidate.triggerStatus === 'IN_ZONE' ? 0 : candidate.triggerStatus === 'NEAR' ? 1 : 2
    case 'price': return candidate.price
    case 'zoneDistance': return Math.abs(candidate.zoneDistancePct)
    case 'ma1Distance': return Math.abs(candidate.ma1DistancePct)
    case 'ma2Distance': return Math.abs(candidate.ma2DistancePct)
    case 'averageVolume': return candidate.averageVolume
    case 'averageTradingValue': return candidate.averageTradingValue
    case 'approachVelocity': return candidate.approachVelocity
    case 'triggerScore': return candidate.triggerScore
    case 'dayAStage': return candidate.dayAStage
    case 'dayBStage': return candidate.dayBStage
    case 'weekAStage': return candidate.weekAStage
    case 'weekBStage': return candidate.weekBStage
    case 'monthAStage': return candidate.monthAStage
    case 'monthBStage': return candidate.monthBStage
  }
}

export function sortTriggerNotificationCandidates(
  candidates: TriggerNotificationCandidate[],
  sort: SavedTriggerViewConfig['sort'] | null | undefined,
): TriggerNotificationCandidate[] {
  const key = sort && TRIGGER_DISCOVERY_SORT_KEYS.includes(sort.key) ? sort.key : 'triggerScore'
  const direction: TriggerDiscoverySortDirection = sort?.direction === 'asc' || sort?.direction === 'desc'
    ? sort.direction
    : 'desc'
  return candidates.slice().sort((left, right) => {
    const leftValue = sortableValue(left, key)
    const rightValue = sortableValue(right, key)
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue == null) return left.ticker.localeCompare(right.ticker)
      return leftValue == null ? 1 : -1
    }
    const compared = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue)
    return compared === 0 ? left.ticker.localeCompare(right.ticker) : compared * (direction === 'desc' ? -1 : 1)
  })
}

export function lifecycleAlertSectionKey(input: {
  eventType: TriggerLifecycleEventType
  currentTriggerStatus: TriggerStatus | null
}): TriggerLifecycleAlertSectionKey | null {
  if (input.eventType === 'STATUS_CHANGED') {
    if (input.currentTriggerStatus === 'IN_ZONE') return 'STATUS_CHANGED_TO_IN_ZONE'
    if (input.currentTriggerStatus === 'NEAR') return 'STATUS_CHANGED_TO_NEAR'
    return null
  }
  if (input.eventType === 'EXITED') return 'OTHER_EXITED'
  return input.eventType
}

export function notificationSettingIncludesLifecycleSection(
  settings: TriggerNotificationSettingsValues,
  key: TriggerLifecycleAlertSectionKey,
): boolean {
  const settingByKey: Record<TriggerLifecycleAlertSectionKey, keyof TriggerNotificationSettingsValues> = {
    BROKE_BELOW_ZONE: 'includeBrokeBelowZone',
    REBOUNDED: 'includeRebounded',
    STATUS_CHANGED_TO_IN_ZONE: 'includeStatusChangedToInZone',
    STATUS_CHANGED_TO_NEAR: 'includeStatusChangedToNear',
    NEW: 'includeNew',
    RE_ENTRY: 'includeReEntry',
    CORE_CONDITION_EXIT: 'includeCoreConditionExit',
    STAGE_FILTER_EXIT: 'includeStageFilterExit',
    UNIVERSE_FILTER_EXIT: 'includeUniverseFilterExit',
    DATA_UNAVAILABLE: 'includeDataUnavailable',
    OTHER_EXITED: 'includeOtherExited',
  }
  return Boolean(settings[settingByKey[key]])
}

const SECTION_LABELS: Record<TriggerLifecycleAlertSectionKey, string> = {
  BROKE_BELOW_ZONE: 'Zone下抜け',
  REBOUNDED: 'Zone上側へ反発',
  STATUS_CHANGED_TO_IN_ZONE: 'Trigger Zone入り',
  STATUS_CHANGED_TO_NEAR: 'NEARへ接近',
  NEW: '新規候補',
  RE_ENTRY: '再エントリー',
  CORE_CONDITION_EXIT: '中核条件から離脱',
  STAGE_FILTER_EXIT: 'Stage条件から離脱',
  UNIVERSE_FILTER_EXIT: '対象ユニバースから離脱',
  DATA_UNAVAILABLE: 'データ未取得',
  OTHER_EXITED: 'その他の離脱',
}

export function triggerLifecycleAlertSectionLabel(key: TriggerLifecycleAlertSectionKey): string {
  return SECTION_LABELS[key]
}

export function formatTriggerStages(input: {
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
}): string {
  const stage = (value: number | null) => value == null ? '—' : String(value)
  return `日 ${stage(input.dayAStage)}/${stage(input.dayBStage)}｜週 ${stage(input.weekAStage)}/${stage(input.weekBStage)}｜月 ${stage(input.monthAStage)}/${stage(input.monthBStage)}`
}

export function triggerNotificationTimeframeLabel(timeframe: TriggerDiscoveryTimeframe): string {
  return timeframe === 'BIWEEKLY' ? '2週足' : '月足'
}

export function formatTriggerNotificationMaPeriods(
  timeframe: TriggerDiscoveryTimeframe,
  ma1Period: number,
  ma2Period: number,
): string {
  const unit = timeframe === 'BIWEEKLY' ? '本' : 'か月'
  return `${ma1Period}${unit} / ${ma2Period}${unit}`
}

function formatNumber(value: number | null, digits = 1): string {
  return value == null ? '—' : value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function formatPct(value: number | null): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${formatNumber(value, 2)}%`
}

function formatTradingValue(value: number | null): string {
  if (value == null) return '—'
  if (Math.abs(value) >= 100_000_000) return `${formatNumber(value / 100_000_000, 1)}億円`
  if (Math.abs(value) >= 10_000) return `${formatNumber(value / 10_000, 1)}万円`
  return `${formatNumber(value, 0)}円`
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function candidateText(candidate: TriggerNotificationCandidate): string {
  return `${candidate.ticker} ${candidate.companyName} | ${candidate.triggerStatus} | Score ${formatNumber(candidate.triggerScore, 1)} | 株価 ${formatNumber(candidate.price, 2)} | MA1 ${formatPct(candidate.ma1DistancePct)} | MA2 ${formatPct(candidate.ma2DistancePct)} | Zone ${formatPct(candidate.zoneDistancePct)} | ${formatTriggerStages(candidate)} | 売買代金 ${formatTradingValue(candidate.averageTradingValue)} | ${candidate.stockPath}`
}

function candidateHtml(candidate: TriggerNotificationCandidate): string {
  return `<tr><td><a href="${escapeHtml(candidate.stockPath)}">${escapeHtml(candidate.ticker)}</a><br><span style="color:#555">${escapeHtml(candidate.companyName)}</span></td><td>${escapeHtml(candidate.triggerStatus)}</td><td>${escapeHtml(formatNumber(candidate.triggerScore, 1))}</td><td>${escapeHtml(formatNumber(candidate.price, 2))}</td><td>${escapeHtml(formatPct(candidate.ma1DistancePct))}</td><td>${escapeHtml(formatPct(candidate.ma2DistancePct))}</td><td>${escapeHtml(formatPct(candidate.zoneDistancePct))}</td><td>${escapeHtml(formatTriggerStages(candidate))}</td><td>${escapeHtml(formatTradingValue(candidate.averageTradingValue))}</td></tr>`
}

const TABLE_STYLE = 'border-collapse:collapse;width:100%;font-size:13px'
const TH_STYLE = 'text-align:left;border-bottom:1px solid #bbb;padding:6px 4px;color:#444'

export function buildDailyDigestNotification(payload: TriggerDailyDigestPayload): BuiltTriggerNotification {
  const subject = `Trigger Discovery｜${payload.resolvedAsOf}｜候補${payload.finalCandidateCount}件`
  const changes = [
    ['NEW', payload.lifecycleHighlights.new],
    ['RE ENTRY', payload.lifecycleHighlights.reEntry],
    ['NEAR入り', payload.lifecycleHighlights.statusChangedToNear],
    ['IN ZONE入り', payload.lifecycleHighlights.statusChangedToInZone],
    ['REBOUND', payload.lifecycleHighlights.rebounded],
    ['BROKE BELOW', payload.lifecycleHighlights.brokeBelowZone],
  ].filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join(' / ') || '主要変化なし'
  const textSections = payload.definitions.map((definition) => [
    `## ${triggerNotificationTimeframeLabel(definition.timeframe)}｜${definition.definitionName}`,
    `条件 ${formatTriggerNotificationMaPeriods(definition.timeframe, definition.ma1Period, definition.ma2Period)}`,
    `候補 ${definition.finalCandidateCount}件 / 表示 ${definition.displayedCandidateCount}件`,
    `確認: ${definition.triggerPath}`,
    ...definition.candidates.map(candidateText),
  ].join('\n')).join('\n\n')
  const failures = payload.failedDefinitions.length
    ? `\n\n評価失敗\n${payload.failedDefinitions.map((item) => `${item.definitionName}: ${item.errorCategory ?? 'unknown'}`).join('\n')}`
    : ''
  const textBody = [
    'Trigger Discovery Daily Digest',
    `基準日: ${payload.resolvedAsOf}`,
    `対象Saved Trigger: ${payload.enabledDefinitionCount}`,
    `Final Candidate: ${payload.finalCandidateCount}`,
    `NEW: ${payload.newCount}`,
    `主な変化: ${changes}`,
    '',
    'ScoreはTrigger条件への適合度・確認優先度であり、投資推奨ではありません。',
    '',
    textSections,
  ].join('\n') + failures
  const htmlSections = payload.definitions.map((definition) => `
    <section style="margin:24px 0">
      <h2 style="font-size:17px;margin:0 0 4px"><a href="${escapeHtml(definition.triggerPath)}">${escapeHtml(triggerNotificationTimeframeLabel(definition.timeframe))}｜${escapeHtml(definition.definitionName)}</a></h2>
      <p style="margin:0 0 10px;color:#555">条件 ${escapeHtml(formatTriggerNotificationMaPeriods(definition.timeframe, definition.ma1Period, definition.ma2Period))} ・ 候補 ${definition.finalCandidateCount}件 / 表示 ${definition.displayedCandidateCount}件</p>
      ${definition.candidates.length ? `<table style="${TABLE_STYLE}"><thead><tr>${['銘柄','Status','Score','株価','MA1距離','MA2距離','Zone距離','6 Stage','平均売買代金'].map((label) => `<th style="${TH_STYLE}">${label}</th>`).join('')}</tr></thead><tbody>${definition.candidates.map(candidateHtml).join('')}</tbody></table>` : '<p>候補0件</p>'}
    </section>`).join('')
  const failureHtml = payload.failedDefinitions.length
    ? `<section><h2 style="font-size:15px">評価失敗</h2><ul>${payload.failedDefinitions.map((item) => `<li>${escapeHtml(item.definitionName)}: ${escapeHtml(item.errorCategory ?? 'unknown')}</li>`).join('')}</ul></section>`
    : ''
  const htmlBody = `<main style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#181818;line-height:1.5"><h1 style="font-size:20px">Trigger Discovery Daily Digest</h1><p>基準日 ${escapeHtml(payload.resolvedAsOf)} / 対象 ${payload.enabledDefinitionCount}件 / 候補 ${payload.finalCandidateCount}件 / NEW ${payload.newCount}件</p><p style="color:#555">主な変化: ${escapeHtml(changes)}</p><p style="font-size:12px;color:#666">ScoreはTrigger条件への適合度・確認優先度であり、投資推奨ではありません。</p>${htmlSections}${failureHtml}</main>`
  return { notificationType: 'DAILY_DIGEST', subject, textBody, htmlBody, payload }
}

function lifecycleEventText(event: TriggerLifecycleAlertEvent): string {
  const status = `${event.previousTriggerStatus ?? '—'} → ${event.currentTriggerStatus ?? '—'}`
  const score = `${formatNumber(event.previousScore, 1)} → ${formatNumber(event.currentScore, 1)}`
  return `${triggerNotificationTimeframeLabel(event.timeframe)}｜${event.definitionName} | 条件 ${formatTriggerNotificationMaPeriods(event.timeframe, event.ma1Period, event.ma2Period)} | ${event.ticker} ${event.companyName} | ${status} | Score ${score} | 株価 ${formatNumber(event.previousPrice, 2)} → ${formatNumber(event.currentPrice, 2)} | Zone ${formatPct(event.zoneDistancePct)} | ${formatTriggerStages({ dayAStage: event.stages.dayA, dayBStage: event.stages.dayB, weekAStage: event.stages.weekA, weekBStage: event.stages.weekB, monthAStage: event.stages.monthA, monthBStage: event.stages.monthB })} | ${event.stockPath}`
}

export function buildLifecycleAlertNotification(payload: TriggerLifecycleAlertPayload): BuiltTriggerNotification {
  const shortCounts = payload.sections.slice(0, 4).map((section) => `${section.key.replace('STATUS_CHANGED_TO_', '')} ${section.events.length}`).join(' / ')
  const subject = `Trigger Alert｜${payload.resolvedAsOf}｜${shortCounts}`
  const textBody = [
    'Trigger Discovery Lifecycle Alert',
    `基準日: ${payload.resolvedAsOf}`,
    `対象Saved Trigger: ${payload.enabledDefinitionCount}`,
    `変化: ${payload.eventCount}件`,
    '',
    ...payload.sections.flatMap((section) => [
      `## ${section.label} ${section.events.length}件`,
      ...section.events.map(lifecycleEventText),
      '',
    ]),
    '本通知は状態変化の事実を示すもので、投資推奨ではありません。',
  ].join('\n')
  const htmlSections = payload.sections.map((section) => `<section style="margin:22px 0"><h2 style="font-size:16px;margin-bottom:8px">${escapeHtml(section.label)} ${section.events.length}件</h2><table style="${TABLE_STYLE}"><thead><tr>${['Trigger','銘柄','Status','Score','株価','Zone距離','6 Stage'].map((label) => `<th style="${TH_STYLE}">${label}</th>`).join('')}</tr></thead><tbody>${section.events.map((event) => `<tr><td><a href="${escapeHtml(event.triggerPath)}">${escapeHtml(triggerNotificationTimeframeLabel(event.timeframe))}｜${escapeHtml(event.definitionName)}</a><br><span style="color:#555">条件 ${escapeHtml(formatTriggerNotificationMaPeriods(event.timeframe, event.ma1Period, event.ma2Period))}</span></td><td><a href="${escapeHtml(event.stockPath)}">${escapeHtml(event.ticker)}</a><br><span style="color:#555">${escapeHtml(event.companyName)}</span></td><td>${escapeHtml(event.previousTriggerStatus ?? '—')} → ${escapeHtml(event.currentTriggerStatus ?? '—')}</td><td>${escapeHtml(formatNumber(event.previousScore, 1))} → ${escapeHtml(formatNumber(event.currentScore, 1))}</td><td>${escapeHtml(formatNumber(event.previousPrice, 2))} → ${escapeHtml(formatNumber(event.currentPrice, 2))}</td><td>${escapeHtml(formatPct(event.zoneDistancePct))}</td><td>${escapeHtml(formatTriggerStages({ dayAStage: event.stages.dayA, dayBStage: event.stages.dayB, weekAStage: event.stages.weekA, weekBStage: event.stages.weekB, monthAStage: event.stages.monthA, monthBStage: event.stages.monthB }))}</td></tr>`).join('')}</tbody></table></section>`).join('')
  const htmlBody = `<main style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#181818;line-height:1.5"><h1 style="font-size:20px">Trigger Discovery Lifecycle Alert</h1><p>基準日 ${escapeHtml(payload.resolvedAsOf)} / 変化 ${payload.eventCount}件</p>${htmlSections}<p style="font-size:12px;color:#666">本通知は状態変化の事実を示すもので、投資推奨ではありません。</p></main>`
  return { notificationType: 'LIFECYCLE_ALERT', subject, textBody, htmlBody, payload }
}
