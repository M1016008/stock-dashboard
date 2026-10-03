import { execGet, execRun } from '@/lib/db/client'
import { getSavedTriggerDefinition, validateSavedTriggerId } from '@/lib/server/saved-trigger-definitions'
import {
  DEFAULT_TRIGGER_NOTIFICATION_SETTINGS,
  mergeTriggerNotificationSettings,
  type TriggerNotificationSettings,
  type TriggerNotificationSettingsValues,
} from '@/lib/trigger-notification'

type SettingsRow = {
  definition_id: string
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
  created_at: number
  updated_at: number
}

function isoDateTime(value: number): string {
  return new Date(Number(value) * 1000).toISOString()
}

function rowToSettings(row: SettingsRow): TriggerNotificationSettings {
  return {
    definitionId: row.definition_id,
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
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  }
}

function defaultSettings(definitionId: string): TriggerNotificationSettings {
  return {
    definitionId,
    ...DEFAULT_TRIGGER_NOTIFICATION_SETTINGS,
    createdAt: null,
    updatedAt: null,
  }
}

async function storedSettings(definitionId: string): Promise<TriggerNotificationSettings | null> {
  const row = await execGet<SettingsRow>(
    'SELECT * FROM trigger_notification_settings WHERE definition_id=?',
    [definitionId],
  )
  return row ? rowToSettings(row) : null
}

export async function getTriggerNotificationSettings(
  definitionId: string,
): Promise<TriggerNotificationSettings> {
  validateSavedTriggerId(definitionId)
  await getSavedTriggerDefinition(definitionId)
  return await storedSettings(definitionId) ?? defaultSettings(definitionId)
}

export async function updateTriggerNotificationSettings(
  definitionId: string,
  input: unknown,
): Promise<TriggerNotificationSettings> {
  validateSavedTriggerId(definitionId)
  await getSavedTriggerDefinition(definitionId)
  const current = await storedSettings(definitionId)
  const values = mergeTriggerNotificationSettings(input, current ?? { ...DEFAULT_TRIGGER_NOTIFICATION_SETTINGS })
  await persistSettings(definitionId, values)
  return (await storedSettings(definitionId))!
}

async function persistSettings(
  definitionId: string,
  settings: TriggerNotificationSettingsValues,
): Promise<void> {
  await execRun(`INSERT INTO trigger_notification_settings (
      definition_id, daily_digest_enabled, lifecycle_alert_enabled,
      max_candidates_in_digest, include_new, include_re_entry,
      include_status_changed_to_near, include_status_changed_to_in_zone,
      include_rebounded, include_broke_below_zone, include_core_condition_exit,
      include_stage_filter_exit, include_universe_filter_exit,
      include_data_unavailable, include_other_exited, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(definition_id) DO UPDATE SET
      daily_digest_enabled=excluded.daily_digest_enabled,
      lifecycle_alert_enabled=excluded.lifecycle_alert_enabled,
      max_candidates_in_digest=excluded.max_candidates_in_digest,
      include_new=excluded.include_new,
      include_re_entry=excluded.include_re_entry,
      include_status_changed_to_near=excluded.include_status_changed_to_near,
      include_status_changed_to_in_zone=excluded.include_status_changed_to_in_zone,
      include_rebounded=excluded.include_rebounded,
      include_broke_below_zone=excluded.include_broke_below_zone,
      include_core_condition_exit=excluded.include_core_condition_exit,
      include_stage_filter_exit=excluded.include_stage_filter_exit,
      include_universe_filter_exit=excluded.include_universe_filter_exit,
      include_data_unavailable=excluded.include_data_unavailable,
      include_other_exited=excluded.include_other_exited,
      updated_at=unixepoch()`, [
    definitionId,
    settings.dailyDigestEnabled ? 1 : 0,
    settings.lifecycleAlertEnabled ? 1 : 0,
    settings.maxCandidatesInDigest,
    settings.includeNew ? 1 : 0,
    settings.includeReEntry ? 1 : 0,
    settings.includeStatusChangedToNear ? 1 : 0,
    settings.includeStatusChangedToInZone ? 1 : 0,
    settings.includeRebounded ? 1 : 0,
    settings.includeBrokeBelowZone ? 1 : 0,
    settings.includeCoreConditionExit ? 1 : 0,
    settings.includeStageFilterExit ? 1 : 0,
    settings.includeUniverseFilterExit ? 1 : 0,
    settings.includeDataUnavailable ? 1 : 0,
    settings.includeOtherExited ? 1 : 0,
  ])
}
