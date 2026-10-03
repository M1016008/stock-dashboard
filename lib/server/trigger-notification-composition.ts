import { randomUUID } from 'node:crypto'
import type { InValue } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import {
  canonicalizeSavedTriggerEvaluationConfig,
  canonicalizeSavedTriggerViewConfig,
  type SavedTriggerEvaluationConfig,
  type SavedTriggerViewConfig,
} from '@/lib/trigger-definition'
import type { TriggerLifecycleEventType } from '@/lib/trigger-lifecycle'
import {
  TRIGGER_LIFECYCLE_ALERT_SECTION_KEYS,
  MAX_CANDIDATES_IN_DIGEST,
  TRIGGER_NOTIFICATION_POLICY_VERSION,
  buildDailyDigestNotification,
  buildLifecycleAlertNotification,
  lifecycleAlertSectionKey,
  notificationSettingIncludesLifecycleSection,
  sortTriggerNotificationCandidates,
  triggerLifecycleAlertSectionLabel,
  type BuiltTriggerNotification,
  type TriggerDailyDigestDefinition,
  type TriggerDailyDigestPayload,
  type TriggerLifecycleAlertEvent,
  type TriggerLifecycleAlertPayload,
  type TriggerLifecycleAlertSectionKey,
  type TriggerNotificationCandidate,
  type TriggerNotificationOutboxStatus,
  type TriggerNotificationSettingsValues,
  type TriggerNotificationType,
} from '@/lib/trigger-notification'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL_BATCH_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS'])
const SUCCESS_ITEM_STATUSES = new Set(['COMPLETED', 'REUSED'])

type BatchRow = {
  id: string
  source: string
  resolved_as_of: string
  status: string
}

type ItemRow = {
  definition_id: string
  definition_name: string
  view_config_json: string
  evaluation_version: number
  evaluation_id: string | null
  evaluation_config_snapshot_json: string | null
  item_status: string
  item_error_category: string | null
  final_matched_count: number | null
  daily_digest_enabled: number
  lifecycle_alert_enabled: number
  max_candidates_in_digest: number
  include_new: number
  include_re_entry: number
  include_status_changed_to_near: number
  include_status_changed_to_in_zone: number
  include_rebounded: number
  include_broke_below_zone: number
  include_core_condition_exit: number
  include_stage_filter_exit: number
  include_universe_filter_exit: number
  include_data_unavailable: number
  include_other_exited: number
}

type MemberRow = {
  evaluation_id: string
  ticker: string
  company_name: string
  trigger_status: TriggerStatus
  trigger_score: number
  price: number
  zone_distance_pct: number
  ma1_distance_pct: number
  ma2_distance_pct: number
  average_volume: number | null
  average_trading_value: number | null
  approach_velocity: number
  day_a_stage: number | null
  day_b_stage: number | null
  week_a_stage: number | null
  week_b_stage: number | null
  month_a_stage: number | null
  month_b_stage: number | null
}

type LifecycleRow = {
  id: string
  definition_id: string
  current_evaluation_id: string
  previous_evaluation_id: string | null
  ticker: string
  event_type: TriggerLifecycleEventType
  previous_trigger_status: TriggerStatus | null
  current_trigger_status: TriggerStatus | null
  exit_reason: string | null
  previous_score: number | null
  current_score: number | null
  previous_price: number | null
  current_price: number | null
  current_zone_distance_pct: number | null
}

type OutboxRow = {
  id: string
  batch_id: string
  notification_type: TriggerNotificationType
  status: TriggerNotificationOutboxStatus
  notification_policy_version: number
  dedupe_key: string
  subject: string
  text_body: string
  html_body: string
  payload_json: string
  created_at: number
  ready_at: number
  send_attempt_count: number
  sent_at: number | null
  last_error_category: string | null
}

export interface TriggerNotificationOutboxEntry {
  id: string
  batchId: string
  notificationType: TriggerNotificationType
  status: TriggerNotificationOutboxStatus
  notificationPolicyVersion: number
  dedupeKey: string
  subject: string
  textBody: string
  htmlBody: string
  payload: TriggerDailyDigestPayload | TriggerLifecycleAlertPayload
  createdAt: string
  readyAt: string
  sendAttemptCount: number
  sentAt: string | null
  lastErrorCategory: string | null
}

