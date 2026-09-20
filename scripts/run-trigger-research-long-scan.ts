import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { TRIGGER_ENGINE_VERSION } from '@/lib/trigger-discovery-engine'
import {
  historicalScanResultPaths,
  historicalScanResultSignature,
  historicalScanSourceFingerprint,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { runResearchLongScan, RESEARCH_LONG_SCAN_VERSION } from '@/lib/server/trigger-research-long-scan'
import type { TriggerHistoricalScanRequest } from '@/lib/trigger-discovery-historical-scan-contract'

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing ${name}`)
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
  return value
}

async function main() {
  const sourceId = option('--source-job-id')
  const startDate = option('--start-date')
  const endDate = option('--end-date')
  const chunkSessions = Number(option('--chunk-sessions', '180'))
  const enableBelowZone = process.argv.includes('--enable-below-zone')
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    throw new Error('invalid_research_source_or_dates')
  }
  const source = await execGet<{ request_json: string }>(
    'SELECT request_json FROM historical_trigger_scan_jobs WHERE id=?', [sourceId])
  if (!source) throw new Error('research_source_job_not_found')
  const sourceRequest = JSON.parse(source.request_json) as TriggerHistoricalScanRequest
  const request = { ...sourceRequest, startDate, endDate,
    ...(enableBelowZone ? { belowZoneToleranceEnabled: true, maxBelowZonePct: 3 } : {}) }
  delete request.eventOffset
  delete request.eventLimit
  const sessions = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [startDate, endDate],
  )).map((row) => row.date)
  if (!sessions.length || sessions[0] !== startDate || sessions.at(-1) !== endDate) {
    throw new Error('research_range_must_start_and_end_on_market_sessions')
  }
  const sourceFingerprint = await historicalScanSourceFingerprint()
  const id = randomUUID()
  const paths = historicalScanResultPaths(id)
  await mkdir(path.dirname(paths.events), { recursive: true })
  const stream = createWriteStream(paths.eventsTemp, { encoding: 'utf8', flags: 'wx' })
  const eventsHash = createHash('sha256')
  const started = performance.now()
  try {
    const result = await runResearchLongScan({
      request, sessions, chunkSessions,
      onEvents: async (_date, events) => {
        if (!events.length) return
        const payload = events.map((event) => `${JSON.stringify(event)}\n`).join('')
        eventsHash.update(payload)
        if (!stream.write(payload)) await once(stream, 'drain')
      },
      onChunk: async (index, response) => {
        const current = await historicalScanSourceFingerprint()
        if (current !== sourceFingerprint) throw new Error('research_source_changed_during_scan')
        process.stdout.write(`${JSON.stringify({ chunk: index + 1,
          through: response.scanMeta.resolvedEndDate,
          days: response.scanMeta.tradingDayCount,
          totalMs: response.performance.totalMs,
          sourceRows: response.performance.sourceRows,
          peakHeapBytes: response.performance.peakHeapBytes,
          peakRssBytes: response.performance.peakRssBytes })}\n`)
        if (global.gc) global.gc()
      },
    })
    stream.end()
    await once(stream, 'finish')
    const eventsSha256 = eventsHash.digest('hex')
    result.response.researchProvenance = {
      mode: 'RESEARCH_LONG_RANGE_CHUNKED', version: RESEARCH_LONG_SCAN_VERSION,
      sourceDateRange: { start: sessions[0], end: sessions.at(-1)! },
      chunkSessions, chunkRanges: result.chunkRanges,
      engineVersion: String(TRIGGER_ENGINE_VERSION),
      sourceFingerprint, eventsSha256,
    }
    await writeFile(paths.manifestTemp, JSON.stringify(result.response), { flag: 'wx' })
    if (await historicalScanSourceFingerprint() !== sourceFingerprint) {
      throw new Error('research_source_changed_before_registration')
    }
    await rename(paths.eventsTemp, paths.events)
    await rename(paths.manifestTemp, paths.manifest)
    const [manifestStat, eventsStat] = await Promise.all([stat(paths.manifest), stat(paths.events)])
    const storedRequest = { ...request, researchLongRange: true }
    const requestJson = JSON.stringify(storedRequest)
    const now = Math.floor(Date.now() / 1_000)
    await execRun(`INSERT INTO historical_trigger_scan_jobs (
      id,status,request_json,request_signature,source_fingerprint,
      requested_start,requested_end,resolved_start,resolved_end,timeframe,
      created_at,started_at,completed_at,heartbeat_at,total_trading_days,
      processed_trading_days,result_location,result_size_bytes,duration_ms,
      serialization_ms,expires_at
    ) VALUES (?,'COMPLETED',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, requestJson, historicalScanResultSignature(requestJson), sourceFingerprint,
      startDate, endDate, sessions[0], sessions.at(-1)!, result.response.scanMeta.timeframe,
      now, now, now, now, sessions.length, sessions.length, id,
      manifestStat.size + eventsStat.size, performance.now() - started, 0,
      now + 90 * 86_400,
    ])
    process.stdout.write(`${JSON.stringify({ researchJobId: id,
      timeframe: result.response.scanMeta.timeframe, sessions: sessions.length,
      events: result.response.summary.totalEventCount,
      candidates: result.response.summary.uniqueCandidateCount,
      chunkRanges: result.chunkRanges, eventsSha256,
      artifactBytes: manifestStat.size + eventsStat.size,
      totalMs: performance.now() - started })}\n`)
  } catch (error) {
    stream.destroy()
    await Promise.all([rm(paths.eventsTemp, { force: true }), rm(paths.manifestTemp, { force: true })])
    throw error
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
