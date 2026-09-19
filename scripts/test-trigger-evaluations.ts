import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execAll, execGet, execRun } from '@/lib/db/client'
import type { TriggerDiscoveryResult, TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import {
  evaluateSavedTriggerDefinition,
  getTriggerEvaluationDetail,
  listSavedTriggerEvaluations,
} from '@/lib/server/trigger-evaluations'
import {
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import { savedTriggerConfigsFromSearchRequest } from '@/lib/trigger-definition'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'

const prefix = '__phase8a_trigger_evaluation__'

async function cleanup() {
  const definitions = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
  for (const definition of definitions) {
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [definition.id])
  }
}

function sampleRow(ma2Period = 25): TriggerDiscoveryRow {
  return {
    ticker: '7003', companyName: '三井E&S', market: 'プライム',
    requestedAsOf: '2026-09-12', resolvedAsOf: '2026-09-11',
    priceDate: '2026-09-11', maDate: '2026-09-11', stageDate: '2026-09-11',
    price: 5100, priceStalenessSessions: 0, priceFreshness: 'CURRENT',
    averageVolume: 1_200_000, averageTradingValue: 6_120_000_000,
    liquidityLookbackSessions: 20, liquidityObservationCount: 20, liquidityComplete: true,
    ma1Period: 20, ma2Period, ma1Value: 5000, ma2Value: 4900,
    ma1Trend: 'RISING', ma2Trend: 'RISING', ma1SlopePct: 0.8, ma2SlopePct: 0.5,
    bothRising: true, maSpreadPct: 2.041, maSpreadSlope: 0.2,
    maSpreadExpansionRatio: 0.75, maSpreadExpanding: true,
    bullishMaOrder: true, spreadExpansionAvailable: true,
    zoneUpper: 5000, zoneLower: 4900,
    zoneDistancePct: 2, ma1DistancePct: 2, ma2DistancePct: 4.081,
    fromAbove: true, approachDirection: 'TOWARD_ZONE',
    approachVelocityPctPointsPerSession: 0.2, triggerStatus: 'NEAR', matched: true,
    maPath: 'fast', triggerScore: 82,
    scoreBreakdown: {
      proximity: 20, approach: 12, maTrend: 18, stageStructure: 22, liquidity: 10,
      total: 82, stageCoverage: 1, stageAvailableAxes: 6,
      maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
      explanations: { proximity: 'near', approach: 'toward', maTrend: 'rising', stageStructure: '6/6', liquidity: 'liquid' },
    },
    dayAStage: 1, dayBStage: 2, weekAStage: 1, weekBStage: 2,
    monthAStage: 1, monthBStage: 2, stageAvailable: true, stageComplete: true,
  }
}

function sampleResult(ma2Period = 25): TriggerDiscoveryResult {
  const row = sampleRow(ma2Period)
  return {
    contractVersion: 'trigger-discovery-v1', requestedAsOf: row.requestedAsOf,
    resolvedAsOf: row.resolvedAsOf, triggerConfig: {
      ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
      ma1Period: 20, ma2Period, slopeLookbackSessions: 20, approachLookbackSessions: 10,
      minimumAboveZoneRatio: 0.8, maxApproachDistancePct: 5, nearDistancePct: 2,
    },
    liquidityLookbackSessions: 20, maxPriceStalenessSessions: 3,
    totalTriggerMatched: 2, totalMatched: 1, rows: [row], limit: 10_000, offset: 0, hasMore: false,
    diagnostics: {
      counts: { universe: 4200, afterMarket: 4200, afterStalePrice: 4190, currentPrice: 4180, staleAccepted: 10, afterPrice: 4190, afterVolume: 4190, afterTradingValue: 4190, evaluated: 4190, matched: 2, afterStageFilter: 1, stageRows: 1, stageComplete: 1, stageIncomplete: 0 },
      rejected: { PIT_UNIVERSE: 0, MARKET_FILTER: 0, PRICE_FILTER: 0, VOLUME_FILTER: 0, TRADING_VALUE_FILTER: 0, STALE_PRICE: 10, INSUFFICIENT_HISTORY: 0, MA_NOT_BOTH_RISING: 0, MA_SPREAD_NOT_EXPANDING: 0, NOT_FROM_ABOVE: 0, NOT_APPROACHING: 0, TOO_FAR: 4188 },
      performance: { queryCount: 4, dbQueryMs: 10, maPreparationMs: 1, engineEvaluationMs: 2, stageJoinMs: 1, scoreCalculationMs: 0.2, totalMs: 14, fastPathEvaluated: 4190, genericPathEvaluated: 0 },
    },
  }
}

async function main() {
  await cleanup()
  try {
    const configs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-08-25', timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25,
      stageFilters: { weekAStage: [1, 2] }, sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 25,
    })
    let definition = await createSavedTriggerDefinition({ name: `${prefix}main`, ...configs })
    let discoveryCalls = 0
    const observedTimeframes: Array<string | undefined> = []
    const dependencies = {
      resolveAsOf: async () => '2026-09-11',
      discover: async (_input: unknown, execution?: { timeframe?: string }) => {
        discoveryCalls += 1
        observedTimeframes.push(execution?.timeframe)
        return sampleResult(definition.evaluationConfig.triggerCore.ma2Period)
      },
    }

    const saturday = await evaluateSavedTriggerDefinition(definition.id, '2026-09-12', dependencies)
    assert.equal(saturday.reused, false)
    assert.equal(saturday.evaluation.status, 'COMPLETED')
    assert.equal(saturday.evaluation.counts.triggerMatched, 2)
    assert.equal(saturday.evaluation.counts.finalMatched, 1)
    assert.deepEqual(saturday.evaluation.evaluationConfigSnapshot, definition.evaluationConfig)
    assert.deepEqual(observedTimeframes, ['BIWEEKLY'])

    const sunday = await evaluateSavedTriggerDefinition(definition.id, '2026-09-13', dependencies)
    assert.equal(sunday.reused, true, 'same resolved Friday must reuse the completed snapshot')
    assert.equal(sunday.evaluation.id, saturday.evaluation.id)
    assert.equal(sunday.evaluation.requestedAsOf, '2026-09-12', 'first requested date remains immutable metadata')
    assert.equal(discoveryCalls, 1)

    const detail = await getTriggerEvaluationDetail({ evaluationId: saturday.evaluation.id })
    assert.equal(detail.totalMembers, 1)
    assert.equal(detail.members[0].triggerScore, 82)
    assert.deepEqual(detail.members[0].scoreBreakdown, sampleRow().scoreBreakdown)
    assert.equal(detail.members[0].weekAStage, 1)
    assert.equal(detail.members[0].liquidityLookbackSessions, 20)
    assert.equal((await listSavedTriggerEvaluations(definition.id)).length, 1)

    definition = await updateSavedTriggerDefinition(definition.id, {
      viewConfig: { sort: { key: 'ticker', direction: 'asc' }, pageSize: 100 },
    })
    assert.equal(definition.evaluationVersion, 1)
    assert.equal((await evaluateSavedTriggerDefinition(definition.id, '2026-09-13', dependencies)).evaluation.id, saturday.evaluation.id)

    const changed = structuredClone(definition.evaluationConfig)
    changed.triggerCore.ma2Period = 50
    definition = await updateSavedTriggerDefinition(definition.id, { evaluationConfig: changed })
    assert.equal(definition.evaluationVersion, 2)
    const changedEvaluation = await evaluateSavedTriggerDefinition(definition.id, '2026-09-13', dependencies)
    assert.notEqual(changedEvaluation.evaluation.id, saturday.evaluation.id)
    assert.equal(changedEvaluation.evaluation.evaluationConfigSnapshot.triggerCore.ma2Period, 50)
    const oldAfterEdit = await getTriggerEvaluationDetail({ evaluationId: saturday.evaluation.id })
    assert.equal(oldAfterEdit.evaluation.evaluationConfigSnapshot.triggerCore.ma2Period, 25)
    assert.equal(oldAfterEdit.members[0].ma2Period, 25)

    const legacyEvaluationId = randomUUID()
    const legacySnapshot = structuredClone(configs.evaluationConfig) as Partial<typeof configs.evaluationConfig>
    delete legacySnapshot.timeframe
    await execRun(`INSERT INTO trigger_evaluations (
      id, definition_id, evaluation_version, engine_version, score_version,
      run_signature, evaluation_config_signature, evaluation_config_snapshot_json,
      requested_as_of, resolved_as_of, status
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, '2026-09-01', '2026-09-01', 'FAILED')`, [
      legacyEvaluationId, definition.id, definition.engineVersion, definition.scoreVersion,
      `legacy-${randomUUID()}`, definition.evaluationSignature, JSON.stringify(legacySnapshot),
    ])
    const legacySnapshotRead = await getTriggerEvaluationDetail({ evaluationId: legacyEvaluationId })
    assert.equal(legacySnapshotRead.evaluation.evaluationConfigSnapshot.timeframe, 'MONTHLY')

    const failedDefinition = await createSavedTriggerDefinition({ name: `${prefix}retry`, ...configs })
    await assert.rejects(() => evaluateSavedTriggerDefinition(failedDefinition.id, '2026-09-12', {
      resolveAsOf: async () => '2026-09-11',
      discover: async () => { throw new Error('synthetic failure with secret-like details') },
    }))
    const failed = await execGet<{ status: string; error_category: string; attempt_count: number }>(
      'SELECT status, error_category, attempt_count FROM trigger_evaluations WHERE definition_id=?',
      [failedDefinition.id],
    )
    assert.deepEqual(failed, { status: 'FAILED', error_category: 'evaluation_failed', attempt_count: 1 })
    const retried = await evaluateSavedTriggerDefinition(failedDefinition.id, '2026-09-13', {
      resolveAsOf: async () => '2026-09-11', discover: async () => sampleResult(),
    })
    assert.equal(retried.evaluation.attemptCount, 2)
    assert.equal(retried.evaluation.status, 'COMPLETED')

    await archiveSavedTriggerDefinition(definition.id)
    await assert.rejects(() => evaluateSavedTriggerDefinition(definition.id, '2026-09-14', dependencies))
    assert.equal((await listSavedTriggerEvaluations(definition.id)).length, 3, 'archive keeps current and legacy history readable')

    const counts = await execGet<{ evaluations: number; members: number }>(`
      SELECT (SELECT COUNT(*) FROM trigger_evaluations WHERE definition_id LIKE '%') AS evaluations,
             (SELECT COUNT(*) FROM trigger_evaluation_members) AS members
    `)
    console.log(JSON.stringify({ weekendIdentity: saturday.evaluation.runSignature, discoveryCalls, testRows: counts }))
    console.log('Trigger Evaluation persistence, idempotency, immutability, archive, and retry tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