export interface TriggerNotificationCompositionResult {
  batchId: string
  resolvedAsOf: string
  notificationPolicyVersion: number
  notifications: TriggerNotificationOutboxEntry[]
  createdCount: number
  reusedCount: number
  performance: {
    sourceReadQueryCount: number
    sourceReadMs: number
    renderMs: number
    outboxWriteMs: number
    totalMs: number
  }
}

export class TriggerNotificationBatchNotFoundError extends Error {
  constructor() {
    super('Trigger日次評価Batchが見つかりません。')
    this.name = 'TriggerNotificationBatchNotFoundError'
  }
}

export class TriggerNotificationBatchNotReadyError extends Error {
  constructor(status: string) {
    super(`Trigger日次評価Batchは通知生成可能な状態ではありません: ${status}`)
    this.name = 'TriggerNotificationBatchNotReadyError'
  }
}

function isoDateTime(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(Number(epochSeconds) * 1000).toISOString()
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(',')
}

function settings(row: ItemRow): TriggerNotificationSettingsValues {
  return {
    dailyDigestEnabled: Boolean(row.daily_digest_enabled),
    lifecycleAlertEnabled: Boolean(row.lifecycle_alert_enabled),
    maxCandidatesInDigest: Number(row.max_candidates_in_digest),
    includeNew: Boolean(row.include_new),
    includeReEntry: Boolean(row.include_re_entry),
    includeStatusChangedToNear: Boolean(row.include_status_changed_to_near),
    includeStatusChangedToInZone: Boolean(row.include_status_changed_to_in_zone),
    includeRebounded: Boolean(row.include_rebounded),
    includeBrokeBelowZone: Boolean(row.include_broke_below_zone),
    includeCoreConditionExit: Boolean(row.include_core_condition_exit),
    includeStageFilterExit: Boolean(row.include_stage_filter_exit),
    includeUniverseFilterExit: Boolean(row.include_universe_filter_exit),
    includeDataUnavailable: Boolean(row.include_data_unavailable),
    includeOtherExited: Boolean(row.include_other_exited),
  }
}

function parseViewConfig(value: string): SavedTriggerViewConfig {
  try {
    return canonicalizeSavedTriggerViewConfig(JSON.parse(value))
  } catch {
    return { sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 50 }
  }
}

function parseEvaluationConfig(value: string | null): SavedTriggerEvaluationConfig {
  if (!value) throw new Error('evaluation_config_snapshot_missing')
  return canonicalizeSavedTriggerEvaluationConfig(JSON.parse(value), { allowLegacyTimeframe: true })
}

function candidate(row: MemberRow): TriggerNotificationCandidate {
  return {
    ticker: row.ticker,
    companyName: row.company_name,
    triggerStatus: row.trigger_status,
    triggerScore: Number(row.trigger_score),
    price: Number(row.price),
    zoneDistancePct: Number(row.zone_distance_pct),
    ma1DistancePct: Number(row.ma1_distance_pct),
    ma2DistancePct: Number(row.ma2_distance_pct),
    averageVolume: row.average_volume == null ? null : Number(row.average_volume),
    averageTradingValue: row.average_trading_value == null ? null : Number(row.average_trading_value),
    approachVelocity: Number(row.approach_velocity),
    dayAStage: row.day_a_stage == null ? null : Number(row.day_a_stage),
    dayBStage: row.day_b_stage == null ? null : Number(row.day_b_stage),
    weekAStage: row.week_a_stage == null ? null : Number(row.week_a_stage),
    weekBStage: row.week_b_stage == null ? null : Number(row.week_b_stage),
    monthAStage: row.month_a_stage == null ? null : Number(row.month_a_stage),
    monthBStage: row.month_b_stage == null ? null : Number(row.month_b_stage),
    stockPath: `/stock/${encodeURIComponent(row.ticker)}`,
  }
}

function itemName(row: ItemRow): string {
  return row.definition_name.trim() || row.definition_id
}

function triggerPath(): string {
  return '/trigger-discovery'
}

function outboxEntry(row: OutboxRow): TriggerNotificationOutboxEntry {
  return {
    id: row.id,
    batchId: row.batch_id,
    notificationType: row.notification_type,
    status: row.status,
    notificationPolicyVersion: Number(row.notification_policy_version),
    dedupeKey: row.dedupe_key,
    subject: row.subject,
    textBody: row.text_body,
    htmlBody: row.html_body,
    payload: JSON.parse(row.payload_json),
    createdAt: isoDateTime(row.created_at)!,
    readyAt: isoDateTime(row.ready_at)!,
    sendAttemptCount: Number(row.send_attempt_count),
    sentAt: isoDateTime(row.sent_at),
    lastErrorCategory: row.last_error_category,
  }
}

