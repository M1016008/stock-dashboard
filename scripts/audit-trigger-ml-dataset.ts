import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { execAll } from '@/lib/db/client'
import { historicalScanResultPaths, historicalEventKey } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { getMlDatasetJob, mlDatasetPaths } from '@/lib/server/trigger-ml-dataset-jobs'
import { getPathResearchArtifact } from '@/lib/server/trigger-path-research-jobs'
import { TRIGGER_ML_CHECKPOINTS, TRIGGER_ML_FEATURE_REGISTRY, validateTriggerMlRow,
  type TriggerMlDatasetRow, type TriggerMlStage } from '@/lib/trigger-ml-dataset-contract'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'

const id = process.argv[2]
if (!id) throw new Error('usage: tsx scripts/audit-trigger-ml-dataset.ts <dataset-id>')

async function readLines<T>(file: string): Promise<T[]> {
  const rows: T[] = []
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of reader) if (line) rows.push(JSON.parse(line) as T)
  return rows
}
function close(actual: number | null, expected: number, name: string) {
  assert.ok(actual != null && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${name}: ${actual} !== ${expected}`)
}
function asStage(value: number | null): TriggerMlStage {
  return value && value >= 1 && value <= 6 ? `S${value}` as TriggerMlStage : 'UNKNOWN'
}

async function main() {
  const job = await getMlDatasetJob(id)
  assert.equal(job?.status, 'COMPLETED')
  const manifest = job.manifest!
  const { rows: rowsFile } = mlDatasetPaths(id)
  const hash = createHash('sha256')
  const counts = Object.fromEntries(TRIGGER_ML_CHECKPOINTS.map((checkpoint) => [checkpoint, 0]))
  const samples = new Map(TRIGGER_ML_CHECKPOINTS.map((checkpoint) => [checkpoint, new Map<string, TriggerMlDatasetRow>()]))
  const byEpisode = new Map<string, string>()
  const byEvent = new Map<string, string>()
  let count = 0
  const reader = createInterface({ input: createReadStream(rowsFile), crlfDelay: Infinity })
  for await (const line of reader) {
    if (!line) continue
    hash.update(`${line}\n`)
    const row = JSON.parse(line) as TriggerMlDatasetRow
    validateTriggerMlRow(row)
    count += 1
    counts[row.checkpoint] += 1
    assert.equal(row.datasetRowId, `${id}:${row.eventKey}:${row.checkpoint}`)
    assert.equal(byEvent.get(row.eventKey) ?? row.split, row.split)
    byEvent.set(row.eventKey, row.split)
    const episodeId = row.episodeKey ?? `event:${row.eventKey}`
    assert.equal(byEpisode.get(episodeId) ?? row.split, row.split)
    byEpisode.set(episodeId, row.split)
    const selected = samples.get(row.checkpoint)!
    if (selected.size < 30 && !selected.has(row.ticker)) selected.set(row.ticker, row)
  }
  assert.equal(hash.digest('hex'), manifest.datasetSha256)
  assert.equal(count, manifest.rowCount)
  assert.deepEqual(counts, manifest.rowsByCheckpoint)
  assert.equal(byEvent.size, manifest.eventCount)
  assert.equal(byEpisode.size, manifest.episodeCount)
  assert.ok(TRIGGER_ML_FEATURE_REGISTRY.every((column) => !/volume|liquidity|turnover|tradingvalue|outcome|future/i.test(column.name)))
  for (const checkpoint of ['D0', 'D3', 'D5', 'D10', 'D20'] as const) {
    assert.ok(samples.get(checkpoint)!.size >= 30, `${checkpoint} has fewer than 30 distinct-ticker QA samples`)
  }
  for (const checkpoint of ['LOWER_RECLAIM', 'UPPER_RECLAIM'] as const) {
    assert.ok(samples.get(checkpoint)!.size >= 10, `${checkpoint} has fewer than 10 distinct-ticker QA samples`)
  }
  const sampled = [...samples.values()].flatMap((values) => [...values.values()])
  const tickers = [...new Set(sampled.map((row) => row.ticker))]
  const market = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [manifest.eventDateMin, manifest.analysisCutoffDate],
  )).map((row) => row.date)
  type Price = { ticker: string; date: string; high: number; low: number; close: number }
  const prices: Price[] = []
  for (let index = 0; index < tickers.length; index += 25) {
    const chunk = tickers.slice(index, index + 25)
    prices.push(...await execAll<Price>(`SELECT ticker,date,high,low,close FROM ohlcv_daily
      WHERE ticker IN (${chunk.map(() => '?').join(',')}) AND date BETWEEN ? AND ?`,
    [...chunk, manifest.eventDateMin, manifest.analysisCutoffDate]))
  }
  const pricesByKey = new Map(prices.map((row) => [`${row.ticker}:${row.date}`, row]))
  type Stage = { ticker: string; date: string; daily_a_stage: number | null; daily_b_stage: number | null;
    weekly_a_stage: number | null; weekly_b_stage: number | null;
    monthly_a_stage: number | null; monthly_b_stage: number | null }
  const stages = await execAll<Stage>(`WITH requested AS
      (SELECT json_extract(value,'$.ticker') AS ticker,json_extract(value,'$.date') AS date FROM json_each(?))
    SELECT s.ticker,s.date,s.daily_a_stage,s.daily_b_stage,s.weekly_a_stage,s.weekly_b_stage,
      s.monthly_a_stage,s.monthly_b_stage FROM requested r
    JOIN daily_snapshots s ON s.ticker=r.ticker AND s.date=r.date`,
  [JSON.stringify(sampled.map((row) => ({ ticker: row.ticker, date: row.featureAsOfDate })))])
  const stagesByKey = new Map(stages.map((row) => [`${row.ticker}:${row.date}`, row]))
  const path = await getPathResearchArtifact(manifest.sourcePathResearchJobId)
  assert.ok(path && typeof path === 'object')
  const pathRows = new Map((await readLines<PathResearchRow>(path.rowsFile)).map((row) => [row.eventKey, row]))
  const events = await readLines<TriggerHistoricalScanEvent>(
    historicalScanResultPaths(manifest.sourceHistoricalScanJobId).events)
  const eventsByKey = new Map(events.map((row, index) => [historicalEventKey(index), row]))
  let checkedLabels = 0
  let d0Equivalent = 0
  let d5Different = 0
  for (const row of sampled) {
    const saved = eventsByKey.get(row.eventKey)!
    assert.ok(saved)
    if (row.checkpoint === 'D0') {
      close(row.eventFeature.anchorPrice, saved.price, 'saved event price')
      close(row.eventFeature.ma1, saved.ma1, 'saved MA1')
      close(row.eventFeature.ma2, saved.ma2, 'saved MA2')
      close(row.sourceAudit.savedScoreAtHit, saved.triggerScore, 'saved Trigger Score')
      assert.deepEqual(row.sourceAudit.savedScoreBreakdown, {
        proximity: saved.scoreBreakdown.proximity, approach: saved.scoreBreakdown.approach,
        maTrend: saved.scoreBreakdown.maTrend, stageStructure: saved.scoreBreakdown.stageStructure,
        liquidity: saved.scoreBreakdown.liquidity,
      })
      close(row.eventFeature.scoreWithoutFlowComponent,
        saved.scoreBreakdown.proximity + saved.scoreBreakdown.approach
          + saved.scoreBreakdown.maTrend + saved.scoreBreakdown.stageStructure, 'flow-free score')
      close(row.eventFeature.zoneDistancePct, saved.zoneDistancePct, 'saved Zone distance')
      assert.equal(row.eventFeature.spreadPct, saved.maSpreadPct ?? null)
      assert.equal(row.eventFeature.spreadExpansionRatio, saved.maSpreadExpansionRatio ?? null)
      assert.equal(row.eventFeature.dayAStage, asStage(saved.dayAStage))
      assert.equal(row.eventFeature.dayBStage, asStage(saved.dayBStage))
      assert.equal(row.eventFeature.weekAStage, asStage(saved.weekAStage))
      assert.equal(row.eventFeature.weekBStage, asStage(saved.weekBStage))
      assert.equal(row.eventFeature.monthAStage, asStage(saved.monthAStage))
      assert.equal(row.eventFeature.monthBStage, asStage(saved.monthBStage))
      assert.deepEqual(row.outcomeLabel.eventAnchored.map((label) => label.return),
        [20, 60, 120, 245].map((h) => pathRows.get(row.eventKey)!.outcome[`return${h}` as 'return20']))
      assert.deepEqual(row.outcomeLabel.eventAnchored.map((label) => label.mfe),
        [20, 60, 120, 245].map((h) => pathRows.get(row.eventKey)!.outcome[`mfe${h}` as 'mfe20']))
      assert.deepEqual(row.outcomeLabel.eventAnchored.map((label) => label.mae),
        [20, 60, 120, 245].map((h) => pathRows.get(row.eventKey)!.outcome[`mae${h}` as 'mae20']))
      if (saved.snapshotBasis === 'CURRENT' && saved.priceDate === saved.date
        && pricesByKey.get(`${row.ticker}:${row.eventDate}`)?.close === saved.price) {
        assert.deepEqual(row.outcomeLabel.eventAnchored, row.outcomeLabel.snapshotForward)
        d0Equivalent += 1
      }
    } else {
      const s = stagesByKey.get(`${row.ticker}:${row.featureAsOfDate}`)
      assert.equal(row.pathSnapshot.dayAStageAsOf, asStage(s?.daily_a_stage ?? null))
      assert.equal(row.pathSnapshot.monthBStageAsOf, asStage(s?.monthly_b_stage ?? null))
      if (row.checkpoint === 'D5' && JSON.stringify(row.outcomeLabel.eventAnchored)
        !== JSON.stringify(row.outcomeLabel.snapshotForward)) d5Different += 1
    }
    const eventMarket = market.indexOf(row.eventDate)
    const anchorMarket = market.indexOf(row.featureAsOfDate)
    assert.ok(eventMarket >= 0 && anchorMarket >= eventMarket)
    assert.equal(row.checkpoint.startsWith('D') ? anchorMarket - eventMarket : 0,
      row.checkpoint.startsWith('D') ? Number(row.checkpoint.slice(1)) : 0)
    if (row.checkpoint !== 'D0') {
      const soFar = market.slice(eventMarket + 1, anchorMarket + 1)
        .map((date) => pricesByKey.get(`${row.ticker}:${date}`))
      if (soFar.every(Boolean)) {
        const high = Math.max(...soFar.map((price) => price!.high))
        const low = Math.min(...soFar.map((price) => price!.low))
        close(row.pathSnapshot.maxUpsideSoFar, high / saved.price - 1, 'maxUpsideSoFar')
        close(row.pathSnapshot.maxDownsideSoFar, low / saved.price - 1, 'maxDownsideSoFar')
      }
    }
    const anchor = pricesByKey.get(`${row.ticker}:${row.featureAsOfDate}`)
    for (const label of row.outcomeLabel.snapshotForward) {
      if (!label.labelAvailable) continue
      const horizonDate = market[anchorMarket + label.labelHorizonSessions]
      const future = market.slice(anchorMarket + 1, anchorMarket + label.labelHorizonSessions + 1)
        .map((date) => pricesByKey.get(`${row.ticker}:${date}`))
      assert.ok(anchor && horizonDate && future.length === label.labelHorizonSessions
        && future.every(Boolean), 'available label must have complete future OHLCV')
      assert.equal(label.labelAvailableDate, horizonDate)
      close(label.return, future.at(-1)!.close / anchor.close - 1, 'forward return')
      close(label.mfe, Math.max(...future.map((price) => price!.high)) / anchor.close - 1, 'forward mfe')
      close(label.mae, Math.min(...future.map((price) => price!.low)) / anchor.close - 1, 'forward mae')
      checkedLabels += 1
    }
  }
  assert.ok(checkedLabels >= 30 && d0Equivalent >= 30 && d5Different > 0)
  console.log(JSON.stringify({ datasetId: id, rows: count, events: byEvent.size,
    episodes: byEpisode.size, samples: Object.fromEntries([...samples].map(([key, rows]) => [key, rows.size])),
    checkedForwardLabels: checkedLabels, d0Equivalent, d5Different,
    sourceHash: manifest.sourceSha256, datasetHash: manifest.datasetSha256, status: 'PASS' }, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
