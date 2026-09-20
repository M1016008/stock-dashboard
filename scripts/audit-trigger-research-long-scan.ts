import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execAll, execGet } from '@/lib/db/client'
import { historicalScanResultPaths, historicalScanSourceFingerprint } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { getTriggerDiscovery, type TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import { parseTriggerHistoricalScanRequest } from '@/lib/server/trigger-discovery-historical-scan-request'
import { runResearchLongScan } from '@/lib/server/trigger-research-long-scan'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'

const id = process.argv[2]
if (!id) throw new Error('usage: tsx scripts/audit-trigger-research-long-scan.ts <research-job-id>')

type Compact = ReturnType<typeof compact>
function compact(row: TriggerDiscoveryRow) {
  return {
    ticker: row.ticker, status: row.triggerStatus, score: row.triggerScore,
    breakdown: row.scoreBreakdown, price: row.price, ma1: row.ma1Value, ma2: row.ma2Value,
    zoneDistance: row.zoneDistancePct, priceDate: row.priceDate, maDate: row.maDate,
    stageDate: row.stageDate, stages: [row.dayAStage, row.dayBStage, row.weekAStage,
      row.weekBStage, row.monthAStage, row.monthBStage],
  }
}
function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
}

async function main() {
  const row = await execGet<{ request_json: string; status: string }>(
    'SELECT request_json,status FROM historical_trigger_scan_jobs WHERE id=?', [id])
  assert.equal(row?.status, 'COMPLETED')
  const paths = historicalScanResultPaths(id)
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as TriggerHistoricalScanResponse
  const provenance = manifest.researchProvenance
  assert.equal(provenance?.mode, 'RESEARCH_LONG_RANGE_CHUNKED')
  assert.equal(provenance.sourceFingerprint, await historicalScanSourceFingerprint())
  const request = JSON.parse(row!.request_json) as TriggerHistoricalScanRequest
  const parsed = parseTriggerHistoricalScanRequest(request)
  const dates = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [request.startDate, request.endDate],
  )).map((entry) => entry.date)
  assert.equal(dates.length, manifest.scanMeta.tradingDayCount)
  const selected = new Set<string>()
  for (let index = 0; index < 20; index += 1) {
    selected.add(dates[Math.round(index * (dates.length - 1) / 19)])
  }
  const boundaryIndexes = provenance.chunkRanges.slice(0, -1).map(([, end]) => dates.indexOf(end))
  for (const index of boundaryIndexes) {
    assert.ok(index >= 0)
    for (let delta = -4; delta <= 5; delta += 1) selected.add(dates[index + delta])
  }
  const captured = new Map<string, Compact[]>()
  const eventHash = createHash('sha256')
  const boundaryEvents = new Map<string, TriggerHistoricalScanEvent[]>()
  const replay = await runResearchLongScan({
    request, sessions: dates, chunkSessions: provenance.chunkSessions,
    onDay: (date, rows) => {
      if (selected.has(date)) captured.set(date, rows.map(compact))
    },
    onEvents: (date, events) => {
      for (const event of events) eventHash.update(`${JSON.stringify(event)}\n`)
      if (selected.has(date)) boundaryEvents.set(date, events)
    },
  })
  assert.equal(eventHash.digest('hex'), provenance.eventsSha256, 'complete event stream replay')
  assert.deepEqual(replay.response.dailyCounts, manifest.dailyCounts)
  assert.deepEqual(replay.response.summary, manifest.summary)
  assert.deepEqual(replay.chunkRanges, provenance.chunkRanges)
  let comparedRows = 0
  const comparisons: Array<{ date: string; candidates: number }> = []
  for (const date of [...selected].sort()) {
    const result = await getTriggerDiscovery({ ...parsed.input, asOf: date, limit: 10_000 },
      { timeframe: parsed.timeframe })
    assert.equal(result.resolvedAsOf, date, `${date}: resolved date`)
    const expected = captured.get(date)
    assert.ok(expected, `${date}: captured day`)
    const actual = result.rows.map(compact)
    const byTicker = new Map(actual.map((entry) => [entry.ticker, entry]))
    assert.deepEqual([...expected.map((entry) => entry.ticker)].sort(),
      [...byTicker.keys()].sort(), `${date}: candidate ticker set`)
    for (const item of expected) {
      const reference = byTicker.get(item.ticker)!
      for (const key of ['price', 'ma1', 'ma2', 'zoneDistance'] as const) {
        assert.ok(close(item[key], reference[key]), `${date} ${item.ticker}: ${key}`)
      }
      assert.deepEqual({ ...item, price: 0, ma1: 0, ma2: 0, zoneDistance: 0 },
        { ...reference, price: 0, ma1: 0, ma2: 0, zoneDistance: 0 },
        `${date} ${item.ticker}: status/score/stage/date`)
      comparedRows += 1
    }
    comparisons.push({ date, candidates: expected.length })
  }
  const continuity: Array<{ boundary: string; next: string; unchanged: number;
    statusChanged: number; expectedEvents: number }> = []
  for (const index of boundaryIndexes) {
    const before = new Map(captured.get(dates[index])!.map((entry) => [entry.ticker, entry]))
    const after = captured.get(dates[index + 1])!
    const events = boundaryEvents.get(dates[index + 1]) ?? []
    const eventByTicker = new Map(events.map((event) => [event.ticker, event]))
    let unchanged = 0
    let statusChanged = 0
    for (const current of after) {
      const prior = before.get(current.ticker)
      if (!prior) continue
      const event = eventByTicker.get(current.ticker)
      if (prior.status === current.status) {
        assert.equal(event, undefined, `${current.ticker}: spurious boundary event`)
        unchanged += 1
      } else {
        assert.equal(event?.eventType, 'STATUS_CHANGED', `${current.ticker}: boundary status`)
        statusChanged += 1
      }
    }
    continuity.push({ boundary: dates[index], next: dates[index + 1], unchanged,
      statusChanged, expectedEvents: events.length })
  }
  console.log(JSON.stringify({ status: 'PASS', jobId: id, timeframe: parsed.timeframe,
    ma: [manifest.scanMeta.ma1Period, manifest.scanMeta.ma2Period],
    sampledDates: comparisons.length, comparedRows, comparisons,
    boundaryContinuity: continuity, eventStreamHash: provenance.eventsSha256,
    replayMs: replay.response.performance.totalMs }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