function errorCategory(error: unknown): string {
  if (error instanceof TriggerNotificationBatchNotFoundError) return 'batch_not_found'
  if (error instanceof TriggerNotificationBatchNotReadyError) return 'batch_not_ready'
  const message = error instanceof Error ? error.message : String(error)
  if (/SQLITE_BUSY|database is locked/i.test(message)) return 'database_busy'
  return 'composition_failed'
}

function buildDigestPayload(input: {
  batch: BatchRow
  items: ItemRow[]
  events: LifecycleRow[]
  membersByEvaluation: Map<string, TriggerNotificationCandidate[]>
}): TriggerDailyDigestPayload | null {
  const eligible = input.items.filter((row) => SUCCESS_ITEM_STATUSES.has(row.item_status)
    && row.evaluation_id && Boolean(row.daily_digest_enabled))
  if (!eligible.length) return null
  const definitions: TriggerDailyDigestDefinition[] = eligible.map((row) => {
    const viewConfig = parseViewConfig(row.view_config_json)
    const evaluationConfig = parseEvaluationConfig(row.evaluation_config_snapshot_json)
    const sorted = sortTriggerNotificationCandidates(
      input.membersByEvaluation.get(row.evaluation_id!) ?? [],
      viewConfig.sort,
    )
    const limit = Math.max(1, Math.min(MAX_CANDIDATES_IN_DIGEST, Number(row.max_candidates_in_digest)))
    const candidates = sorted.slice(0, limit)
    return {
      definitionId: row.definition_id,
      definitionName: itemName(row),
      evaluationId: row.evaluation_id!,
      evaluationVersion: Number(row.evaluation_version),
      timeframe: evaluationConfig.timeframe,
      ma1Period: evaluationConfig.triggerCore.ma1Period,
      ma2Period: evaluationConfig.triggerCore.ma2Period,
      triggerPath: triggerPath(),
      finalCandidateCount: Number(row.final_matched_count ?? sorted.length),
      displayedCandidateCount: candidates.length,
      maxCandidatesInDigest: limit,
      sort: viewConfig.sort,
      candidates,
    }
  }).sort((left, right) => left.definitionName.localeCompare(right.definitionName, 'ja')
    || left.definitionId.localeCompare(right.definitionId))
  const enabledEvaluationIds = new Set(eligible.map((row) => row.evaluation_id!))
  const scopedEvents = input.events.filter((row) => enabledEvaluationIds.has(row.current_evaluation_id))
  const lifecycleCounts: TriggerDailyDigestPayload['lifecycleCounts'] = {}
  for (const event of scopedEvents) {
    lifecycleCounts[event.event_type] = (lifecycleCounts[event.event_type] ?? 0) + 1
  }
  const lifecycleHighlights: TriggerDailyDigestPayload['lifecycleHighlights'] = {
    new: scopedEvents.filter((row) => row.event_type === 'NEW').length,
    reEntry: scopedEvents.filter((row) => row.event_type === 'RE_ENTRY').length,
    statusChangedToNear: scopedEvents.filter((row) => row.event_type === 'STATUS_CHANGED'
      && row.current_trigger_status === 'NEAR').length,
    statusChangedToInZone: scopedEvents.filter((row) => row.event_type === 'STATUS_CHANGED'
      && row.current_trigger_status === 'IN_ZONE').length,
    rebounded: scopedEvents.filter((row) => row.event_type === 'REBOUNDED').length,
    brokeBelowZone: scopedEvents.filter((row) => row.event_type === 'BROKE_BELOW_ZONE').length,
  }
  const failedDefinitions = input.items.filter((row) => row.item_status === 'FAILED'
    && Boolean(row.daily_digest_enabled)).map((row) => ({
    definitionId: row.definition_id,
    definitionName: itemName(row),
    errorCategory: row.item_error_category,
  }))
  return {
    contractVersion: 'trigger-notification-v1',
    notificationPolicyVersion: TRIGGER_NOTIFICATION_POLICY_VERSION,
    notificationType: 'DAILY_DIGEST',
    batchId: input.batch.id,
    resolvedAsOf: input.batch.resolved_as_of,
    enabledDefinitionCount: definitions.length,
    finalCandidateCount: definitions.reduce((sum, row) => sum + row.finalCandidateCount, 0),
    newCount: lifecycleHighlights.new,
    lifecycleCounts,
    lifecycleHighlights,
    definitions,
    failedDefinitions,
  }
}

