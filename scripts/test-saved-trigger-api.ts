import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { execRun } from '@/lib/db/client'
import { GET as listSaved, POST as createSaved } from '@/app/api/trigger-discovery/saved/route'
import {
  DELETE as archiveSaved,
  GET as readSaved,
  PATCH as updateSaved,
} from '@/app/api/trigger-discovery/saved/[id]/route'
import { POST as evaluateSaved } from '@/app/api/trigger-discovery/saved/[id]/evaluate/route'
import { GET as readNotificationSettings } from '@/app/api/trigger-discovery/saved/[id]/notification-settings/route'
import { GET as listUsSaved, POST as createUsSaved } from '@/app/api/us/trigger-discovery/saved/route'
import {
  DELETE as archiveUsSaved,
  GET as readUsSaved,
  PATCH as updateUsSaved,
} from '@/app/api/us/trigger-discovery/saved/[id]/route'
import { POST as evaluateUsSaved } from '@/app/api/us/trigger-discovery/saved/[id]/evaluate/route'
import { GET as readUsNotificationSettings } from '@/app/api/us/trigger-discovery/saved/[id]/notification-settings/route'
import { savedTriggerConfigsFromSearchRequest, type SavedTriggerDetailResponse } from '@/lib/trigger-definition'

const namePrefix = '__phase7_saved_trigger_api__'

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function cleanup() {
  await execRun('DELETE FROM trigger_definitions WHERE name LIKE ?', [`${namePrefix}%`])
}

