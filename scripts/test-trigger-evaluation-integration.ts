import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { POST as evaluateRoute } from '@/app/api/trigger-discovery/saved/[id]/evaluate/route'
import { GET as listRoute } from '@/app/api/trigger-discovery/saved/[id]/evaluations/route'
import { GET as detailRoute } from '@/app/api/trigger-discovery/evaluations/[evaluationId]/route'
import { execAll, execRun } from '@/lib/db/client'
import { getTriggerDiscovery } from '@/lib/server/trigger-discovery-read-model'
import { createSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import { parseTriggerDiscoverySearchRequest } from '@/lib/server/trigger-discovery-search-request'
import type { TriggerEvaluationDetailResponse, TriggerEvaluationRunResponse } from '@/lib/trigger-evaluation'
import { savedTriggerConfigsFromSearchRequest, searchRequestFromSavedTrigger } from '@/lib/trigger-definition'

const name = '__phase8a_trigger_evaluation_integration__'

async function cleanup() {
  const rows = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name=?', [name])
  for (const row of rows) {
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [row.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [row.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [row.id])
  }
}

function context<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) }
}

async function main() {
  await cleanup()
  try {
    const requestedAsOf = '2026-09-12'
    const repeatedRequestedAsOf = '2026-09-13'
    const configs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf, timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25,
      sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 25,
    })
    const definition = await createSavedTriggerDefinition({ name, ...configs })
    const parsedManual = parseTriggerDiscoverySearchRequest(searchRequestFromSavedTrigger(definition, requestedAsOf))
    const manualInput = parsedManual.input
    const manualStartedAt = performance.now()
    const manual = await getTriggerDiscovery(
      { ...manualInput, sortBy: undefined, sortDirection: undefined, limit: 10_000, offset: 0 },
      { timeframe: parsedManual.timeframe },
    )
    const manualMs = performance.now() - manualStartedAt

    const evaluateRequest = new NextRequest(`http://localhost/api/trigger-discovery/saved/${definition.id}/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestedAsOf }),
    })
    const evaluateResponse = await evaluateRoute(evaluateRequest, context({ id: definition.id }))
    assert.equal(evaluateResponse.status, 200)
    const evaluated = await evaluateResponse.json() as TriggerEvaluationRunResponse
    assert.equal(evaluated.evaluation.status, 'COMPLETED')
    assert.equal(evaluated.evaluation.evaluationConfigSnapshot.timeframe, 'BIWEEKLY')
    assert.equal(evaluated.evaluation.counts.triggerMatched, manual.totalTriggerMatched)
    assert.equal(evaluated.evaluation.counts.finalMatched, manual.totalMatched)

    const listResponse = await listRoute(new NextRequest('http://localhost'), context({ id: definition.id }))
    assert.equal(listResponse.status, 200)
    const listed = await listResponse.json() as { evaluations: Array<{ id: string }> }
    assert.equal(listed.evaluations[0].id, evaluated.evaluation.id)

    const detailResponse = await detailRoute(
      new NextRequest(`http://localhost/api/trigger-discovery/evaluations/${evaluated.evaluation.id}?limit=500`),
      context({ evaluationId: evaluated.evaluation.id }),
    )
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json() as TriggerEvaluationDetailResponse
    const expected = manual.rows.slice().sort((a, b) => a.ticker.localeCompare(b.ticker))
    assert.equal(detail.totalMembers, expected.length)
    for (const row of detail.members) {
      assert.ok(row.priceDate <= evaluated.evaluation.resolvedAsOf, 'future OHLCV must not enter the snapshot')
      assert.ok(row.maDate <= evaluated.evaluation.resolvedAsOf, 'future MA must not enter the snapshot')
      assert.ok(row.stageDate == null || row.stageDate <= evaluated.evaluation.resolvedAsOf, 'future Stage must not enter the snapshot')
    }
    assert.deepEqual(detail.members.map((row) => ({
      ticker: row.ticker, status: row.triggerStatus, score: row.triggerScore,
      stages: [row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage],
      distance: row.zoneDistancePct, ma1: row.ma1Value, ma2: row.ma2Value,
      zone: [row.zoneLower, row.zoneUpper],
    })), expected.map((row) => ({
      ticker: row.ticker, status: row.triggerStatus, score: row.triggerScore,
      stages: [row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage],
      distance: row.zoneDistancePct, ma1: row.ma1Value, ma2: row.ma2Value,
      zone: [row.zoneLower, row.zoneUpper],
    })))

    const storage = await execAll<{ name: string; bytes: number }>(`
      SELECT name, SUM(pgsize) AS bytes FROM dbstat
      WHERE name IN (
        'trigger_evaluations', 'trigger_evaluations_run_signature_idx',
        'trigger_evaluations_definition_date_idx', 'trigger_evaluation_members',
        'trigger_evaluation_members_status_idx'
      ) GROUP BY name ORDER BY name
    `)
    const logical = await execAll<{ bytes: number }>(`
      SELECT COALESCE(SUM(
        LENGTH(ticker) + LENGTH(company_name) + LENGTH(trigger_status)
        + LENGTH(score_breakdown_json) + LENGTH(price_date) + LENGTH(ma_date)
      ), 0) AS bytes
      FROM trigger_evaluation_members WHERE evaluation_id=?
    `, [evaluated.evaluation.id])

    const repeatedResponse = await evaluateRoute(new NextRequest(
      `http://localhost/api/trigger-discovery/saved/${definition.id}/evaluate`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestedAsOf: repeatedRequestedAsOf }) },
    ), context({ id: definition.id }))
    assert.equal(repeatedResponse.status, 200)
    const repeated = await repeatedResponse.json() as TriggerEvaluationRunResponse
    assert.equal(repeated.reused, true)
    assert.equal(repeated.evaluation.id, evaluated.evaluation.id)
    assert.equal(repeated.evaluation.requestedAsOf, requestedAsOf)

    console.log(JSON.stringify({
      requestedAsOf, resolvedAsOf: evaluated.evaluation.resolvedAsOf,
      triggerMatched: evaluated.evaluation.counts.triggerMatched,
      finalMatched: evaluated.evaluation.counts.finalMatched,
      manualMs: Math.round(manualMs), performance: evaluated.evaluation.performance,
      rowsEqual: true, idempotent: true, storage, logicalMemberTextBytes: Number(logical[0]?.bytes ?? 0),
    }, null, 2))
    console.log('Trigger Evaluation API, PIT, persistence, and Search equivalence tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