function memberKey(evaluationId: string | null, ticker: string): string {
  return `${evaluationId ?? ''}\u001f${ticker}`
}

function buildAlertPayload(input: {
  batch: BatchRow
  items: ItemRow[]
  events: LifecycleRow[]
  membersByKey: Map<string, TriggerNotificationCandidate>
}): TriggerLifecycleAlertPayload | null {
  const eligibleItems = input.items.filter((row) => SUCCESS_ITEM_STATUSES.has(row.item_status)
    && row.evaluation_id && Boolean(row.lifecycle_alert_enabled))
  if (!eligibleItems.length) return null
  const itemByEvaluation = new Map(eligibleItems.map((row) => [row.evaluation_id!, row]))
  const configByEvaluation = new Map(eligibleItems.map((row) => [
    row.evaluation_id!,
    parseEvaluationConfig(row.evaluation_config_snapshot_json),
  ]))
  const grouped = new Map<TriggerLifecycleAlertSectionKey, TriggerLifecycleAlertEvent[]>()
  for (const row of input.events) {
    const item = itemByEvaluation.get(row.current_evaluation_id)
    if (!item) continue
    const sectionKey = lifecycleAlertSectionKey({
      eventType: row.event_type,
      currentTriggerStatus: row.current_trigger_status,
    })
    if (!sectionKey || !notificationSettingIncludesLifecycleSection(settings(item), sectionKey)) continue
    const snapshot = input.membersByKey.get(memberKey(row.current_evaluation_id, row.ticker))
      ?? input.membersByKey.get(memberKey(row.previous_evaluation_id, row.ticker))
    const evaluationConfig = configByEvaluation.get(row.current_evaluation_id)!
    const events = grouped.get(sectionKey) ?? []
    events.push({
      eventId: row.id,
      definitionId: row.definition_id,
      definitionName: itemName(item),
      timeframe: evaluationConfig.timeframe,
      ma1Period: evaluationConfig.triggerCore.ma1Period,
      ma2Period: evaluationConfig.triggerCore.ma2Period,
      triggerPath: triggerPath(),
      ticker: row.ticker,
      companyName: snapshot?.companyName ?? row.ticker,
      stockPath: `/stock/${encodeURIComponent(row.ticker)}`,
      eventType: row.event_type,
      previousTriggerStatus: row.previous_trigger_status,
      currentTriggerStatus: row.current_trigger_status,
      previousScore: row.previous_score == null ? null : Number(row.previous_score),
      currentScore: row.current_score == null ? null : Number(row.current_score),
      previousPrice: row.previous_price == null ? null : Number(row.previous_price),
      currentPrice: row.current_price == null ? null : Number(row.current_price),
      zoneDistancePct: row.current_zone_distance_pct == null ? null : Number(row.current_zone_distance_pct),
      stages: {
        dayA: snapshot?.dayAStage ?? null,
        dayB: snapshot?.dayBStage ?? null,
        weekA: snapshot?.weekAStage ?? null,
        weekB: snapshot?.weekBStage ?? null,
        monthA: snapshot?.monthAStage ?? null,
        monthB: snapshot?.monthBStage ?? null,
      },
      exitReason: row.exit_reason,
    })
    grouped.set(sectionKey, events)
  }
  const sections = TRIGGER_LIFECYCLE_ALERT_SECTION_KEYS.flatMap((key) => {
    const events = grouped.get(key)
    if (!events?.length) return []
    events.sort((left, right) => left.definitionName.localeCompare(right.definitionName, 'ja')
      || (right.currentScore ?? -Infinity) - (left.currentScore ?? -Infinity)
      || left.ticker.localeCompare(right.ticker))
    return [{ key, label: triggerLifecycleAlertSectionLabel(key), events }]
  })
  if (!sections.length) return null
  const lifecycleCounts: TriggerLifecycleAlertPayload['lifecycleCounts'] = {}
  for (const section of sections) lifecycleCounts[section.key] = section.events.length
  return {
    contractVersion: 'trigger-notification-v1',
    notificationPolicyVersion: TRIGGER_NOTIFICATION_POLICY_VERSION,
    notificationType: 'LIFECYCLE_ALERT',
    batchId: input.batch.id,
    resolvedAsOf: input.batch.resolved_as_of,
    enabledDefinitionCount: eligibleItems.length,
    eventCount: sections.reduce((sum, section) => sum + section.events.length, 0),
    lifecycleCounts,
    sections,
  }
}

