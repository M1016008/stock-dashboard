import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getTriggerPathFollowUp } from '@/lib/server/trigger-path-read-model'
import { getPathResearchArtifact } from '@/lib/server/trigger-path-research-jobs'
import { getPathResearchSegments, parsePathResearchQuery } from '@/lib/server/trigger-path-research-segmentation'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'
import type { TriggerPathHorizonResult } from '@/lib/trigger-path-contract'

const jobId = process.argv[2]
if (!jobId) throw new Error('usage: npm run audit:trigger-path-research -- <path-research-job-id>')

async function main() {
  const artifact = await getPathResearchArtifact(jobId)
  if (!artifact || typeof artifact === 'string') throw new Error(`path research artifact unavailable: ${artifact}`)
  const rows: PathResearchRow[] = []
  const lines = createInterface({ input: createReadStream(artifact.rowsFile, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) if (line) rows.push(JSON.parse(line) as PathResearchRow)
  assert.equal(rows.length, artifact.manifest.sourceObservationCount)
  const sample = Array.from({ length: Math.min(30, rows.length) }, (_, index) =>
    rows[Math.floor(index * rows.length / Math.min(30, rows.length))]!)
  let exact = 0
  const statusCounts = new Map<string, number>()
  for (const row of sample) {
    const single = await getTriggerPathFollowUp({ jobId: artifact.manifest.historicalScanJobId, eventKey: row.eventKey })
    if (!single || typeof single === 'string') throw new Error(`single follow-up unavailable: ${row.eventKey} ${single}`)
    assert.equal(single.meta.analysisCutoffDate, row.analysisCutoffDate, 'single cutoff differs from batch source')
    assert.deepEqual(row.pathProfile, single.pathProfile, `path mismatch: ${row.eventKey} ${row.ticker}`)
    for (const horizon of [20, 60, 120, 245]) {
      const batch: TriggerPathHorizonResult | undefined = row.pathProfile?.horizonPaths.find((item) => item.horizonSessions === horizon)
      const one: TriggerPathHorizonResult | undefined = single.pathProfile.horizonPaths.find((item) => item.horizonSessions === horizon)
      assert.deepEqual(batch, one, `fixed ${horizon} mismatch: ${row.eventKey}`)
    }
    statusCounts.set(single.event.currentStatus ?? 'NONE', (statusCounts.get(single.event.currentStatus ?? 'NONE') ?? 0) + 1)
    exact += 1
  }
  for (const horizon of [20, 60, 120, 245]) {
    const response = await getPathResearchSegments(jobId, parsePathResearchQuery(
      `http://local/?dimension=pathDepthLow&dimension=stage:monthA&horizon=${horizon}`))
    if (!response || typeof response === 'string') throw new Error(`segments unavailable: ${horizon}`)
    assert.ok(Object.values(response.integrity).every(Boolean), `integrity: ${horizon}`)
  }
  console.log(JSON.stringify({ jobId, timeframe: artifact.manifest.timeframe,
    ma: [artifact.manifest.ma1Period, artifact.manifest.ma2Period],
    sourceRows: rows.length, sampleExact: exact, statusCounts: Object.fromEntries(statusCounts),
    sqlQueryCount: artifact.manifest.performance.sqlQueryCount,
    artifactBytes: artifact.manifest.performance.artifactBytes }, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
