import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { client, ensureReady, execAll, execGet, execRun, localDbPath } from '@/lib/db/client'
import {
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'
import { updateTriggerNotificationSettings } from '@/lib/server/trigger-notification-settings'
import { savedTriggerConfigsFromSearchRequest, type SavedTriggerDefinition } from '@/lib/trigger-definition'
import {
  DEFAULT_TRIGGER_NOTIFICATION_SETTINGS,
  formatTriggerNotificationMaPeriods,
  formatTriggerStages,
  notificationSettingIncludesLifecycleSection,
  sortTriggerNotificationCandidates,
  triggerNotificationTimeframeLabel,
} from '@/lib/trigger-notification'

const prefix = '__phase9a_notification__'
const date = '2098-09-10'
const batchId = randomUUID()
const evaluationIds: string[] = []
const definitionIds: string[] = []

function dbBytes(): number {
  return [localDbPath, `${localDbPath}-wal`, `${localDbPath}-shm`].reduce((sum, path) => {
    try { return sum + fs.statSync(path).size } catch { return sum }
  }, 0)
}

async function cleanup(): Promise<void> {
  await ensureReady()
  const storedDefinitions = await execAll<{ id: string }>(
    'SELECT id FROM trigger_definitions WHERE name LIKE ?',
    [`${prefix}%`],
  )
  const ids = [...new Set([...definitionIds, ...storedDefinitions.map((row) => row.id)])]
  if (!ids.length) return
  const definitionMarks = ids.map(() => '?').join(',')
  const storedEvaluations = await execAll<{ id: string }>(
    `SELECT id FROM trigger_evaluations WHERE definition_id IN (${definitionMarks})`, ids,
  )
  const storedBatches = await execAll<{ batch_id: string }>(
    `SELECT DISTINCT batch_id FROM trigger_evaluation_batch_items WHERE definition_id IN (${definitionMarks})`, ids,
  )
  const evalIds = [...new Set([...evaluationIds, ...storedEvaluations.map((row) => row.id)])]
  const batchIds = [...new Set([batchId, ...storedBatches.map((row) => row.batch_id)])]
  if (evalIds.length) {
    const marks = evalIds.map(() => '?').join(',')
    await execRun(`DELETE FROM trigger_lifecycle_events WHERE current_evaluation_id IN (${marks}) OR previous_evaluation_id IN (${marks})`, [...evalIds, ...evalIds])
    await execRun(`DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (${marks})`, evalIds)
  }
  if (batchIds.length) {
    const marks = batchIds.map(() => '?').join(',')
    await execRun(`DELETE FROM notification_outbox WHERE batch_id IN (${marks})`, batchIds)
    await execRun(`DELETE FROM trigger_notification_composition_runs WHERE batch_id IN (${marks})`, batchIds)
    await execRun(`DELETE FROM trigger_evaluation_batch_items WHERE batch_id IN (${marks})`, batchIds)
    await execRun(`DELETE FROM trigger_evaluation_batches WHERE id IN (${marks})`, batchIds)
  }
  if (evalIds.length) {
    const marks = evalIds.map(() => '?').join(',')
    await execRun(`DELETE FROM trigger_evaluations WHERE id IN (${marks})`, evalIds)
  }
  await execRun(`DELETE FROM trigger_notification_settings WHERE definition_id IN (${definitionMarks})`, ids)
  await execRun(`DELETE FROM trigger_definitions WHERE id IN (${definitionMarks})`, ids)
}

async function definition(
  name: string,
  sort: SavedTriggerDefinition['viewConfig']['sort'],
  timeframe: SavedTriggerDefinition['evaluationConfig']['timeframe'] = 'MONTHLY',
) {
  const configs = savedTriggerConfigsFromSearchRequest({ requestedAsOf: date, timeframe, sort, pageSize: 50 })
  const created = await createSavedTriggerDefinition({ name: `${prefix}${name}`, ...configs })
  definitionIds.push(created.id)
  return created
}

async function evaluation(definitionRow: SavedTriggerDefinition, resolvedAsOf: string, finalCount: number) {
  const id = randomUUID()
  evaluationIds.push(id)
  await execRun(`INSERT INTO trigger_evaluations (
    id, definition_id, evaluation_version, engine_version, score_version,
    run_signature, evaluation_config_signature, evaluation_config_snapshot_json,
    requested_as_of, resolved_as_of, started_at, completed_at, status,
    final_matched_count, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), 'COMPLETED', ?, unixepoch())`, [
    id, definitionRow.id, definitionRow.evaluationVersion, definitionRow.engineVersion,
    definitionRow.scoreVersion, randomUUID(), definitionRow.evaluationSignature,
    JSON.stringify(definitionRow.evaluationConfig), resolvedAsOf, resolvedAsOf, finalCount,
  ])
  return id
}

type FixtureMember = {
  evaluationId: string
  ticker: string
  companyName: string
  status?: 'APPROACHING' | 'NEAR' | 'IN_ZONE'
  price?: number
  score?: number
  stage?: number | null
}

async function insertMembers(rows: FixtureMember[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 20) {
    const chunk = rows.slice(offset, offset + 20)
    const args = chunk.flatMap((row) => {
      const price = row.price ?? 100
      const status = row.status ?? 'NEAR'
      const stage = row.stage === undefined ? 2 : row.stage
      return [
        row.evaluationId, row.ticker, row.companyName, 'プライム', status,
        price, 98, 97, 98, 97, 1, 2, 3, 0.25, 1_000_000,
        price * 1_000_000, stage, stage, stage, stage, stage, stage,
        stage == null ? 0 : 1, stage == null ? 0 : 1, row.score ?? 80, '{}',
        date, date, stage == null ? null : date, 'CURRENT', 0, 20, 20, 1,
        20, 25, 'RISING', 'RISING', 1, 1, 1, 1, 'TOWARD_ZONE', 'stored',
      ]
    })
    const marks = chunk.map(() => `(${Array(44).fill('?').join(',')})`).join(',')
    await execRun(`INSERT INTO trigger_evaluation_members (
      evaluation_id, ticker, company_name, market, trigger_status,
      price, ma1_value, ma2_value, zone_upper, zone_lower, zone_distance_pct,
      ma1_distance_pct, ma2_distance_pct, approach_velocity, average_volume,
      average_trading_value, day_a_stage, day_b_stage, week_a_stage, week_b_stage,
      month_a_stage, month_b_stage, stage_available, stage_complete, trigger_score,
      score_breakdown_json, price_date, ma_date, stage_date, price_freshness,
      price_staleness_sessions, liquidity_lookback_sessions, liquidity_observation_count,
      liquidity_complete, ma1_period, ma2_period, ma1_trend, ma2_trend,
      ma1_slope_pct, ma2_slope_pct, both_rising, from_above, approach_direction, ma_path
    ) VALUES ${marks}`, args)
  }
}

async function batchItem(
  definitionRow: SavedTriggerDefinition,
  evaluationId: string | null,
  status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
): Promise<void> {
  await execRun(`INSERT INTO trigger_evaluation_batch_items (
    batch_id, definition_id, definition_name, view_config_json,
    evaluation_version, evaluation_config_signature, engine_version, score_version,
    evaluation_id, status, error_category
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    batchId, definitionRow.id, definitionRow.name, JSON.stringify(definitionRow.viewConfig),
    definitionRow.evaluationVersion, definitionRow.evaluationSignature,
    definitionRow.engineVersion, definitionRow.scoreVersion, evaluationId, status,
    status === 'FAILED' ? 'synthetic_failure' : null,
  ])
}

async function lifecycleEvent(input: {
  definitionId: string
  previousEvaluationId: string
  currentEvaluationId: string
  ticker: string
  eventType: string
  previousStatus: string | null
  currentStatus: string | null
}): Promise<void> {
  await execRun(`INSERT INTO trigger_lifecycle_events (
    id, definition_id, evaluation_version, previous_evaluation_id,
    current_evaluation_id, ticker, event_type, previous_trigger_status,
    current_trigger_status, previous_score, current_score, previous_price,
    current_price, current_zone_distance_pct, resolved_as_of, created_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 70, 80, 110, 100, 1, ?, unixepoch())`, [
    randomUUID(), input.definitionId, input.previousEvaluationId, input.currentEvaluationId,
    input.ticker, input.eventType, input.previousStatus, input.currentStatus, date,
  ])
}

async function main(): Promise<void> {
  await cleanup()
  const beforeBytes = dbBytes()
  try {
    assert.equal(formatTriggerStages({
      dayAStage: 4, dayBStage: 3, weekAStage: 2,
      weekBStage: 1, monthAStage: null, monthBStage: null,
    }), '日 4/3｜週 2/1｜月 —/—')
    assert.equal(triggerNotificationTimeframeLabel('MONTHLY'), '月足')
    assert.equal(triggerNotificationTimeframeLabel('BIWEEKLY'), '2週足')
    assert.equal(formatTriggerNotificationMaPeriods('MONTHLY', 20, 25), '20か月 / 25か月')
    assert.equal(formatTriggerNotificationMaPeriods('BIWEEKLY', 20, 25), '20本 / 25本')

    const digestA = await definition('digest-price-desc', { key: 'price', direction: 'desc' }, 'BIWEEKLY')
    const digestZero = await definition('digest-zero', { key: 'triggerScore', direction: 'desc' })
    const alert = await definition('alert', null, 'BIWEEKLY')
    const extraA = await definition('extra-a', { key: 'triggerScore', direction: 'desc' })
    const extraB = await definition('extra-b', { key: 'ticker', direction: 'asc' })
    const biweeklyBaseline = await definition('biweekly-baseline', null, 'BIWEEKLY')
    const biweeklyOff = await definition('biweekly-off', null, 'BIWEEKLY')

    const digestAEvaluation = await evaluation(digestA, date, 300)
    const digestZeroEvaluation = await evaluation(digestZero, date, 0)
    const { timeframe: _legacyTimeframe, ...legacyMonthlyEvaluationConfig } = digestZero.evaluationConfig
    await execRun(
      'UPDATE trigger_evaluations SET evaluation_config_snapshot_json=? WHERE id=?',
      [JSON.stringify(legacyMonthlyEvaluationConfig), digestZeroEvaluation],
    )
    const alertPreviousEvaluation = await evaluation(alert, '2098-09-09', 100)
    const alertEvaluation = await evaluation(alert, date, 100)
    const extraAEvaluation = await evaluation(extraA, date, 300)
    const biweeklyBaselineEvaluation = await evaluation(biweeklyBaseline, date, 1)
    const biweeklyOffEvaluation = await evaluation(biweeklyOff, date, 1)

    await insertMembers(Array.from({ length: 300 }, (_, index) => ({
      evaluationId: digestAEvaluation,
      ticker: String(9000 + index),
      companyName: `Digest ${index}`,
      price: 100 + index,
      score: 50 + index / 10,
      stage: index === 0 ? null : 2,
    })))
    await insertMembers(Array.from({ length: 300 }, (_, index) => ({
      evaluationId: extraAEvaluation,
      ticker: String(8000 + index), companyName: `Extra A ${index}`, score: 100 - index / 10,
    })))
    const eventSpecs = [
      ['9101', 'NEW', null, 'APPROACHING'],
      ['9102', 'RE_ENTRY', null, 'NEAR'],
      ['9103', 'STATUS_CHANGED', 'APPROACHING', 'NEAR'],
      ['9104', 'STATUS_CHANGED', 'NEAR', 'IN_ZONE'],
      ['9105', 'REBOUNDED', 'IN_ZONE', 'NEAR'],
      ['9106', 'BROKE_BELOW_ZONE', 'IN_ZONE', null],
    ] as const
    const previousMembers: FixtureMember[] = []
    const currentMembers: FixtureMember[] = []
    for (let index = 0; index < 100; index += 1) {
      const spec = eventSpecs[index % eventSpecs.length]
      const ticker = `${spec[0]}${String(index).padStart(3, '0')}`
      previousMembers.push({
        evaluationId: alertPreviousEvaluation, ticker, companyName: `Alert ${index}`,
        status: (spec[2] ?? 'NEAR') as 'APPROACHING' | 'NEAR' | 'IN_ZONE', score: 70,
      })
      if (spec[3]) currentMembers.push({
        evaluationId: alertEvaluation, ticker, companyName: `Alert ${index}`,
        status: spec[3] as 'APPROACHING' | 'NEAR' | 'IN_ZONE', score: 80,
      })
      await lifecycleEvent({
        definitionId: alert.id,
        previousEvaluationId: alertPreviousEvaluation,
        currentEvaluationId: alertEvaluation,
        ticker,
        eventType: spec[1],
        previousStatus: spec[2],
        currentStatus: spec[3],
      })
    }
    await insertMembers([...previousMembers, ...currentMembers])
    await insertMembers([
      { evaluationId: biweeklyBaselineEvaluation, ticker: '9201', companyName: 'Biweekly Baseline' },
      { evaluationId: biweeklyOffEvaluation, ticker: '9202', companyName: 'Biweekly Off' },
    ])

    await execRun(`INSERT INTO trigger_evaluation_batches (
      id, source, requested_as_of, resolved_as_of, started_at, completed_at,
      status, definition_count, evaluation_count, lifecycle_event_count, failed_count, created_at
    ) VALUES (?, 'DAILY', ?, ?, unixepoch(), unixepoch(), 'COMPLETED_WITH_ERRORS', 7, 6, 100, 1, unixepoch())`, [batchId, date, date])
    await batchItem(digestA, digestAEvaluation)
    await batchItem(digestZero, digestZeroEvaluation)
    await batchItem(alert, alertEvaluation)
    await batchItem(extraA, extraAEvaluation)
    await batchItem(extraB, null, 'FAILED')
    await batchItem(biweeklyBaseline, biweeklyBaselineEvaluation)
    await batchItem(biweeklyOff, biweeklyOffEvaluation)

    await updateTriggerNotificationSettings(digestA.id, { dailyDigestEnabled: true, maxCandidatesInDigest: 10 })
    await updateTriggerNotificationSettings(digestZero.id, { dailyDigestEnabled: true, maxCandidatesInDigest: 10 })
    await updateTriggerNotificationSettings(alert.id, { lifecycleAlertEnabled: true })
    await updateTriggerNotificationSettings(extraA.id, { dailyDigestEnabled: true, maxCandidatesInDigest: 10 })
    await updateTriggerNotificationSettings(extraB.id, { dailyDigestEnabled: true, maxCandidatesInDigest: 10 })
    await updateTriggerNotificationSettings(biweeklyBaseline.id, {
      dailyDigestEnabled: true,
      lifecycleAlertEnabled: true,
      maxCandidatesInDigest: 10,
    })
    const changedAlertConfig = structuredClone(alert.evaluationConfig)
    changedAlertConfig.timeframe = 'MONTHLY'
    await updateSavedTriggerDefinition(alert.id, { evaluationConfig: changedAlertConfig })

    const first = await composeTriggerNotificationsForBatch({ batchId })
    assert.equal(first.notifications.length, 2)
    assert.equal(first.createdCount, 2)
    assert.equal(first.performance.sourceReadQueryCount, 4)
    const digest = first.notifications.find((item) => item.notificationType === 'DAILY_DIGEST')!
    const alertNotification = first.notifications.find((item) => item.notificationType === 'LIFECYCLE_ALERT')!
    assert.equal(digest.status, 'PENDING')
    assert.equal(digest.payload.notificationType, 'DAILY_DIGEST')
    if (digest.payload.notificationType !== 'DAILY_DIGEST') throw new Error('unexpected payload')
    assert.equal(digest.payload.definitions.length, 4, 'Monthly and Biweekly definitions share one digest')
    assert.equal(digest.payload.failedDefinitions.length, 1, 'a failed definition is reported without fabricated candidates')
    const digestASection = digest.payload.definitions.find((row) => row.definitionId === digestA.id)!
    assert.equal(digestASection.finalCandidateCount, 300)
    assert.equal(digestASection.timeframe, 'BIWEEKLY')
    assert.equal(digestASection.ma1Period, 20)
    assert.equal(digestASection.ma2Period, 25)
    assert.equal(digestASection.candidates.length, 10)
    assert.equal(digestASection.candidates[0].price, 399, 'Saved View Config price desc controls digest order')
    assert.equal(digestASection.candidates.at(-1)?.price, 390)
    assert.ok(digest.payload.definitions.some((row) => row.definitionId === digestZero.id && row.finalCandidateCount === 0))
    assert.equal(
      digest.payload.definitions.find((row) => row.definitionId === digestZero.id)?.timeframe,
      'MONTHLY',
      'legacy Evaluation Snapshot without timeframe remains Monthly',
    )
    assert.match(digest.textBody, /候補 0件/)
    assert.match(digest.textBody, /2週足｜.*digest-price-desc/)
    assert.match(digest.textBody, /条件 20本 \/ 25本/)
    assert.match(digest.textBody, /月足｜.*digest-zero/)
    assert.match(digest.textBody, /条件 20か月 \/ 25か月/)
    assert.match(digest.htmlBody, /2週足/)
    assert.match(digest.htmlBody, /20本 \/ 25本/)
    assert.ok(!digest.htmlBody.includes('localhost'))
    assert.ok(digest.htmlBody.includes('/stock/'))
    assert.ok(!digest.payload.definitions.some((row) => row.candidates.length > 10))
    assert.deepEqual(
      sortTriggerNotificationCandidates(digestASection.candidates.slice(0, 2), null).map((row) => row.ticker),
      digestASection.candidates.slice(0, 2).sort((left, right) => right.triggerScore - left.triggerScore || left.ticker.localeCompare(right.ticker)).map((row) => row.ticker),
      'missing View Sort falls back to Trigger Score desc then ticker',
    )

    assert.equal(alertNotification.payload.notificationType, 'LIFECYCLE_ALERT')
    if (alertNotification.payload.notificationType !== 'LIFECYCLE_ALERT') throw new Error('unexpected payload')
    assert.deepEqual(alertNotification.payload.sections.map((section) => section.key), [
      'BROKE_BELOW_ZONE', 'REBOUNDED', 'STATUS_CHANGED_TO_IN_ZONE',
      'STATUS_CHANGED_TO_NEAR', 'NEW', 'RE_ENTRY',
    ])
    assert.equal(alertNotification.payload.eventCount, 100)
    assert.equal(
      alertNotification.payload.sections.some((section) => section.events.some(
        (event) => event.definitionId === biweeklyBaseline.id,
      )),
      false,
      'a Biweekly baseline with no Lifecycle Event must not create an alert event',
    )
    assert.equal(
      digest.payload.definitions.some((row) => row.definitionId === biweeklyOff.id),
      false,
      'a Biweekly definition with default-off notification settings must not enter the outbox payload',
    )
    const firstAlertEvent = alertNotification.payload.sections[0].events[0]
    assert.equal(firstAlertEvent.timeframe, 'BIWEEKLY')
    assert.equal(firstAlertEvent.ma1Period, 20)
    assert.equal(firstAlertEvent.ma2Period, 25)
    assert.match(alertNotification.textBody, /2週足｜.*alert/)
    assert.match(alertNotification.textBody, /条件 20本 \/ 25本/)
    assert.match(alertNotification.htmlBody, /2週足/)
    assert.equal(
      firstAlertEvent.timeframe,
      'BIWEEKLY',
      'notification timeframe comes from the immutable Evaluation Snapshot, not the current Definition',
    )

    const second = await composeTriggerNotificationsForBatch({ batchId })
    assert.equal(second.createdCount, 0)
    assert.equal(second.reusedCount, 2)
    assert.deepEqual(second.notifications.map((item) => item.payload), first.notifications.map((item) => item.payload))
    assert.deepEqual(second.notifications.map((item) => item.textBody), first.notifications.map((item) => item.textBody))
    assert.equal(Number((await execGet<{ count: number }>('SELECT COUNT(*) AS count FROM notification_outbox WHERE batch_id=?', [batchId]))?.count), 2)

    await execRun('DELETE FROM notification_outbox WHERE batch_id=?', [batchId])
    await archiveSavedTriggerDefinition(extraA.id)
    const afterArchive = await composeTriggerNotificationsForBatch({ batchId })
    const archivedDigest = afterArchive.notifications.find((item) => item.notificationType === 'DAILY_DIGEST')
    assert.equal(archivedDigest?.payload.notificationType, 'DAILY_DIGEST')
    if (archivedDigest?.payload.notificationType !== 'DAILY_DIGEST') throw new Error('digest missing after archive')
    assert.equal(
      archivedDigest.payload.definitions.some((row) => row.definitionId === extraA.id),
      false,
      'an archived definition is not included in newly composed notifications',
    )

    const allEventsOff = {
      ...DEFAULT_TRIGGER_NOTIFICATION_SETTINGS,
      lifecycleAlertEnabled: true,
      includeNew: false,
      includeReEntry: false,
      includeStatusChangedToNear: false,
      includeStatusChangedToInZone: false,
      includeRebounded: false,
      includeBrokeBelowZone: false,
    }
    assert.equal(notificationSettingIncludesLifecycleSection(allEventsOff, 'NEW'), false)
    assert.equal(notificationSettingIncludesLifecycleSection(DEFAULT_TRIGGER_NOTIFICATION_SETTINGS, 'NEW'), true)
    assert.equal(notificationSettingIncludesLifecycleSection(DEFAULT_TRIGGER_NOTIFICATION_SETTINGS, 'CORE_CONDITION_EXIT'), false)
    const compositionSource = fs.readFileSync('lib/server/trigger-notification-composition.ts', 'utf8')
    for (const forbidden of ['getTriggerDiscovery', 'ohlcv_daily', 'monthly_ma_monitor_daily', 'daily_snapshots']) {
      assert.equal(compositionSource.includes(forbidden), false, `composition must not read or invoke ${forbidden}`)
    }
    const pipelineSource = fs.readFileSync('scripts/refresh-after-ohlcv.ts', 'utf8')
    assert.ok(pipelineSource.indexOf('runDailyTriggerEvaluations') < pipelineSource.lastIndexOf('composeTriggerNotificationsForBatch'))
    assert.match(pipelineSource, /Trigger notification composition failed:/)

    await execRun('DELETE FROM notification_outbox WHERE batch_id=?', [batchId])
    for (const row of [digestA, digestZero, extraB, biweeklyBaseline]) {
      await updateTriggerNotificationSettings(row.id, { dailyDigestEnabled: false })
    }
    await updateTriggerNotificationSettings(alert.id, allEventsOff)
    const disabled = await composeTriggerNotificationsForBatch({ batchId })
    assert.equal(disabled.notifications.length, 0, 'disabled digest and filtered alert do not create empty outbox rows')

    const batch = await execGet<{ status: string }>('SELECT status FROM trigger_evaluation_batches WHERE id=?', [batchId])
    assert.equal(batch?.status, 'COMPLETED_WITH_ERRORS', 'composition never mutates Daily Batch status')
    const outboxBytes = first.notifications.reduce((sum, row) => (
      sum + Buffer.byteLength(row.textBody) + Buffer.byteLength(row.htmlBody)
      + Buffer.byteLength(JSON.stringify(row.payload))
    ), 0)
    console.log(JSON.stringify({
      fixture: { definitions: 7, successfulDefinitions: 6, digestCandidates: 601, lifecycleEvents: 100 },
      firstPerformance: first.performance,
      secondPerformance: second.performance,
      outboxPayloadBytes: outboxBytes,
      databaseFileGrowthBytesDuringFixture: dbBytes() - beforeBytes,
      sourceReads: ['Batch', 'Batch Items + Evaluation + Settings + archive flag', 'Lifecycle Events', 'Evaluation Members'],
    }, null, 2))
    console.log('Trigger notification composition, rendering, filtering and dedupe tests passed')
  } finally {
    await cleanup()
    client.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