async function persistOutbox(
  batchId: string,
  notifications: BuiltTriggerNotification[],
  nowSeconds: number,
): Promise<{ entries: TriggerNotificationOutboxEntry[]; createdCount: number }> {
  if (!notifications.length) return { entries: [], createdCount: 0 }
  const tx = await client.transaction('write')
  const keys: string[] = []
  let createdCount = 0
  try {
    for (const notification of notifications) {
      const dedupeKey = `trigger-notification:${batchId}:${notification.notificationType}:v${TRIGGER_NOTIFICATION_POLICY_VERSION}`
      keys.push(dedupeKey)
      const result = await tx.execute({
        sql: `INSERT OR IGNORE INTO notification_outbox (
          id, batch_id, notification_type, status, notification_policy_version,
          dedupe_key, subject, text_body, html_body, payload_json,
          created_at, ready_at, send_attempt_count
        ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        args: [randomUUID(), batchId, notification.notificationType,
          TRIGGER_NOTIFICATION_POLICY_VERSION, dedupeKey, notification.subject,
          notification.textBody, notification.htmlBody, JSON.stringify(notification.payload),
          nowSeconds, nowSeconds] as InValue[],
      })
      createdCount += Number(result.rowsAffected ?? 0)
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  const rows = await execAll<OutboxRow>(
    `SELECT * FROM notification_outbox WHERE dedupe_key IN (${placeholders(keys)}) ORDER BY notification_type`,
    keys,
  )
  return { entries: rows.map(outboxEntry), createdCount }
}

export async function composeTriggerNotificationsForBatch(input: {
  batchId: string
  now?: () => number
}): Promise<TriggerNotificationCompositionResult> {
  const totalStartedAt = performance.now()
  if (!UUID_PATTERN.test(input.batchId)) throw new TriggerNotificationBatchNotFoundError()
  await ensureReady()
  let sourceReadQueryCount = 0
  let sourceReadMs = 0
  const timedRead = async <T>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now()
    const result = await operation()
    sourceReadMs += performance.now() - startedAt
    sourceReadQueryCount += 1
    return result
  }
  const batch = await timedRead(() => execGet<BatchRow>(
    'SELECT id, source, resolved_as_of, status FROM trigger_evaluation_batches WHERE id=?',
    [input.batchId],
  ))
  if (!batch) throw new TriggerNotificationBatchNotFoundError()
  if (batch.source !== 'DAILY' || !TERMINAL_BATCH_STATUSES.has(batch.status)) {
    throw new TriggerNotificationBatchNotReadyError(batch.status)
  }

  const compositionRunId = randomUUID()
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000)
  await execRun(`INSERT INTO trigger_notification_composition_runs (
    id, batch_id, notification_policy_version, started_at, status
  ) VALUES (?, ?, ?, ?, 'RUNNING')`, [
    compositionRunId, batch.id, TRIGGER_NOTIFICATION_POLICY_VERSION, nowSeconds,
  ])

  try {
    const items = await timedRead(() => execAll<ItemRow>(`
      SELECT items.definition_id,
             COALESCE(NULLIF(items.definition_name, ''), definitions.name) AS definition_name,
             COALESCE(NULLIF(items.view_config_json, ''), definitions.view_config_json) AS view_config_json,
             items.evaluation_version,
             items.evaluation_id,
             evaluations.evaluation_config_snapshot_json,
             items.status AS item_status,
             items.error_category AS item_error_category,
             evaluations.final_matched_count,
             settings.daily_digest_enabled,
             settings.lifecycle_alert_enabled,
             settings.max_candidates_in_digest,
             settings.include_new,
             settings.include_re_entry,
             settings.include_status_changed_to_near,
             settings.include_status_changed_to_in_zone,
             settings.include_rebounded,
             settings.include_broke_below_zone,
             settings.include_core_condition_exit,
             settings.include_stage_filter_exit,
             settings.include_universe_filter_exit,
             settings.include_data_unavailable,
             settings.include_other_exited
      FROM trigger_evaluation_batch_items AS items
      INNER JOIN trigger_definitions AS definitions
        ON definitions.id=items.definition_id AND definitions.archived_at IS NULL
      INNER JOIN trigger_notification_settings AS settings
        ON settings.definition_id=items.definition_id
      LEFT JOIN trigger_evaluations AS evaluations
        ON evaluations.id=items.evaluation_id AND evaluations.status='COMPLETED'
      WHERE items.batch_id=?
      ORDER BY items.definition_id
    `, [batch.id]))
    const evaluationIds = items.flatMap((row) => row.evaluation_id ? [row.evaluation_id] : [])
    const events = evaluationIds.length
      ? await timedRead(() => execAll<LifecycleRow>(`
          SELECT id, definition_id, current_evaluation_id, previous_evaluation_id,
                 ticker, event_type, previous_trigger_status, current_trigger_status,
                 exit_reason, previous_score, current_score, previous_price,
                 current_price, current_zone_distance_pct
          FROM trigger_lifecycle_events
          WHERE current_evaluation_id IN (${placeholders(evaluationIds)})
          ORDER BY current_evaluation_id, ticker, event_type
        `, evaluationIds))
      : []
    const memberEvaluationIds = [...new Set([
      ...evaluationIds,
      ...events.flatMap((row) => row.previous_evaluation_id ? [row.previous_evaluation_id] : []),
    ])]
    const memberRows = memberEvaluationIds.length
      ? await timedRead(() => execAll<MemberRow>(`
          SELECT evaluation_id, ticker, company_name, trigger_status, trigger_score,
                 price, zone_distance_pct, ma1_distance_pct, ma2_distance_pct,
                 average_volume, average_trading_value, approach_velocity,
                 day_a_stage, day_b_stage, week_a_stage, week_b_stage,
                 month_a_stage, month_b_stage
          FROM trigger_evaluation_members
          WHERE evaluation_id IN (${placeholders(memberEvaluationIds)})
          ORDER BY evaluation_id, ticker
        `, memberEvaluationIds))
      : []
    const membersByEvaluation = new Map<string, TriggerNotificationCandidate[]>()
    const membersByKey = new Map<string, TriggerNotificationCandidate>()
    for (const row of memberRows) {
      const mapped = candidate(row)
      const members = membersByEvaluation.get(row.evaluation_id) ?? []
      members.push(mapped)
      membersByEvaluation.set(row.evaluation_id, members)
      membersByKey.set(memberKey(row.evaluation_id, row.ticker), mapped)
    }

    const renderStartedAt = performance.now()
    const digestPayload = buildDigestPayload({ batch, items, events, membersByEvaluation })
    const alertPayload = buildAlertPayload({ batch, items, events, membersByKey })
    const built = [
      digestPayload ? buildDailyDigestNotification(digestPayload) : null,
      alertPayload ? buildLifecycleAlertNotification(alertPayload) : null,
    ].filter((value): value is BuiltTriggerNotification => value != null)
    const renderMs = performance.now() - renderStartedAt

    const writeStartedAt = performance.now()
    const persisted = await persistOutbox(batch.id, built, nowSeconds)
    const outboxWriteMs = performance.now() - writeStartedAt
    const reusedCount = persisted.entries.length - persisted.createdCount
    const totalMs = performance.now() - totalStartedAt
    await execRun(`UPDATE trigger_notification_composition_runs SET
      completed_at=unixepoch(), status='COMPLETED', created_count=?, reused_count=?,
      duration_ms=?, error_category=NULL WHERE id=?`, [
      persisted.createdCount, reusedCount, totalMs, compositionRunId,
    ])
    return {
      batchId: batch.id,
      resolvedAsOf: batch.resolved_as_of,
      notificationPolicyVersion: TRIGGER_NOTIFICATION_POLICY_VERSION,
      notifications: persisted.entries,
      createdCount: persisted.createdCount,
      reusedCount,
      performance: { sourceReadQueryCount, sourceReadMs, renderMs, outboxWriteMs, totalMs },
    }
  } catch (error) {
    await execRun(`UPDATE trigger_notification_composition_runs SET
      completed_at=unixepoch(), status='FAILED', duration_ms=?, error_category=? WHERE id=?`, [
      performance.now() - totalStartedAt, errorCategory(error), compositionRunId,
    ]).catch(() => undefined)
    throw error
  }
}
