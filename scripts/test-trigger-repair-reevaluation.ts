import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { deliverNotificationOutboxItem } from '@/lib/server/notification-delivery'
import { upsertGmailDeliveryProfile } from '@/lib/server/notification-delivery-profiles'
import {
  TriggerDailyEvaluationInProgressError,
  runDailyTriggerEvaluations,
} from '@/lib/server/trigger-daily-evaluations'
import { createSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import {
  evaluateSavedTriggerDefinition,
  type TriggerEvaluationDefinitionIdentity,
} from '@/lib/server/trigger-evaluations'
import { getTriggerLifecycleEvents } from '@/lib/server/trigger-lifecycle'
import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'
import { updateTriggerNotificationSettings } from '@/lib/server/trigger-notification-settings'
import type {
  TriggerDiscoveryInput,
  TriggerDiscoveryObservation,
  TriggerDiscoveryResult,
  TriggerDiscoveryRow,
} from '@/lib/server/trigger-discovery-read-model'
import { savedTriggerConfigsFromSearchRequest, type SavedTriggerDefinition } from '@/lib/trigger-definition'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'

const prefix = '__repair_reevaluation__'
const day1 = '2097-03-02'
const day2 = '2097-03-03'
const day3 = '2097-03-04'
const noOriginalDay = '2097-03-05'
const nonterminalDay = '2097-03-06'
const runningRepairDay = '2097-03-09'
const profileId = 'repair-reevaluation-profile'
const repairKey = 'a'.repeat(64)
const otherRepairKey = 'b'.repeat(64)

type Status = TriggerDiscoveryRow['triggerStatus']

function row(date: string, status: Status): TriggerDiscoveryRow {
  const inZone = status === 'IN_ZONE'
  return {
    ticker: '7003', companyName: '三井E&S', market: 'プライム',
    requestedAsOf: date, resolvedAsOf: date, priceDate: date, maDate: date, stageDate: date,
    price: inZone ? 99 : 100, priceStalenessSessions: 0, priceFreshness: 'CURRENT',
    averageVolume: 1_000_000, averageTradingValue: 100_000_000,
    liquidityLookbackSessions: 20, liquidityObservationCount: 20, liquidityComplete: true,
    ma1Period: 20, ma2Period: 25, ma1Value: 99, ma2Value: 98,
    ma1Trend: 'RISING', ma2Trend: 'RISING', ma1SlopePct: 1, ma2SlopePct: 0.8,
    bothRising: true, maSpreadPct: 1.02, maSpreadSlope: 0.1,
    maSpreadExpansionRatio: 0.75, maSpreadExpanding: true,
    bullishMaOrder: true, spreadExpansionAvailable: true,
    zoneUpper: 99, zoneLower: 98,
    zoneDistancePct: inZone ? 0 : 1.01, ma1DistancePct: inZone ? 0 : 1.01,
    ma2DistancePct: inZone ? 1.02 : 2.04, fromAbove: true,
    approachDirection: 'TOWARD_ZONE', approachVelocityPctPointsPerSession: 0.2,
    triggerStatus: status, matched: true, maPath: 'fast', triggerScore: inZone ? 90 : 80,
    scoreBreakdown: {
      proximity: 20, approach: 15, maTrend: 20, stageStructure: 20, liquidity: 10,
      total: inZone ? 90 : 80, stageCoverage: 1, stageAvailableAxes: 6,
      maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
      explanations: { proximity: status, approach: 'toward', maTrend: 'rising', stageStructure: '6/6', liquidity: 'liquid' },
    },
    dayAStage: 1, dayBStage: 2, weekAStage: 1, weekBStage: 2,
    monthAStage: 1, monthBStage: 2, stageAvailable: true, stageComplete: true,
  }
}

function observation(date: string, status: Status): TriggerDiscoveryObservation {
  const current = row(date, status)
  return {
    ticker: current.ticker, disposition: 'FINAL_CANDIDATE', exclusionReason: null,
    triggerStatus: status, pricePosition: status === 'IN_ZONE' ? 'IN_ZONE' : 'ABOVE_ZONE',
    bothRising: true, fromAbove: true, approachDirection: 'TOWARD_ZONE',
    zoneUpper: current.zoneUpper, zoneLower: current.zoneLower,
    zoneDistancePct: current.zoneDistancePct, price: current.price,
    triggerScore: current.triggerScore, priceDate: date, maDate: date, stageDate: date,
    universeFilterPassed: true, priceFilterPassed: true, liquidityFilterPassed: true,
    stageFilterPassed: true, dataAvailable: true,
  }
}

function discoveryResult(date: string, status: Status): TriggerDiscoveryResult {
  return {
    contractVersion: 'trigger-discovery-v1', requestedAsOf: date, resolvedAsOf: date,
    triggerConfig: DEFAULT_MA_ZONE_TRIGGER_CONFIG, liquidityLookbackSessions: 20,
    maxPriceStalenessSessions: 3, totalTriggerMatched: 1, totalMatched: 1,
    rows: [row(date, status)], limit: 10_000, offset: 0, hasMore: false,
    observations: [observation(date, status)],
    diagnostics: {
      counts: { universe: 1, afterMarket: 1, afterStalePrice: 1, currentPrice: 1, staleAccepted: 0, afterPrice: 1, afterVolume: 1, afterTradingValue: 1, evaluated: 1, matched: 1, afterStageFilter: 1, stageRows: 1, stageComplete: 1, stageIncomplete: 0 },
      rejected: { PIT_UNIVERSE: 0, MARKET_FILTER: 0, PRICE_FILTER: 0, VOLUME_FILTER: 0, TRADING_VALUE_FILTER: 0, STALE_PRICE: 0, INSUFFICIENT_HISTORY: 0, MA_NOT_BOTH_RISING: 0, MA_SPREAD_NOT_EXPANDING: 0, NOT_FROM_ABOVE: 0, NOT_APPROACHING: 0, TOO_FAR: 0 },
      performance: { queryCount: 4, dbQueryMs: 1, maPreparationMs: 0, engineEvaluationMs: 0, stageJoinMs: 0, scoreCalculationMs: 0, totalMs: 1, fastPathEvaluated: 1, genericPathEvaluated: 0 },
    },
  }
}

// The Provider-visible market state per date. Day 2 is "repaired" between the
// original DAILY batch and the repair batch, as a local OHLCV repair would.
const marketState = new Map<string, Status>([
  [day1, 'NEAR'], [day2, 'NEAR'], [day3, 'IN_ZONE'],
  [noOriginalDay, 'NEAR'], [nonterminalDay, 'NEAR'], [runningRepairDay, 'NEAR'],
])

function evaluationDependencies(definitions: SavedTriggerDefinition[]) {
  return {
    resolveDataDate: async (requestedAsOf?: string) => requestedAsOf ?? null,
    listDefinitions: async () => definitions,
    evaluateDefinition: (
      definitionId: string,
      asOf: string,
      expectedDefinitionIdentity: TriggerEvaluationDefinitionIdentity,
      key?: string,
    ) => evaluateSavedTriggerDefinition(definitionId, asOf, {
      expectedDefinitionIdentity,
      repairKey: key,
      resolveAsOf: async (date) => date,
      discover: async (input: TriggerDiscoveryInput) => discoveryResult(input.asOf, marketState.get(input.asOf)!),
    }),
  }
}

async function cleanup(): Promise<void> {
  const dates = [day1, day2, day3, noOriginalDay, nonterminalDay, runningRepairDay]
  const placeholders = dates.map(() => '?').join(',')
  const batchFilter = `SELECT id FROM trigger_evaluation_batches WHERE resolved_as_of IN (${placeholders})`
  await execRun(`DELETE FROM notification_delivery_attempts WHERE outbox_id IN (
    SELECT id FROM notification_outbox WHERE batch_id IN (${batchFilter}))`, dates)
  await execRun('DELETE FROM notification_delivery_profiles WHERE id=?', [profileId])
  await execRun(`DELETE FROM trigger_notification_composition_runs WHERE batch_id IN (${batchFilter})`, dates)
  await execRun(`DELETE FROM notification_outbox WHERE batch_id IN (${batchFilter})`, dates)
  await execRun(`DELETE FROM trigger_evaluation_batch_items WHERE batch_id IN (${batchFilter})`, dates)
  await execRun(`DELETE FROM trigger_evaluation_batches WHERE resolved_as_of IN (${placeholders})`, dates)
  const definitions = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
  for (const definition of definitions) {
    await execRun('DELETE FROM trigger_lifecycle_events WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_observations WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_notification_settings WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [definition.id])
  }
}

async function rowsSha256(sql: string, args: string[]): Promise<string> {
  const rows = await execAll<Record<string, unknown>>(sql, args)
  // The supersession pointer is the only column a repair may set on originals.
  for (const item of rows) delete item.superseded_by_evaluation_id
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

async function preservedOriginalState(batchId: string): Promise<string> {
  return [
    await rowsSha256('SELECT * FROM trigger_evaluation_batches WHERE id=?', [batchId]),
    await rowsSha256('SELECT * FROM trigger_evaluation_batch_items WHERE batch_id=? ORDER BY definition_id', [batchId]),
    await rowsSha256(`SELECT evaluations.* FROM trigger_evaluations evaluations
      JOIN trigger_evaluation_batch_items items ON items.evaluation_id=evaluations.id
      WHERE items.batch_id=? ORDER BY evaluations.id`, [batchId]),
    await rowsSha256(`SELECT members.* FROM trigger_evaluation_members members
      JOIN trigger_evaluation_batch_items items ON items.evaluation_id=members.evaluation_id
      WHERE items.batch_id=? ORDER BY members.evaluation_id, members.ticker`, [batchId]),
    await rowsSha256(`SELECT events.* FROM trigger_lifecycle_events events
      JOIN trigger_evaluation_batch_items items ON items.evaluation_id=events.current_evaluation_id
      WHERE items.batch_id=? ORDER BY events.id`, [batchId]),
    await rowsSha256('SELECT * FROM notification_outbox WHERE batch_id=? ORDER BY id', [batchId]),
  ].join(':')
}

async function main(): Promise<void> {
  await cleanup()
  try {
    const configs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-09-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
    })
    const definition = await createSavedTriggerDefinition({ name: `${prefix}alerts`, ...configs })
    await updateTriggerNotificationSettings(definition.id, {
      dailyDigestEnabled: true, lifecycleAlertEnabled: true, maxCandidatesInDigest: 10,
    })
    const dependencies = evaluationDependencies([definition])

    await assert.rejects(
      () => runDailyTriggerEvaluations({ requestedAsOf: day2, repairKey: 'not-a-hash' }, dependencies),
      /trigger_repair_key_must_be_sha256_hex/,
    )

    // A repair requires exactly one terminal original DAILY batch.
    await assert.rejects(
      () => runDailyTriggerEvaluations({ requestedAsOf: noOriginalDay, repairKey }, dependencies),
      /trigger_repair_original_batch_not_terminal/,
    )
    await execRun(`INSERT INTO trigger_evaluation_batches (
      id, source, requested_as_of, resolved_as_of, status
    ) VALUES (?, 'DAILY', ?, ?, 'FAILED')`, [randomUUID(), nonterminalDay, nonterminalDay])
    for (const status of ['FAILED', 'RUNNING']) {
      await execRun("UPDATE trigger_evaluation_batches SET status=? WHERE source='DAILY' AND resolved_as_of=?",
        [status, nonterminalDay])
      await assert.rejects(
        () => runDailyTriggerEvaluations({ requestedAsOf: nonterminalDay, repairKey }, dependencies),
        /trigger_repair_original_batch_not_terminal/,
      )
    }
    const nonterminalRepairs = await execGet<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trigger_evaluation_batches
       WHERE source='DAILY_REPAIR' AND resolved_as_of IN (?, ?)`, [noOriginalDay, nonterminalDay],
    )
    assert.equal(Number(nonterminalRepairs?.count), 0)

    // Normal path: unchanged DAILY behaviour, notifications are composed.
    const first = await runDailyTriggerEvaluations({ requestedAsOf: day1 }, dependencies)
    assert.equal(first.batch?.source, 'DAILY')
    assert.equal(first.batch?.repairKey, null)
    const original = await runDailyTriggerEvaluations({ requestedAsOf: day2 }, dependencies)
    assert.equal(original.batch?.status, 'COMPLETED')
    const originalEvaluationId = original.items[0]!.evaluationId!
    const originalNotifications = await composeTriggerNotificationsForBatch({ batchId: original.batch!.id })
    assert.ok(originalNotifications.createdCount > 0, 'the normal DAILY path still composes notifications')
    const originalState = await preservedOriginalState(original.batch!.id)

    // The local repair changes Day 2 after its DAILY batch already completed.
    marketState.set(day2, 'IN_ZONE')
    const normalRerun = await runDailyTriggerEvaluations({ requestedAsOf: day2 }, dependencies)
    assert.equal(normalRerun.reusedBatch, true, 'a normal rerun keeps the completed DAILY batch')
    assert.equal(normalRerun.batch?.id, original.batch!.id)

    const repaired = await runDailyTriggerEvaluations({ requestedAsOf: day2, repairKey }, dependencies)
    assert.equal(repaired.reusedBatch, false)
    assert.equal(repaired.batch?.source, 'DAILY_REPAIR')
    assert.equal(repaired.batch?.status, 'COMPLETED')
    assert.equal(repaired.batch?.repairKey, repairKey)
    assert.equal(repaired.batch?.supersedesBatchId, original.batch!.id)
    const repairedEvaluationId = repaired.items[0]!.evaluationId!
    assert.notEqual(repairedEvaluationId, originalEvaluationId, 'repair creates a new evaluation')
    const repairedMembers = await execAll<{ trigger_status: string }>(
      'SELECT trigger_status FROM trigger_evaluation_members WHERE evaluation_id=?',
      [repairedEvaluationId],
    )
    assert.deepEqual(repairedMembers.map((item) => item.trigger_status), ['IN_ZONE'])
    const supersession = await execGet<{ superseded_by_evaluation_id: string | null }>(
      'SELECT superseded_by_evaluation_id FROM trigger_evaluations WHERE id=?',
      [originalEvaluationId],
    )
    assert.equal(supersession?.superseded_by_evaluation_id, repairedEvaluationId)
    assert.equal(await preservedOriginalState(original.batch!.id), originalState,
      'original batch, items, evaluations (except supersession pointer), members, events, and outbox stay identical')

    // After a repair, a normal run resolves to the repair batch.
    const normalAfterRepair = await runDailyTriggerEvaluations({ requestedAsOf: day2 }, dependencies)
    assert.equal(normalAfterRepair.reusedBatch, true)
    assert.equal(normalAfterRepair.batch?.id, repaired.batch!.id)

    // The superseded original no longer composes, and its outbox is never sent.
    const originalSuppressed = await composeTriggerNotificationsForBatch({ batchId: original.batch!.id })
    assert.equal(originalSuppressed.createdCount, 0)
    assert.deepEqual(originalSuppressed.notifications, [])
    const originalRuns = await execAll<{ error_category: string | null }>(
      `SELECT error_category FROM trigger_notification_composition_runs
       WHERE batch_id=? AND status='SUPPRESSED'`, [original.batch!.id],
    )
    assert.deepEqual(originalRuns.map((run) => run.error_category), ['superseded_by_repair'])
    await upsertGmailDeliveryProfile({
      id: profileId, recipientEmail: 'repair-fixture@example.test',
      baseUrl: 'https://stockboard.example.test', enabled: true,
    })
    const adapterFactoryCalls = { value: 0 }
    const adapterCalls = { value: 0 }
    const delivered = await deliverNotificationOutboxItem({
      outboxId: originalNotifications.notifications[0]!.id, profileId,
    }, {
      adapterFactory: () => {
        adapterFactoryCalls.value += 1
        return {
          provider: 'GMAIL',
          deliver: async () => { adapterCalls.value += 1; throw new Error('superseded outbox must not be sent') },
        }
      },
    })
    assert.equal(delivered.disposition, 'NOT_CLAIMED')
    assert.equal(delivered.status, 'PENDING')
    assert.equal(adapterFactoryCalls.value, 0)
    assert.equal(adapterCalls.value, 0)
    assert.equal(await preservedOriginalState(original.batch!.id), originalState,
      'suppressed composition and refused delivery leave the original outbox unchanged')

    // Repair-induced differences are never delivered, and every attempt is recorded.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const suppressed = await composeTriggerNotificationsForBatch({ batchId: repaired.batch!.id })
      assert.equal(suppressed.createdCount, 0)
      assert.deepEqual(suppressed.notifications, [])
      type CompositionRun = { status: string; error_category: string }
      const runs: CompositionRun[] = await execAll<CompositionRun>(
        'SELECT status, error_category FROM trigger_notification_composition_runs WHERE batch_id=?',
        [repaired.batch!.id],
      )
      assert.equal(runs.length, attempt)
      assert.ok(runs.every((run: CompositionRun) => run.status === 'SUPPRESSED'
        && run.error_category === 'repair_reevaluation_suppressed'))
    }
    const repairOutbox = await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_outbox WHERE batch_id=?',
      [repaired.batch!.id],
    )
    assert.equal(Number(repairOutbox?.count), 0)

    // Idempotent rerun of the same repair; a different repair is rejected.
    const evaluationCount = async () => Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_evaluations WHERE definition_id=?', [definition.id],
    ))?.count)
    const before = await evaluationCount()
    const rerun = await runDailyTriggerEvaluations({ requestedAsOf: day2, repairKey }, dependencies)
    assert.equal(rerun.reusedBatch, true)
    assert.equal(rerun.batch?.id, repaired.batch!.id)
    assert.equal(await evaluationCount(), before)
    await assert.rejects(
      () => runDailyTriggerEvaluations({ requestedAsOf: day2, repairKey: otherRepairKey }, dependencies),
      /trigger_repair_batch_conflict/,
    )

    // Manual/normal evaluation of the repaired date resolves to the repair.
    const manual = await evaluateSavedTriggerDefinition(definition.id, day2, {
      resolveAsOf: async (date) => date,
      discover: async () => { throw new Error('completed evaluation must be reused') },
    })
    assert.equal(manual.reused, true)
    assert.equal(manual.evaluation.id, repairedEvaluationId)

    // Next business day: the repaired evaluation is the lifecycle baseline.
    // Against the stale original (NEAR) this would be STATUS_CHANGED to IN_ZONE.
    const next = await runDailyTriggerEvaluations({ requestedAsOf: day3 }, dependencies)
    assert.equal(next.batch?.source, 'DAILY')
    const nextLifecycle = await getTriggerLifecycleEvents(next.items[0]!.evaluationId!)
    assert.equal(nextLifecycle.previousEvaluationId, repairedEvaluationId)
    assert.equal(nextLifecycle.eventCount, 0, 'no lifecycle event against the repaired baseline')
    assert.equal(next.items[0]!.lifecycleEventCount, 0)
    const nextNotifications = await composeTriggerNotificationsForBatch({ batchId: next.batch!.id })
    assert.equal(nextNotifications.notifications.some((item) => item.notificationType === 'LIFECYCLE_ALERT'), false)
    assert.ok(nextNotifications.notifications.some((item) => item.notificationType === 'DAILY_DIGEST'))

    // A RUNNING repair blocks normal runs and suppresses both batches.
    const runningOriginal = await runDailyTriggerEvaluations({ requestedAsOf: runningRepairDay }, dependencies)
    assert.equal(runningOriginal.batch?.status, 'COMPLETED')
    const runningOriginalState = await preservedOriginalState(runningOriginal.batch!.id)
    const runningRepairId = randomUUID()
    await execRun(`INSERT INTO trigger_evaluation_batches (
      id, source, requested_as_of, resolved_as_of, status, owner_token, repair_key, supersedes_batch_id
    ) VALUES (?, 'DAILY_REPAIR', ?, ?, 'RUNNING', 'other-owner', ?, ?)`, [
      runningRepairId, runningRepairDay, runningRepairDay, repairKey, runningOriginal.batch!.id,
    ])
    await assert.rejects(
      () => runDailyTriggerEvaluations({ requestedAsOf: runningRepairDay }, dependencies),
      TriggerDailyEvaluationInProgressError,
    )
    for (const batchId of [runningOriginal.batch!.id, runningRepairId]) {
      const result = await composeTriggerNotificationsForBatch({ batchId })
      assert.equal(result.createdCount, 0)
    }
    await execRun("UPDATE trigger_evaluation_batches SET status='FAILED' WHERE id=?", [runningRepairId])
    await assert.rejects(
      () => runDailyTriggerEvaluations({ requestedAsOf: runningRepairDay }, dependencies),
      /trigger_repair_batch_not_completed/,
    )
    assert.equal(await preservedOriginalState(runningOriginal.batch!.id), runningOriginalState)
    console.log('Trigger repair re-evaluation tests: PASS')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
