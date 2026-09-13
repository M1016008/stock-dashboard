import assert from 'node:assert/strict'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { getTriggerDiscovery } from '@/lib/server/trigger-discovery-read-model'
import { createSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import { evaluateSavedTriggerDefinition, getTriggerEvaluationDetail } from '@/lib/server/trigger-evaluations'
import { getTriggerLifecycleEvents } from '@/lib/server/trigger-lifecycle'
import { parseTriggerDiscoverySearchRequest } from '@/lib/server/trigger-discovery-search-request'
import { savedTriggerConfigsFromSearchRequest, searchRequestFromSavedTrigger } from '@/lib/trigger-definition'

const name = '__phase8b1_trigger_lifecycle_real__'

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

async function main() {
  await cleanup()
  try {
    const configs = savedTriggerConfigsFromSearchRequest({ requestedAsOf: '2026-09-09', ma1Period: 20, ma2Period: 25 })
    const definition = await createSavedTriggerDefinition({ name, ...configs })
    const first = await evaluateSavedTriggerDefinition(definition.id, '2026-09-09')
    const secondStartedAt = performance.now()
    const second = await evaluateSavedTriggerDefinition(definition.id, '2026-09-10')
    const secondTotalMs = performance.now() - secondStartedAt
    const [firstDetail, secondDetail, lifecycle] = await Promise.all([
      getTriggerEvaluationDetail({ evaluationId: first.evaluation.id, limit: 500 }),
      getTriggerEvaluationDetail({ evaluationId: second.evaluation.id, limit: 500 }),
      getTriggerLifecycleEvents(second.evaluation.id),
    ])
    const observationCount = await execGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trigger_evaluation_observations WHERE evaluation_id=?',
      [second.evaluation.id],
    )
    assert.equal(Number(observationCount?.count), firstDetail.totalMembers, 'all and only previous members are observed')
    assert.equal(second.lifecycle.previousEvaluationId, first.evaluation.id)
    assert.equal(second.lifecycle.eventCount, lifecycle.events.length)
    assert.ok(lifecycle.events.every((row) => row.resolvedAsOf === second.evaluation.resolvedAsOf))

    const manualInput = parseTriggerDiscoverySearchRequest(
      searchRequestFromSavedTrigger(definition, '2026-09-10'),
    ).input
    const manual = await getTriggerDiscovery({
      ...manualInput, sortBy: undefined, sortDirection: undefined, limit: 10_000, offset: 0,
    })
    assert.deepEqual(
      secondDetail.members.map((row) => row.ticker).sort(),
      manual.rows.map((row) => row.ticker).sort(),
      'Lifecycle observation must not change the final candidate set',
    )
    assert.equal(second.evaluation.performance.discoveryQueryCount, manual.diagnostics.performance.queryCount)

    const storage = await execAll<{ name: string; bytes: number }>(`
      SELECT name, SUM(pgsize) AS bytes FROM dbstat
      WHERE name IN (
        'trigger_evaluation_observations', 'trigger_lifecycle_events',
        'trigger_lifecycle_events_identity_idx', 'trigger_lifecycle_events_definition_date_idx'
      ) GROUP BY name ORDER BY name
    `)
    console.log(JSON.stringify({
      first: { resolvedAsOf: first.evaluation.resolvedAsOf, members: firstDetail.totalMembers },
      second: { resolvedAsOf: second.evaluation.resolvedAsOf, members: secondDetail.totalMembers },
      observations: Number(observationCount?.count),
      lifecycle: second.lifecycle,
      eventCounts: lifecycle.eventCounts,
      performance: {
        secondTotalMs: Math.round(secondTotalMs * 1000) / 1000,
        discoveryMs: second.evaluation.performance.discoveryMs,
        lifecycleAndServiceOverheadMs: Math.round((secondTotalMs - second.evaluation.performance.totalMs) * 1000) / 1000,
        discoveryQueryCount: second.evaluation.performance.discoveryQueryCount,
        normalDiscoveryQueryCount: manual.diagnostics.performance.queryCount,
      },
      candidateSetUnchanged: true,
      storage,
    }, null, 2))
    console.log('Real two-date Trigger lifecycle PIT, observation, candidate parity, and performance tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
