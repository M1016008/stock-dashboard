import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { GET as lifecycleRoute } from '@/app/api/trigger-discovery/evaluations/[evaluationId]/events/route'
import { execAll, execGet, execRun } from '@/lib/db/client'
import type {
  TriggerDiscoveryInput,
  TriggerDiscoveryObservation,
  TriggerDiscoveryResult,
  TriggerDiscoveryRow,
} from '@/lib/server/trigger-discovery-read-model'
import { archiveSavedTriggerDefinition, createSavedTriggerDefinition, updateSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import { evaluateSavedTriggerDefinition } from '@/lib/server/trigger-evaluations'
import { deriveAndPersistTriggerLifecycle, getTriggerLifecycleEvents } from '@/lib/server/trigger-lifecycle'
import { savedTriggerConfigsFromSearchRequest } from '@/lib/trigger-definition'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'

const name = '__phase8b1_trigger_lifecycle__'

async function cleanup() {
  const definitions = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name=?', [name])
  for (const definition of definitions) {
    await execRun('DELETE FROM trigger_lifecycle_events WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_observations WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [definition.id])
  }
}

function row(ticker: string, date: string, status: TriggerDiscoveryRow['triggerStatus']): TriggerDiscoveryRow {
  const inZone = status === 'IN_ZONE'
  return {
    ticker, companyName: `Company ${ticker}`, market: 'プライム',
    requestedAsOf: date, resolvedAsOf: date, priceDate: date, maDate: date, stageDate: date,
    price: inZone ? 99 : 100, priceStalenessSessions: 0, priceFreshness: 'CURRENT',
    averageVolume: 1_000_000, averageTradingValue: 100_000_000,
    liquidityLookbackSessions: 20, liquidityObservationCount: 20, liquidityComplete: true,
    ma1Period: 20, ma2Period: 25, ma1Value: 99, ma2Value: 98,
    ma1Trend: 'RISING', ma2Trend: 'RISING', ma1SlopePct: 1, ma2SlopePct: 0.8,
    bothRising: true, zoneUpper: 99, zoneLower: 98,
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

function observed(ticker: string, date: string, status: TriggerDiscoveryRow['triggerStatus']): TriggerDiscoveryObservation {
  const current = row(ticker, date, status)
  return {
    ticker, disposition: 'FINAL_CANDIDATE', exclusionReason: null,
    triggerStatus: status, pricePosition: status === 'IN_ZONE' ? 'IN_ZONE' : 'ABOVE_ZONE',
    bothRising: true, fromAbove: true, approachDirection: 'TOWARD_ZONE',
    zoneUpper: current.zoneUpper, zoneLower: current.zoneLower,
    zoneDistancePct: current.zoneDistancePct, price: current.price,
    triggerScore: current.triggerScore, priceDate: date, maDate: date, stageDate: date,
    universeFilterPassed: true, priceFilterPassed: true, liquidityFilterPassed: true,
    stageFilterPassed: true, dataAvailable: true,
  }
}

function result(date: string, rows: TriggerDiscoveryRow[], observations: TriggerDiscoveryObservation[]): TriggerDiscoveryResult {
  return {
    contractVersion: 'trigger-discovery-v1', requestedAsOf: date, resolvedAsOf: date,
    triggerConfig: DEFAULT_MA_ZONE_TRIGGER_CONFIG, liquidityLookbackSessions: 20,
    maxPriceStalenessSessions: 3, totalTriggerMatched: rows.length, totalMatched: rows.length,
    rows, limit: 10_000, offset: 0, hasMore: false, observations,
    diagnostics: {
      counts: { universe: 4200, afterMarket: 4200, afterStalePrice: 4200, currentPrice: 4200, staleAccepted: 0, afterPrice: 4200, afterVolume: 4200, afterTradingValue: 4200, evaluated: 4200, matched: rows.length, afterStageFilter: rows.length, stageRows: rows.length, stageComplete: rows.length, stageIncomplete: 0 },
      rejected: { PIT_UNIVERSE: 0, MARKET_FILTER: 0, PRICE_FILTER: 0, VOLUME_FILTER: 0, TRADING_VALUE_FILTER: 0, STALE_PRICE: 0, INSUFFICIENT_HISTORY: 0, MA_NOT_BOTH_RISING: 0, NOT_FROM_ABOVE: 0, NOT_APPROACHING: 0, TOO_FAR: 0 },
      performance: { queryCount: 4, dbQueryMs: 10, maPreparationMs: 1, engineEvaluationMs: 1, stageJoinMs: 1, scoreCalculationMs: 0.1, totalMs: 13, fastPathEvaluated: 4200, genericPathEvaluated: 0 },
    },
  }
}

async function main() {
  await cleanup()
  try {
    const configs = savedTriggerConfigsFromSearchRequest({ requestedAsOf: '2026-09-08', timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25 })
    let definition = await createSavedTriggerDefinition({ name, ...configs })
    let discoveryCalls = 0
    const discover = async (input: TriggerDiscoveryInput, options?: { timeframe?: string }): Promise<TriggerDiscoveryResult> => {
      discoveryCalls += 1
      assert.equal(options?.timeframe, 'BIWEEKLY', 'Biweekly lifecycle observations must use the same timeframe')
      if (input.asOf === '2026-09-08') {
        assert.deepEqual(input.observeTickers, [])
        return result(input.asOf, [row('A', input.asOf, 'APPROACHING')], [])
      }
      assert.deepEqual(input.observeTickers, ['A'], 'only previous members are observed')
      return result(input.asOf, [row('A', input.asOf, 'NEAR'), row('N', input.asOf, 'NEAR')], [observed('A', input.asOf, 'NEAR')])
    }
    const dependencies = { resolveAsOf: async (date: string) => date, discover }

    const baseline = await evaluateSavedTriggerDefinition(definition.id, '2026-09-08', dependencies)
    assert.equal(baseline.lifecycle.baseline, true)
    assert.equal(baseline.lifecycle.eventCount, 0)

    for (const status of ['FAILED', 'RUNNING']) {
      await execRun(`INSERT INTO trigger_evaluations (
        id, definition_id, evaluation_version, engine_version, score_version,
        run_signature, evaluation_config_signature, evaluation_config_snapshot_json,
        requested_as_of, resolved_as_of, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-09', '2026-09-09', ?)`, [
        randomUUID(), definition.id, definition.evaluationVersion, definition.engineVersion,
        definition.scoreVersion, `${status.toLowerCase()}-${randomUUID()}`,
        definition.evaluationSignature, JSON.stringify(definition.evaluationConfig), status,
      ])
    }

    const current = await evaluateSavedTriggerDefinition(definition.id, '2026-09-10', dependencies)
    assert.equal(current.lifecycle.baseline, false)
    assert.equal(current.lifecycle.previousEvaluationId, baseline.evaluation.id, 'FAILED and RUNNING evaluations are skipped')
    assert.deepEqual(current.lifecycle.eventCounts, { STATUS_CHANGED: 1, NEW: 1 })
    const lifecycle = await getTriggerLifecycleEvents(current.evaluation.id)
    assert.deepEqual(lifecycle.events.map((event) => [event.ticker, event.eventType]), [['A', 'STATUS_CHANGED'], ['N', 'NEW']])
    assert.equal(lifecycle.events[0].previousTriggerStatus, 'APPROACHING')
    assert.equal(lifecycle.events[0].currentTriggerStatus, 'NEAR')
    const routeResponse = await lifecycleRoute(
      new NextRequest(`http://localhost/api/trigger-discovery/evaluations/${current.evaluation.id}/events`),
      { params: Promise.resolve({ evaluationId: current.evaluation.id }) },
    )
    assert.equal(routeResponse.status, 200)
    assert.equal((await routeResponse.json() as { eventCount: number }).eventCount, 2)

    const beforeRegeneration = await getTriggerLifecycleEvents(current.evaluation.id)
    await deriveAndPersistTriggerLifecycle(current.evaluation.id)
    await deriveAndPersistTriggerLifecycle(current.evaluation.id)
    assert.deepEqual(await getTriggerLifecycleEvents(current.evaluation.id), beforeRegeneration, 'repeated derivation keeps event content identical')
    const eventCount = await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_lifecycle_events WHERE current_evaluation_id=?',
      [current.evaluation.id],
    )
    assert.equal(Number(eventCount?.count), 2, 'repeated derivation must not duplicate events')
    const reused = await evaluateSavedTriggerDefinition(definition.id, '2026-09-10', dependencies)
    assert.equal(reused.reused, true)
    assert.equal(discoveryCalls, 2, 'lifecycle does not rerun discovery')

    const changed = structuredClone(definition.evaluationConfig)
    changed.timeframe = 'MONTHLY'
    definition = await updateSavedTriggerDefinition(definition.id, { evaluationConfig: changed })
    const versionTwo = await evaluateSavedTriggerDefinition(definition.id, '2026-09-10', {
      resolveAsOf: async (date) => date,
      discover: async (input) => result(input.asOf, [row('V2', input.asOf, 'NEAR')], []),
    })
    assert.equal(versionTwo.evaluation.evaluationVersion, 2)
    assert.equal(versionTwo.evaluation.evaluationConfigSnapshot.timeframe, 'MONTHLY')
    assert.equal(versionTwo.lifecycle.baseline, true, 'a new timeframe version must not compare to the Biweekly version')
    assert.equal(versionTwo.lifecycle.eventCount, 0)
    await archiveSavedTriggerDefinition(definition.id)
    assert.equal((await getTriggerLifecycleEvents(current.evaluation.id)).eventCount, 2, 'archived definitions keep lifecycle history readable')

    console.log(JSON.stringify({ baseline: baseline.lifecycle, second: current.lifecycle, discoveryCalls, idempotentEventCount: 2, versionTwoBaseline: versionTwo.lifecycle.baseline }))
    console.log('Trigger lifecycle persistence, Evaluation connection, idempotency, and version baseline tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