async function main() {
  await cleanup()
  const timings: Record<string, number> = {}
  try {
    const configs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-08-25',
      timeframe: 'BIWEEKLY',
      ma1Period: 10,
      ma2Period: 20,
      maxApproachDistancePct: 4,
      nearDistancePct: 1,
      stageFilters: { dayAStage: [1, 2], weekBStage: ['unknown'] },
      sort: { key: 'triggerScore', direction: 'desc' },
      pageSize: 25,
    })

    let startedAt = performance.now()
    const createdResponse = await createSaved(request('/api/trigger-discovery/saved', 'POST', {
      name: `${namePrefix}primary`,
      ...configs,
    }))
    timings.createMs = performance.now() - startedAt
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as SavedTriggerDetailResponse
    assert.equal(created.contractVersion, 'saved-trigger-definition-v1')
    assert.equal(created.definition.evaluationVersion, 1)
    assert.equal(created.definition.evaluationConfig.timeframe, 'BIWEEKLY')
    assert.equal(JSON.stringify(created.definition).includes('2026-08-25'), false)
    const id = created.definition.id

    startedAt = performance.now()
    const listResponse = await listSaved()
    timings.listMs = performance.now() - startedAt
    assert.equal(listResponse.status, 200)
    const listBody = await listResponse.json() as { definitions: Array<{ id: string }> }
    assert.ok(listBody.definitions.some((definition) => definition.id === id))

    startedAt = performance.now()
    const readResponse = await readSaved(request(`/api/trigger-discovery/saved/${id}`, 'GET'), context(id))
    timings.readMs = performance.now() - startedAt
    assert.equal(readResponse.status, 200)
    const read = await readResponse.json() as SavedTriggerDetailResponse
    assert.deepEqual(read.definition.evaluationConfig, configs.evaluationConfig)
    assert.deepEqual(read.definition.viewConfig, configs.viewConfig)

    startedAt = performance.now()
    const renamedResponse = await updateSaved(request(`/api/trigger-discovery/saved/${id}`, 'PATCH', {
      name: `${namePrefix}renamed`,
    }), context(id))
    timings.renameMs = performance.now() - startedAt
    assert.equal(renamedResponse.status, 200)
    const renamed = await renamedResponse.json() as SavedTriggerDetailResponse
    assert.equal(renamed.definition.evaluationVersion, 1)

    const viewConfig = { sort: { key: 'ticker', direction: 'asc' } as const, pageSize: 100 as const }
    const viewResponse = await updateSaved(request(`/api/trigger-discovery/saved/${id}`, 'PATCH', {
      viewConfig,
    }), context(id))
    assert.equal(viewResponse.status, 200)
    const viewUpdated = await viewResponse.json() as SavedTriggerDetailResponse
    assert.equal(viewUpdated.definition.evaluationVersion, 1)
    assert.deepEqual(viewUpdated.definition.viewConfig, viewConfig)

    const evaluationConfig = structuredClone(viewUpdated.definition.evaluationConfig)
    evaluationConfig.triggerCore.ma2Period = 25
    startedAt = performance.now()
    const evaluationResponse = await updateSaved(request(`/api/trigger-discovery/saved/${id}`, 'PATCH', {
      evaluationConfig,
    }), context(id))
    timings.updateMs = performance.now() - startedAt
    assert.equal(evaluationResponse.status, 200)
    const evaluationUpdated = await evaluationResponse.json() as SavedTriggerDetailResponse
    assert.equal(evaluationUpdated.definition.evaluationVersion, 2)

    const invalidTimeframe = structuredClone(configs.evaluationConfig) as unknown as Record<string, unknown>
    invalidTimeframe.timeframe = 'WEEKLY'
    assert.equal((await createSaved(request('/api/trigger-discovery/saved', 'POST', {
      name: `${namePrefix}invalid-timeframe`, evaluationConfig: invalidTimeframe, viewConfig: configs.viewConfig,
    }))).status, 400)
    invalidTimeframe.timeframe = 'monthly'
    assert.equal((await createSaved(request('/api/trigger-discovery/saved', 'POST', {
      name: `${namePrefix}lowercase-timeframe`, evaluationConfig: invalidTimeframe, viewConfig: configs.viewConfig,
    }))).status, 400)
    const implicitMonthly = structuredClone(configs.evaluationConfig) as Partial<typeof configs.evaluationConfig>
    delete implicitMonthly.timeframe
    const implicitMonthlyResponse = await createSaved(request('/api/trigger-discovery/saved', 'POST', {
      name: `${namePrefix}implicit-monthly`, evaluationConfig: implicitMonthly, viewConfig: configs.viewConfig,
    }))
    assert.equal(implicitMonthlyResponse.status, 201)
    assert.equal((await implicitMonthlyResponse.json() as SavedTriggerDetailResponse).definition.evaluationConfig.timeframe, 'MONTHLY')

    assert.equal((await createSaved(request('/api/trigger-discovery/saved', 'POST', {
      name: ' ', ...configs,
    }))).status, 400)
    assert.equal((await readSaved(request('/api/trigger-discovery/saved/not-a-uuid', 'GET'), context('not-a-uuid'))).status, 400)
    const missingId = '00000000-0000-4000-8000-000000000000'
    assert.equal((await readSaved(request(`/api/trigger-discovery/saved/${missingId}`, 'GET'), context(missingId))).status, 404)

    // US / JP isolation: each route only sees its own market's definitions.
    const usCreatedResponse = await createUsSaved(request('/api/us/trigger-discovery/saved', 'POST', {
      name: `${namePrefix}us`,
      ...savedTriggerConfigsFromSearchRequest({ requestedAsOf: '2026-08-25' }),
    }))
    assert.equal(usCreatedResponse.status, 201)
    assert.equal(usCreatedResponse.headers.get('Server-Timing'), null, 'US saved routes do not emit Server-Timing')
    const usId = (await usCreatedResponse.json() as SavedTriggerDetailResponse).definition.id
    assert.match(createdResponse.headers.get('Server-Timing') ?? '', /^saved-trigger-create;dur=/)

    const usListIds = (await (await listUsSaved()).json() as { definitions: Array<{ id: string }> }).definitions.map((item) => item.id)
    assert.ok(usListIds.includes(usId) && !usListIds.includes(id), 'US list must contain only US definitions')
    const jpListIds = (await (await listSaved()).json() as { definitions: Array<{ id: string }> }).definitions.map((item) => item.id)
    assert.ok(jpListIds.includes(id) && !jpListIds.includes(usId), 'JP list must contain only JP definitions')

    assert.equal((await readUsSaved(request(`/api/us/trigger-discovery/saved/${usId}`, 'GET'), context(usId))).status, 200)
    assert.equal((await readSaved(request(`/api/trigger-discovery/saved/${usId}`, 'GET'), context(usId))).status, 404)
    assert.equal((await readUsSaved(request(`/api/us/trigger-discovery/saved/${id}`, 'GET'), context(id))).status, 404)
    assert.equal((await updateSaved(request(`/api/trigger-discovery/saved/${usId}`, 'PATCH', { name: `${namePrefix}x` }), context(usId))).status, 404)
    assert.equal((await updateUsSaved(request(`/api/us/trigger-discovery/saved/${id}`, 'PATCH', { name: `${namePrefix}x` }), context(id))).status, 404)
    assert.equal((await archiveSaved(request(`/api/trigger-discovery/saved/${usId}`, 'DELETE'), context(usId))).status, 404)
    assert.equal((await archiveUsSaved(request(`/api/us/trigger-discovery/saved/${id}`, 'DELETE'), context(id))).status, 404)
    assert.equal((await evaluateSaved(request(`/api/trigger-discovery/saved/${usId}/evaluate`, 'POST', { requestedAsOf: '2026-08-25' }), context(usId))).status, 404)
    assert.equal((await evaluateUsSaved(request(`/api/us/trigger-discovery/saved/${id}/evaluate`, 'POST', { requestedAsOf: '2026-08-25' }), context(id))).status, 404)
    assert.equal((await readNotificationSettings(request(`/api/trigger-discovery/saved/${usId}/notification-settings`, 'GET'), context(usId))).status, 404)
    assert.equal((await readUsNotificationSettings(request(`/api/us/trigger-discovery/saved/${id}/notification-settings`, 'GET'), context(id))).status, 404)

    const usArchivedResponse = await archiveUsSaved(request(`/api/us/trigger-discovery/saved/${usId}`, 'DELETE'), context(usId))
    assert.equal(usArchivedResponse.status, 200)
    assert.equal(usArchivedResponse.headers.get('Server-Timing'), null)
    assert.equal((await readSaved(request(`/api/trigger-discovery/saved/${id}`, 'GET'), context(id))).status, 200, 'US archive must not touch JP definitions')

    startedAt = performance.now()
    const archivedResponse = await archiveSaved(request(`/api/trigger-discovery/saved/${id}`, 'DELETE'), context(id))
    timings.archiveMs = performance.now() - startedAt
    assert.equal(archivedResponse.status, 200)
    assert.equal((await archivedResponse.json() as { archived: boolean }).archived, true)
    assert.equal((await readSaved(request(`/api/trigger-discovery/saved/${id}`, 'GET'), context(id))).status, 404)

    console.log(JSON.stringify({ contract: 'saved-trigger-definition-v1', timings }, null, 2))
    console.log('saved Trigger API CRUD and status tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
