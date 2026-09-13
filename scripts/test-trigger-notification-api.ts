import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { execGet, execRun } from '@/lib/db/client'
import {
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  getSavedTriggerDefinitionForHistory,
} from '@/lib/server/saved-trigger-definitions'
import { GET, PUT } from '@/app/api/trigger-discovery/saved/[id]/notification-settings/route'
import { savedTriggerConfigsFromSearchRequest } from '@/lib/trigger-definition'
import {
  notificationSettingIncludesLifecycleSection,
  type TriggerNotificationSettingsResponse,
} from '@/lib/trigger-notification'

const prefix = '__phase9a_notification_api__'

function request(id: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/trigger-discovery/saved/${id}/notification-settings`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function cleanup(): Promise<void> {
  await execRun('DELETE FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
}

async function main(): Promise<void> {
  await cleanup()
  try {
    const monthlyConfigs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-09-10',
      timeframe: 'MONTHLY',
    })
    const biweeklyConfigs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-09-10',
      timeframe: 'BIWEEKLY',
    })
    const definition = await createSavedTriggerDefinition({ name: `${prefix}monthly`, ...monthlyConfigs })
    const biweekly = await createSavedTriggerDefinition({ name: `${prefix}biweekly`, ...biweeklyConfigs })
    const attemptsBefore = Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_delivery_attempts',
    ))?.count ?? 0)
    const outboxBefore = Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_outbox',
    ))?.count ?? 0)

    const defaultResponse = await GET(request(definition.id, 'GET'), context(definition.id))
    assert.equal(defaultResponse.status, 200)
    const defaults = await defaultResponse.json() as TriggerNotificationSettingsResponse
    assert.equal(defaults.contractVersion, 'trigger-notification-v1')
    assert.equal(defaults.settings.dailyDigestEnabled, false)
    assert.equal(defaults.settings.lifecycleAlertEnabled, false)
    assert.equal(defaults.settings.maxCandidatesInDigest, 10)
    assert.equal(defaults.settings.includeNew, true)
    assert.equal(defaults.settings.includeCoreConditionExit, false)
    assert.equal(defaults.settings.createdAt, null)

    const before = await execGet<{
      evaluation_version: number
      engine_version: number
      score_version: number
      evaluation_signature: string
    }>(
      `SELECT evaluation_version, engine_version, score_version, evaluation_signature
       FROM trigger_definitions WHERE id=?`,
      [definition.id],
    )
    const updatedResponse = await PUT(request(definition.id, 'PUT', {
      dailyDigestEnabled: true,
      lifecycleAlertEnabled: true,
      maxCandidatesInDigest: 7,
      includeNew: false,
    }), context(definition.id))
    assert.equal(updatedResponse.status, 200)
    const updated = await updatedResponse.json() as TriggerNotificationSettingsResponse
    assert.equal(updated.settings.dailyDigestEnabled, true)
    assert.equal(updated.settings.lifecycleAlertEnabled, true)
    assert.equal(updated.settings.maxCandidatesInDigest, 7)
    assert.equal(updated.settings.includeNew, false)
    assert.equal(updated.settings.includeReEntry, true, 'partial PUT preserves the current/default policy')

    const digestReload = await GET(request(definition.id, 'GET'), context(definition.id))
    assert.equal(digestReload.status, 200)
    const digestReloaded = await digestReload.json() as TriggerNotificationSettingsResponse
    assert.equal(digestReloaded.settings.dailyDigestEnabled, true)
    assert.equal(digestReloaded.settings.maxCandidatesInDigest, 7)

    const after = await execGet<typeof before>(
      `SELECT evaluation_version, engine_version, score_version, evaluation_signature
       FROM trigger_definitions WHERE id=?`,
      [definition.id],
    )
    assert.deepEqual(after, before, 'notification changes do not mutate Saved Trigger evaluation identity')

    const alertResponse = await PUT(request(biweekly.id, 'PUT', {
      lifecycleAlertEnabled: true,
      includeNew: true,
      includeReEntry: true,
      includeStatusChangedToNear: true,
      includeStatusChangedToInZone: true,
      includeRebounded: true,
      includeBrokeBelowZone: true,
      includeCoreConditionExit: true,
      includeStageFilterExit: true,
      includeUniverseFilterExit: true,
      includeDataUnavailable: true,
      includeOtherExited: true,
    }), context(biweekly.id))
    assert.equal(alertResponse.status, 200)
    const alert = await alertResponse.json() as TriggerNotificationSettingsResponse
    assert.equal(alert.settings.lifecycleAlertEnabled, true)
    for (const key of [
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
    ] as const) assert.equal(alert.settings[key], true, `${key} must survive the UI/API contract`)
    assert.equal(notificationSettingIncludesLifecycleSection(alert.settings, 'NEW'), true)
    assert.equal(notificationSettingIncludesLifecycleSection(alert.settings, 'STATUS_CHANGED_TO_IN_ZONE'), true)
    assert.equal(notificationSettingIncludesLifecycleSection(alert.settings, 'CORE_CONDITION_EXIT'), true)

    const alertOffResponse = await PUT(request(biweekly.id, 'PUT', {
      lifecycleAlertEnabled: false,
    }), context(biweekly.id))
    assert.equal(alertOffResponse.status, 200)
    const alertOff = await alertOffResponse.json() as TriggerNotificationSettingsResponse
    assert.equal(alertOff.settings.lifecycleAlertEnabled, false)
    assert.equal(alertOff.settings.includeNew, true)
    assert.equal(alertOff.settings.includeCoreConditionExit, true, 'turning Alert off preserves event selections')

    const alertOnResponse = await PUT(request(biweekly.id, 'PUT', {
      lifecycleAlertEnabled: true,
    }), context(biweekly.id))
    const alertOn = await alertOnResponse.json() as TriggerNotificationSettingsResponse
    assert.equal(alertOn.settings.lifecycleAlertEnabled, true)
    assert.equal(alertOn.settings.includeNew, true)
    assert.equal(alertOn.settings.includeCoreConditionExit, true, 'turning Alert back on restores prior selections')

    const monthlyReload = await GET(request(definition.id, 'GET'), context(definition.id))
    const monthlySettings = await monthlyReload.json() as TriggerNotificationSettingsResponse
    assert.equal(monthlySettings.settings.dailyDigestEnabled, true)
    assert.equal(monthlySettings.settings.lifecycleAlertEnabled, true)
    assert.equal(monthlySettings.settings.includeNew, false)
    assert.equal(alertOn.settings.dailyDigestEnabled, false, 'Biweekly Digest remains independently disabled')

    assert.equal((await PUT(request(definition.id, 'PUT', { maxCandidatesInDigest: 0 }), context(definition.id))).status, 400)
    assert.equal((await PUT(request(definition.id, 'PUT', { unknown: true }), context(definition.id))).status, 400)
    assert.equal((await GET(request('not-a-uuid', 'GET'), context('not-a-uuid'))).status, 400)

    await archiveSavedTriggerDefinition(biweekly.id)
    const archivedHistory = await getSavedTriggerDefinitionForHistory(biweekly.id)
    assert.ok(archivedHistory.archivedAt)
    assert.equal(Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_notification_settings WHERE definition_id=?',
      [biweekly.id],
    ))?.count ?? 0), 1, 'archive retains historical notification settings')
    assert.equal((await GET(request(biweekly.id, 'GET'), context(biweekly.id))).status, 404, 'archived definitions cannot be edited through the active UI API')

    const attemptsAfter = Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_delivery_attempts',
    ))?.count ?? 0)
    const outboxAfter = Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_outbox',
    ))?.count ?? 0)
    assert.equal(attemptsAfter, attemptsBefore, 'settings UI/API tests must not create Gmail delivery attempts')
    assert.equal(outboxAfter, outboxBefore, 'settings UI/API tests must not compose or enqueue notifications')

    console.log(JSON.stringify({
      contract: updated.contractVersion,
      defaults: {
        dailyDigestEnabled: defaults.settings.dailyDigestEnabled,
        lifecycleAlertEnabled: defaults.settings.lifecycleAlertEnabled,
        maxCandidatesInDigest: defaults.settings.maxCandidatesInDigest,
      },
      evaluationVersionUnchanged: after?.evaluation_version === before?.evaluation_version,
      engineVersionUnchanged: after?.engine_version === before?.engine_version,
      scoreVersionUnchanged: after?.score_version === before?.score_version,
      evaluationSignatureUnchanged: after?.evaluation_signature === before?.evaluation_signature,
      monthlyBiweeklySeparated: true,
      deliveryAttemptsCreated: attemptsAfter - attemptsBefore,
      outboxRowsCreated: outboxAfter - outboxBefore,
    }, null, 2))
    console.log('Trigger notification settings API tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
