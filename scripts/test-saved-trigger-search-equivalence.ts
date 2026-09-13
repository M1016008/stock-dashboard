import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { POST as search } from '@/app/api/trigger-discovery/search/route'
import { execRun } from '@/lib/db/client'
import { createSavedTriggerDefinition, getSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import { getTriggerDiscoveryOptions } from '@/lib/server/trigger-discovery-options'
import {
  savedTriggerConfigsFromSearchRequest,
  searchRequestFromSavedTrigger,
} from '@/lib/trigger-definition'
import type { TriggerDiscoverySearchRequest, TriggerDiscoverySearchResponse } from '@/lib/trigger-discovery-contract'

const name = '__phase7_saved_trigger_equivalence__'

function nextRequest(body: TriggerDiscoverySearchRequest): NextRequest {
  return new NextRequest('http://localhost/api/trigger-discovery/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function run(body: TriggerDiscoverySearchRequest): Promise<TriggerDiscoverySearchResponse> {
  const response = await search(nextRequest(body))
  assert.equal(response.status, 200)
  return response.json() as Promise<TriggerDiscoverySearchResponse>
}

async function cleanup() {
  await execRun('DELETE FROM trigger_definitions WHERE name=?', [name])
}

async function main() {
  await cleanup()
  try {
    const options = await getTriggerDiscoveryOptions()
    assert.ok(options.latestAsOf)
    const manual: TriggerDiscoverySearchRequest = {
      requestedAsOf: options.latestAsOf!,
      timeframe: 'BIWEEKLY',
      ma1Period: 20,
      ma2Period: 25,
      maxApproachDistancePct: 5,
      nearDistancePct: 2,
      averageTradingValueMin: 100_000_000,
      stageFilters: {},
      sort: { key: 'triggerScore', direction: 'desc' },
      page: 1,
      pageSize: 100,
    }
    const definition = await createSavedTriggerDefinition({ name, ...savedTriggerConfigsFromSearchRequest(manual) })
    const reloaded = await getSavedTriggerDefinition(definition.id)
    const loaded = searchRequestFromSavedTrigger(reloaded, manual.requestedAsOf)

    const startedAt = performance.now()
    const manualResult = await run(manual)
    const firstMs = performance.now() - startedAt
    const loadedStartedAt = performance.now()
    const loadedResult = await run(loaded)
    const loadedMs = performance.now() - loadedStartedAt

    assert.equal(loadedResult.meta.matchedCount, manualResult.meta.matchedCount)
    assert.equal(loadedResult.meta.timeframe, 'BIWEEKLY')
    assert.deepEqual(loadedResult.criteria, manualResult.criteria)
    assert.deepEqual(loadedResult.rows, manualResult.rows)
    assert.equal(loadedResult.performance.queryCount, 0, 'identical loaded conditions reuse the existing Discovery cache')
    console.log(JSON.stringify({
      requestedAsOf: manual.requestedAsOf,
      matchedCount: manualResult.meta.matchedCount,
      returnedCount: manualResult.rows.length,
      manualMs: Math.round(firstMs),
      loadedMs: Math.round(loadedMs * 1000) / 1000,
      rowsEqual: true,
    }, null, 2))
    console.log('manual and Saved Trigger search equivalence passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
