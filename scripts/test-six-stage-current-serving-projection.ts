import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/research/six-stage/current-projection/route'
import {
  assertCurrentServingProjectionPayload,
  currentProjectionRowToSimilarityVector,
} from '@/lib/research/six-stage-current-serving-projection'
import { buildFixtureCurrentServingProjection } from '@/lib/research/six-stage-current-serving-projection-fixture'
import {
  publishCurrentServingProjection,
  readCurrentServingProjection,
} from '@/lib/research/six-stage-current-serving-projection-store'
import { compareEventSimilarity } from '@/lib/research/six-stage-event-analysis'
import { buildSixStageEventLabFixture } from '@/lib/research/six-stage-event-lab-fixture'
import { createIsolatedRuntimeEnvironment } from '@/lib/runtime/isolation'

function withEnvironment<T>(environment: NodeJS.ProcessEnv, operation: () => T): T {
  const original = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, environment)
    return operation()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
  }
}

async function main(): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'six-stage-current-projection-'))
  try {
    const payload = buildFixtureCurrentServingProjection()
    assertCurrentServingProjectionPayload(payload)
    assert.equal(payload.rows.length, 36)
    assert.equal(payload.marketWatermarks.JP.rows, 18)
    assert.equal(payload.marketWatermarks.US.rows, 18)
    assert.ok(payload.rows.every((row) => row.physical.official.pms === null
      && row.physical.official.pfs === null
      && row.physical.official.pes === null))
    assert.ok(payload.rows.every((row) => row.definitionVersion === payload.definitionVersion))
    assert.ok(payload.rows.every((row) => row.stage.sequence2?.endsWith(row.stage.current)))

    const vector = currentProjectionRowToSimilarityVector(payload.rows[0])
    assert.equal(vector.physical.pms, null)
    assert.equal(typeof vector.physical.energy, 'number')
    const historical = buildSixStageEventLabFixture().events[0].vector
    const similarity = compareEventSimilarity({
      base: historical,
      candidate: vector,
      scales: {
        sma5CloseGap: 0.05,
        sma25CloseGap: 0.05,
        sma75CloseGap: 0.05,
        sma150CloseGap: 0.05,
        sma200CloseGap: 0.05,
        sma300CloseGap: 0.05,
        sma5Angle: 20,
        sma25Angle: 20,
        sma75Angle: 20,
        sma150Angle: 20,
        sma200Angle: 20,
        sma300Angle: 20,
        sma5Curvature: 0.5,
        sma25Curvature: 0.5,
        sma75Curvature: 0.5,
        sma150Curvature: 0.5,
        sma200Curvature: 0.5,
        sma300Curvature: 0.5,
        sma25To75Convergence: 0.05,
        sma75To150Convergence: 0.05,
        sma150To200Convergence: 0.05,
        sma200To300Convergence: 0.05,
        velocity: 1,
        acceleration: 1,
        momentum: 1,
        force: 1,
        energy: 1,
        pms: 1,
        pfs: 1,
        pes: 1,
      },
      weights: { transition: 35, sma: 40, physical: 25 },
    })
    assert.ok(similarity.combined !== null && similarity.combined >= 0 && similarity.combined <= 1)
    assert.ok(similarity.physical.coverage > 0 && similarity.physical.coverage < 1,
      'missing official scores reduce coverage instead of being filled with zero')
    const missingAgePayload = structuredClone(payload)
    missingAgePayload.rows[0].stage.cAge = null
    assertCurrentServingProjectionPayload(missingAgePayload)
    const missingAgeSimilarity = compareEventSimilarity({
      base: currentProjectionRowToSimilarityVector(missingAgePayload.rows[0]),
      candidate: historical,
      scales: {
        sma5CloseGap: 0.05, sma25CloseGap: 0.05, sma75CloseGap: 0.05,
        sma150CloseGap: 0.05, sma200CloseGap: 0.05, sma300CloseGap: 0.05,
        sma5Angle: 20, sma25Angle: 20, sma75Angle: 20, sma150Angle: 20, sma200Angle: 20, sma300Angle: 20,
        sma5Curvature: 0.5, sma25Curvature: 0.5, sma75Curvature: 0.5,
        sma150Curvature: 0.5, sma200Curvature: 0.5, sma300Curvature: 0.5,
        sma25To75Convergence: 0.05, sma75To150Convergence: 0.05,
        sma150To200Convergence: 0.05, sma200To300Convergence: 0.05,
        velocity: 1, acceleration: 1, momentum: 1, force: 1, energy: 1, pms: 1, pfs: 1, pes: 1,
      },
      weights: { transition: 35, sma: 40, physical: 25 },
    })
    assert.equal(missingAgeSimilarity.transition.coverage, 0.75,
      'missing current cAge must reduce transition coverage instead of becoming zero')
    const reverseSimilarity = compareEventSimilarity({
      base: vector,
      candidate: historical,
      scales: {
        sma5CloseGap: 0.05, sma25CloseGap: 0.05, sma75CloseGap: 0.05,
        sma150CloseGap: 0.05, sma200CloseGap: 0.05, sma300CloseGap: 0.05,
        sma5Angle: 20, sma25Angle: 20, sma75Angle: 20, sma150Angle: 20, sma200Angle: 20, sma300Angle: 20,
        sma5Curvature: 0.5, sma25Curvature: 0.5, sma75Curvature: 0.5,
        sma150Curvature: 0.5, sma200Curvature: 0.5, sma300Curvature: 0.5,
        sma25To75Convergence: 0.05, sma75To150Convergence: 0.05,
        sma150To200Convergence: 0.05, sma200To300Convergence: 0.05,
        velocity: 1, acceleration: 1, momentum: 1, force: 1, energy: 1, pms: 1, pfs: 1, pes: 1,
      },
      weights: { transition: 35, sma: 40, physical: 25 },
    })
    assert.equal(reverseSimilarity.combined, similarity.combined, 'similarity must be deterministic in both directions')
    const exact = buildSixStageEventLabFixture().events.filter((event) => event.vector.sequenceKey === vector.sequenceKey)
    const similar = buildSixStageEventLabFixture().events.filter((event) => event.vector.sequenceKey !== vector.sequenceKey)
    assert.ok(exact.length > 0 && similar.length > 0, 'fixture must cover exact and similarity tiers')

    const store = path.join(temporary, 'store')
    publishCurrentServingProjection({ root: store, payload })
    const loaded = readCurrentServingProjection({ root: store, expectedGenerationId: payload.generationId })
    assert.deepEqual(loaded, payload)
    assert.throws(() => readCurrentServingProjection({ root: store, maxBytes: 1 }), /BYTE_LIMIT/)

    const tamperedStore = path.join(temporary, 'tampered-store')
    publishCurrentServingProjection({ root: tamperedStore, payload })
    const tamperedDirectory = path.join(tamperedStore, 'generations', payload.generationId)
    const mismatchedPayload = structuredClone(payload)
    mismatchedPayload.generationId = 'fixture-payload-generation-mismatch'
    const mismatchedProjection = `${JSON.stringify(mismatchedPayload)}\n`
    const manifestPath = path.join(tamperedDirectory, 'COMPLETE.manifest.json')
    const mismatchedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      projectionBytes: number
      projectionSha256: string
    }
    mismatchedManifest.projectionBytes = Buffer.byteLength(mismatchedProjection)
    mismatchedManifest.projectionSha256 = crypto.createHash('sha256').update(mismatchedProjection).digest('hex')
    fs.writeFileSync(path.join(tamperedDirectory, 'projection.json'), mismatchedProjection)
    fs.writeFileSync(manifestPath, `${JSON.stringify(mismatchedManifest)}\n`)
    assert.throws(() => readCurrentServingProjection({ root: tamperedStore }), /MANIFEST_MISMATCH/)

    const currentBeforeFailure = fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8')
    const invalid = structuredClone(payload)
    invalid.generationId = 'fixture-invalid-generation'
    invalid.rows[0].physical.official.pms = 0
    assert.throws(() => publishCurrentServingProjection({ root: store, payload: invalid }), /AVAILABILITY_MISMATCH/)
    assert.equal(fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8'), currentBeforeFailure)

    const interrupted = structuredClone(payload)
    interrupted.generationId = 'fixture-interrupted-generation'
    assert.throws(() => publishCurrentServingProjection({
      root: store,
      payload: interrupted,
      beforePublish: () => { throw new Error('fixture_interruption') },
    }), /fixture_interruption/)
    assert.equal(fs.existsSync(path.join(store, 'generations', interrupted.generationId)), false)
    assert.equal(fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8'), currentBeforeFailure)

    const forbidden = structuredClone(payload) as typeof payload & { futureReturn?: number }
    forbidden.generationId = 'fixture-forbidden-generation'
    forbidden.futureReturn = 0.12
    assert.throws(() => assertCurrentServingProjectionPayload(forbidden), /FORBIDDEN_FIELD/)
    assert.throws(() => assertCurrentServingProjectionPayload(payload, { maxRows: 10 }), /ROW_LIMIT/)

    const runtime = createIsolatedRuntimeEnvironment('test', path.join(temporary, 'runtime'), {
      ...process.env,
      STOCKBOARD_FIXTURE_ONLY: '1',
    })
    const response = await withEnvironment(runtime, () => GET(new NextRequest(
      'http://127.0.0.1:3001/api/research/six-stage/current-projection?market=JP&pageSize=200',
    )))
    assert.equal(response.status, 200)
    const body = await response.json() as { fixture: boolean; total: number; rows: unknown[] }
    assert.equal(body.fixture, true)
    assert.equal(body.total, 18)
    assert.equal(body.rows.length, 18)

    const generationMismatch = await withEnvironment(runtime, () => GET(new NextRequest(
      'http://127.0.0.1:3001/api/research/six-stage/current-projection?market=JP&generation=wrong',
    )))
    assert.equal(generationMismatch.status, 409)
    const rateLimited = await withEnvironment(runtime, () => GET(new NextRequest(
      'http://127.0.0.1:3001/api/research/six-stage/current-projection?market=JP',
    )))
    assert.equal(rateLimited.status, 429)

    const publicResponse = await withEnvironment(runtime, () => GET(new NextRequest(
      'http://stock.marketframe.jp/api/research/six-stage/current-projection?market=JP',
      { headers: { 'cf-ray': 'fixture' } },
    )))
    assert.equal(publicResponse.status, 404)
    console.log(JSON.stringify({
      status: 'PASS',
      rows: payload.rows.length,
      markets: payload.marketWatermarks,
      officialScores: 'NULL_WHEN_UNAVAILABLE',
      oldGenerationProtected: true,
      apiPublicRouteRejected: true,
      apiRateLimitEnforced: true,
    }, null, 2))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
