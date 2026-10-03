import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  TriggerDailyEvaluationInProgressError,
  runDailyTriggerEvaluations,
} from '@/lib/server/trigger-daily-evaluations'
import {
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  listSavedTriggerDefinitions,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import {
  evaluateSavedTriggerDefinition,
  type TriggerEvaluationDefinitionIdentity,
} from '@/lib/server/trigger-evaluations'
import type {
  TriggerDiscoveryInput,
  TriggerDiscoveryObservation,
  TriggerDiscoveryResult,
  TriggerDiscoveryRow,
} from '@/lib/server/trigger-discovery-read-model'
import type { SavedTriggerDefinition } from '@/lib/trigger-definition'
import { savedTriggerConfigsFromSearchRequest } from '@/lib/trigger-definition'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import { TRIGGER_EVALUATION_CONTRACT_VERSION, type TriggerEvaluationRunResponse } from '@/lib/trigger-evaluation'

const prefix = '__phase8b2_daily__'
const datePrefix = '2098-11-'

async function cleanup(): Promise<void> {
  const definitions = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
  await execRun(`DELETE FROM trigger_evaluation_batch_items
    WHERE batch_id IN (SELECT id FROM trigger_evaluation_batches WHERE resolved_as_of LIKE ?)`, [`${datePrefix}%`])
  await execRun('DELETE FROM trigger_evaluation_batches WHERE resolved_as_of LIKE ?', [`${datePrefix}%`])
  for (const definition of definitions) {
    await execRun('DELETE FROM trigger_lifecycle_events WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_observations WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [definition.id])
  }
}

async function createDefinition(
  name: string,
  ma1Period = 20,
  ma2Period = 25,
  timeframe: SavedTriggerDefinition['evaluationConfig']['timeframe'] = 'MONTHLY',
): Promise<SavedTriggerDefinition> {
  const configs = savedTriggerConfigsFromSearchRequest({ requestedAsOf: '2026-09-10', timeframe, ma1Period, ma2Period })
  return createSavedTriggerDefinition({ name: `${prefix}${name}`, ...configs })
}

function fakeResponse(
  definition: SavedTriggerDefinition,
  resolvedAsOf: string,
  options: { reused?: boolean; lifecycleEvents?: number } = {},
): TriggerEvaluationRunResponse {
  const now = new Date().toISOString()
  return {
    contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
    reused: options.reused ?? false,
    evaluation: {
      id: randomUUID(),
      definitionId: definition.id,
      evaluationVersion: definition.evaluationVersion,
      engineVersion: definition.engineVersion,
      scoreVersion: definition.scoreVersion,
      runSignature: 'x'.repeat(64),
      evaluationConfigSignature: definition.evaluationSignature,
      evaluationConfigSnapshot: definition.evaluationConfig,
      requestedAsOf: resolvedAsOf,
      resolvedAsOf,
      startedAt: now,
      completedAt: now,
      status: 'COMPLETED',
      counts: { pitUniverse: 1, currentPrice: 1, staleAccepted: 0, triggerEvaluated: 1, triggerMatched: 1, finalMatched: 1 },
      performance: { totalMs: 1, discoveryMs: 1, snapshotTransformMs: 0, persistenceMs: 0, discoveryQueryCount: 1, discoveryDbQueryMs: 1 },
      attemptCount: 1,
      errorCategory: null,
      createdAt: now,
    },
    lifecycle: {
      baseline: (options.lifecycleEvents ?? 0) === 0,
      previousEvaluationId: options.lifecycleEvents ? randomUUID() : null,
      currentEvaluationId: randomUUID(),
      eventCount: options.lifecycleEvents ?? 0,
      eventCounts: options.lifecycleEvents ? { STATUS_CHANGED: options.lifecycleEvents } : {},
    },
  }
}

function row(date: string, status: TriggerDiscoveryRow['triggerStatus']): TriggerDiscoveryRow {
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

function observation(date: string, status: TriggerDiscoveryRow['triggerStatus']): TriggerDiscoveryObservation {
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

function discoveryResult(
  date: string,
  status: TriggerDiscoveryRow['triggerStatus'],
  includeObservation: boolean,
): TriggerDiscoveryResult {
  const current = row(date, status)
  return {
    contractVersion: 'trigger-discovery-v1', requestedAsOf: date, resolvedAsOf: date,
    triggerConfig: DEFAULT_MA_ZONE_TRIGGER_CONFIG, liquidityLookbackSessions: 20,
    maxPriceStalenessSessions: 3, totalTriggerMatched: 1, totalMatched: 1,
    rows: [current], limit: 10_000, offset: 0, hasMore: false,
    observations: includeObservation ? [observation(date, status)] : [],
    diagnostics: {
      counts: { universe: 1, afterMarket: 1, afterStalePrice: 1, currentPrice: 1, staleAccepted: 0, afterPrice: 1, afterVolume: 1, afterTradingValue: 1, evaluated: 1, matched: 1, afterStageFilter: 1, stageRows: 1, stageComplete: 1, stageIncomplete: 0 },
      rejected: { PIT_UNIVERSE: 0, MARKET_FILTER: 0, PRICE_FILTER: 0, VOLUME_FILTER: 0, TRADING_VALUE_FILTER: 0, STALE_PRICE: 0, INSUFFICIENT_HISTORY: 0, MA_NOT_BOTH_RISING: 0, MA_SPREAD_NOT_EXPANDING: 0, NOT_FROM_ABOVE: 0, NOT_APPROACHING: 0, TOO_FAR: 0 },
      performance: { queryCount: 4, dbQueryMs: 1, maPreparationMs: 0, engineEvaluationMs: 0, stageJoinMs: 0, scoreCalculationMs: 0, totalMs: 1, fastPathEvaluated: 1, genericPathEvaluated: 0 },
    },
  }
}

function only(definitions: SavedTriggerDefinition[]) {
  return async () => definitions
}

async function main(): Promise<void> {
  await cleanup()
  try {
    const noDefinition = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}01` },
      { resolveDataDate: async () => `${datePrefix}01`, listDefinitions: async () => [] },
    )
    assert.equal(noDefinition.batch?.status, 'COMPLETED')
    assert.equal(noDefinition.batch?.definitionCount, 0)
    assert.equal(noDefinition.batch?.evaluationCount, 0)
    assert.equal(noDefinition.batch?.lifecycleEventCount, 0)

    const definitions = [
      await createDefinition('multi-a', 20, 25),
      await createDefinition('multi-b', 10, 20, 'BIWEEKLY'),
      await createDefinition('multi-c', 20, 50),
    ]
    const archived = await createDefinition('archived')
    await archiveSavedTriggerDefinition(archived.id)
    const activeFromRepository = (await listSavedTriggerDefinitions())
      .filter((definition) => definition.name.startsWith(prefix))
    assert.equal(activeFromRepository.some((definition) => definition.id === archived.id), false)

    const sequence: string[] = []
    let evaluateCalls = 0
    const multiple = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}02` },
      {
        resolveDataDate: async () => `${datePrefix}02`,
        listDefinitions: only(definitions),
        evaluateDefinition: async (id) => {
          evaluateCalls += 1
          sequence.push(id)
          const definition = definitions.find((item) => item.id === id)!
          return fakeResponse(definition, `${datePrefix}02`)
        },
      },
    )
    assert.equal(multiple.batch?.status, 'COMPLETED')
    assert.deepEqual(sequence, definitions.map((definition) => definition.id).sort(), 'batch items execute sequentially in stable order')
    assert.equal(multiple.batch?.completedCount, 3)
    assert.equal(multiple.batch?.evaluationCount, 3)
    assert.equal(multiple.items.some((item) => item.definitionId === archived.id), false)

    const dailyMonthly = await createDefinition('daily-monthly', 20, 25, 'MONTHLY')
    const dailyBiweekly = await createDefinition('daily-biweekly', 20, 25, 'BIWEEKLY')
    const dailySafetyCalls: string[] = []
    const dailySafety = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}15` },
      {
        resolveDataDate: async () => `${datePrefix}15`,
        listDefinitions: only([dailyMonthly, dailyBiweekly]),
        evaluateDefinition: async (id) => {
          dailySafetyCalls.push(id)
          return fakeResponse(
            [dailyMonthly, dailyBiweekly].find((definition) => definition.id === id)!,
            `${datePrefix}15`,
          )
        },
      },
    )
    assert.deepEqual(
      dailySafetyCalls,
      [dailyMonthly.id, dailyBiweekly.id].sort(),
      'Daily Automatic Evaluation must execute Monthly and Biweekly sequentially',
    )
    assert.equal(dailySafety.items.find((item) => item.definitionId === dailyMonthly.id)?.status, 'COMPLETED')
    assert.equal(dailySafety.items.find((item) => item.definitionId === dailyBiweekly.id)?.status, 'COMPLETED')
    assert.equal(dailySafety.batch?.evaluationCount, 2)
    assert.equal(dailySafety.batch?.skippedCount, 0)
    assert.ok(dailySafety.items.find((item) => item.definitionId === dailyBiweekly.id)?.evaluationId)
    assert.notEqual(
      dailyMonthly.evaluationSignature,
      dailyBiweekly.evaluationSignature,
      'same MA periods remain isolated by timeframe signature',
    )

    await execRun(`UPDATE trigger_evaluation_batch_items SET
      evaluation_id=NULL, status='SKIPPED_UNSUPPORTED_TIMEFRAME',
      error_category='unsupported_timeframe'
      WHERE batch_id=? AND definition_id=?`, [dailySafety.batch!.id, dailyBiweekly.id])
    await execRun(`UPDATE trigger_evaluation_batches SET
      completed_count=1, skipped_count=1, evaluation_count=1
      WHERE id=?`, [dailySafety.batch!.id])
    const historicalSkipped = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}15` },
      {
        resolveDataDate: async () => `${datePrefix}15`,
        listDefinitions: only([dailyMonthly, dailyBiweekly]),
        evaluateDefinition: async () => { throw new Error('completed historical batch must remain immutable') },
      },
    )
    assert.equal(historicalSkipped.reusedBatch, true)
    assert.equal(
      historicalSkipped.items.find((item) => item.definitionId === dailyBiweekly.id)?.status,
      'SKIPPED_UNSUPPORTED_TIMEFRAME',
      'an existing completed skip remains an immutable audit record',
    )

    const duplicate = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}02` },
      {
        resolveDataDate: async () => `${datePrefix}02`,
        listDefinitions: only([...definitions, await createDefinition('same-day-new')]),
        evaluateDefinition: async () => { throw new Error('completed batch must not evaluate again') },
      },
    )
    assert.equal(duplicate.reusedBatch, true)
    assert.equal(duplicate.batch?.id, multiple.batch?.id)
    assert.equal(duplicate.batch?.definitionCount, 3, 'same-day definitions are frozen at first batch start')
    assert.equal(evaluateCalls, 3)

    const failureOrder: string[] = []
    const failure = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}03` },
      {
        resolveDataDate: async () => `${datePrefix}03`, listDefinitions: only(definitions),
        evaluateDefinition: async (id) => {
          failureOrder.push(id)
          if (id === definitions[1].id) throw new Error('synthetic definition failure')
          return fakeResponse(definitions.find((item) => item.id === id)!, `${datePrefix}03`)
        },
      },
    )
    assert.equal(failure.batch?.status, 'COMPLETED_WITH_ERRORS')
    assert.equal(failure.batch?.failedCount, 1)
    assert.equal(failure.batch?.completedCount, 2)
    assert.equal(failureOrder.length, 3, 'a failed definition must not stop later definitions')

    let changed = await createDefinition('changed-mid-run')
    let changedEvaluateCalls = 0
    const changedBatch = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}04` },
      {
        resolveDataDate: async () => `${datePrefix}04`, listDefinitions: only([changed]),
        beforeDefinition: async () => {
          const config = structuredClone(changed.evaluationConfig)
          config.triggerCore.ma2Period = 50
          changed = await updateSavedTriggerDefinition(changed.id, { evaluationConfig: config })
        },
        evaluateDefinition: async () => {
          changedEvaluateCalls += 1
          return fakeResponse(changed, `${datePrefix}04`)
        },
      },
    )
    assert.equal(changedEvaluateCalls, 0)
    assert.equal(changedBatch.items[0].status, 'SKIPPED_CHANGED')

    const archivedMidRun = await createDefinition('archived-mid-run')
    let archivedEvaluateCalls = 0
    const archivedBatch = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}12` },
      {
        resolveDataDate: async () => `${datePrefix}12`, listDefinitions: only([archivedMidRun]),
        beforeDefinition: async () => archiveSavedTriggerDefinition(archivedMidRun.id),
        evaluateDefinition: async () => {
          archivedEvaluateCalls += 1
          return fakeResponse(archivedMidRun, `${datePrefix}12`)
        },
      },
    )
    assert.equal(archivedEvaluateCalls, 0)
    assert.equal(archivedBatch.items[0].status, 'SKIPPED_ARCHIVED')

    const weekendDefinition = await createDefinition('weekend', 20, 25, 'BIWEEKLY')
    let weekendCalls = 0
    const friday = `${datePrefix}05`
    const saturday = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}06` },
      {
        resolveDataDate: async () => friday, listDefinitions: only([weekendDefinition]),
        evaluateDefinition: async () => {
          weekendCalls += 1
          return fakeResponse(weekendDefinition, friday)
        },
      },
    )
    const sunday = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}07` },
      {
        resolveDataDate: async () => friday, listDefinitions: only([weekendDefinition]),
        evaluateDefinition: async () => { throw new Error('weekend rerun must reuse Friday') },
      },
    )
    assert.equal(saturday.resolvedAsOf, friday)
    assert.equal(sunday.reusedBatch, true)
    assert.equal(sunday.batch?.id, saturday.batch?.id)
    assert.equal(weekendCalls, 1)

    const lifecycleDefinition = await createDefinition('lifecycle', 20, 25, 'BIWEEKLY')
    const lifecycleRunner = (status: TriggerDiscoveryRow['triggerStatus']) => async (
      definitionId: string,
      requestedAsOf: string,
      expectedIdentity: TriggerEvaluationDefinitionIdentity,
    ) => evaluateSavedTriggerDefinition(definitionId, requestedAsOf, {
      expectedDefinitionIdentity: expectedIdentity,
      resolveAsOf: async (date) => date,
      discover: async (input: TriggerDiscoveryInput, options) => {
        assert.equal(options?.timeframe, 'BIWEEKLY', 'Daily lifecycle and current observation must use Biweekly')
        return discoveryResult(input.asOf, status, (input.observeTickers?.length ?? 0) > 0)
      },
    })
    const baseline = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}08` },
      { resolveDataDate: async () => `${datePrefix}08`, listDefinitions: only([lifecycleDefinition]), evaluateDefinition: lifecycleRunner('APPROACHING') },
    )
    assert.equal(baseline.items[0].lifecycleEventCount, 0)
    const baselineSnapshot = await execGet<{ evaluation_config_snapshot_json: string }>(
      'SELECT evaluation_config_snapshot_json FROM trigger_evaluations WHERE id=?',
      [baseline.items[0].evaluationId!],
    )
    assert.equal(JSON.parse(baselineSnapshot!.evaluation_config_snapshot_json).timeframe, 'BIWEEKLY')
    assert.equal(Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_lifecycle_events WHERE current_evaluation_id=?',
      [baseline.items[0].evaluationId!],
    ))?.count), 0, 'first Biweekly Daily Evaluation is a baseline without Lifecycle Events')
    const lifecycle = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}09` },
      { resolveDataDate: async () => `${datePrefix}09`, listDefinitions: only([lifecycleDefinition]), evaluateDefinition: lifecycleRunner('NEAR') },
    )
    assert.equal(lifecycle.items[0].lifecycleEventCount, 1)
    const event = await execGet<{ event_type: string }>(
      'SELECT event_type FROM trigger_lifecycle_events WHERE current_evaluation_id=?',
      [lifecycle.items[0].evaluationId!],
    )
    assert.equal(event?.event_type, 'STATUS_CHANGED')
    const inZone = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}13` },
      { resolveDataDate: async () => `${datePrefix}13`, listDefinitions: only([lifecycleDefinition]), evaluateDefinition: lifecycleRunner('IN_ZONE') },
    )
    assert.equal(inZone.items[0].lifecycleEventCount, 1)
    const inZoneEvent = await execGet<{ event_type: string; current_trigger_status: string }>(
      'SELECT event_type, current_trigger_status FROM trigger_lifecycle_events WHERE current_evaluation_id=?',
      [inZone.items[0].evaluationId!],
    )
    assert.deepEqual(inZoneEvent, { event_type: 'STATUS_CHANGED', current_trigger_status: 'IN_ZONE' })

    const reusedDefinition = await createDefinition('reused-item', 20, 25, 'BIWEEKLY')
    const reusedDate = `${datePrefix}14`
    const reusedEvaluationDependencies = {
      resolveAsOf: async (date: string) => date,
      discover: async (input: TriggerDiscoveryInput, options?: { timeframe?: string }) => {
        assert.equal(options?.timeframe, 'BIWEEKLY')
        return discoveryResult(input.asOf, 'NEAR', (input.observeTickers?.length ?? 0) > 0)
      },
    }
    const manualEvaluation = await evaluateSavedTriggerDefinition(
      reusedDefinition.id,
      reusedDate,
      reusedEvaluationDependencies,
    )
    const reusedItem = await runDailyTriggerEvaluations(
      { requestedAsOf: reusedDate },
      {
        resolveDataDate: async () => reusedDate,
        listDefinitions: only([reusedDefinition]),
        evaluateDefinition: (definitionId, requestedAsOf, expectedIdentity) => (
          evaluateSavedTriggerDefinition(definitionId, requestedAsOf, {
            ...reusedEvaluationDependencies,
            expectedDefinitionIdentity: expectedIdentity,
          })
        ),
      },
    )
    assert.equal(reusedItem.items[0].status, 'REUSED')
    assert.equal(reusedItem.items[0].evaluationId, manualEvaluation.evaluation.id)
    assert.equal(reusedItem.batch?.reusedCount, 1)
    assert.equal(reusedItem.batch?.evaluationCount, 1)
    assert.equal(Number((await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_evaluations WHERE definition_id=? AND resolved_as_of=?',
      [reusedDefinition.id, reusedDate],
    ))?.count), 1, 'same-day Manual and Daily runs share one immutable Evaluation')

    const concurrencyDefinition = await createDefinition('concurrency')
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    const firstRun = runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}10` },
      {
        resolveDataDate: async () => `${datePrefix}10`, listDefinitions: only([concurrencyDefinition]),
        evaluateDefinition: async () => {
          entered()
          await releasePromise
          return fakeResponse(concurrencyDefinition, `${datePrefix}10`)
        },
      },
    )
    await enteredPromise
    await assert.rejects(() => runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}10` },
      { resolveDataDate: async () => `${datePrefix}10`, listDefinitions: only([concurrencyDefinition]) },
    ), TriggerDailyEvaluationInProgressError)
    release()
    await firstRun

    const dryRunDefinition = await createDefinition('dry-run', 20, 25, 'BIWEEKLY')
    const beforeDry = await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_evaluation_batches WHERE resolved_as_of=?',
      [`${datePrefix}11`],
    )
    const dry = await runDailyTriggerEvaluations(
      { requestedAsOf: `${datePrefix}11`, dryRun: true },
      { resolveDataDate: async () => `${datePrefix}11`, listDefinitions: only([dryRunDefinition]) },
    )
    const afterDry = await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_evaluation_batches WHERE resolved_as_of=?',
      [`${datePrefix}11`],
    )
    assert.equal(dry.dryRun, true)
    assert.equal(dry.items.length, 1)
    assert.equal(dry.items[0].status, 'PENDING')
    assert.equal(Number(beforeDry?.count), Number(afterDry?.count), 'dry run must not persist a batch')

    const pipelineSource = await readFile('scripts/refresh-after-ohlcv.ts', 'utf8')
    const freshnessGate = pipelineSource.indexOf("throw new Error('Post-OHLCV refresh did not complete snapshot/feature/cache freshness')")
    const triggerStart = pipelineSource.indexOf('runDailyTriggerEvaluations({')
    const pipelineSuccess = pipelineSource.indexOf("status: 'success'", triggerStart)
    assert.ok(freshnessGate >= 0 && triggerStart > freshnessGate, 'Trigger daily evaluation must follow the upstream freshness gate')
    assert.ok(pipelineSuccess > triggerStart, 'post-OHLCV success must be recorded only after Trigger daily evaluation')

    const tables = await execAll<{ name: string }>(`
      SELECT name FROM sqlite_master WHERE type IN ('table','index')
      AND name LIKE 'trigger_evaluation_batch%' ORDER BY name
    `)
    assert.deepEqual(tables.map((item) => item.name), [
      'trigger_evaluation_batch_items',
      'trigger_evaluation_batch_items_status_idx',
      'trigger_evaluation_batches',
      'trigger_evaluation_batches_source_date_idx',
      'trigger_evaluation_batches_status_idx',
    ])

    console.log(JSON.stringify({
      noDefinition: noDefinition.batch,
      multiple: multiple.batch,
      failureIsolation: failure.batch,
      changedMidRun: changedBatch.items[0],
      archivedMidRun: archivedBatch.items[0],
      weekend: { first: saturday.batch?.id, reused: sunday.reusedBatch },
      lifecycle: lifecycle.batch,
      inZoneLifecycle: inZone.batch,
      reusedEvaluation: reusedItem.batch,
      concurrencyGuard: true,
      dryRunPersisted: false,
      pipelineOrderVerified: true,
      biweeklyDailySafety: dailySafety.batch,
    }, null, 2))
    console.log('Trigger daily evaluation batching, idempotency, isolation, lifecycle, and pipeline tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
