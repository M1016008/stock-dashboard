import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import { getOutcomeSegmentation } from '@/lib/server/trigger-discovery-outcome-segmentation'
import type { TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type {
  TriggerOutcomeSegmentDimension, TriggerOutcomeSegmentValue,
} from '@/lib/trigger-discovery-outcome-segmentation'

type AuditCase = { label: string; jobId: string; dimensions: TriggerOutcomeSegmentDimension[] }

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function quantile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? sorted[lower]! : sorted[lower]! * (upper - position)
    + sorted[upper]! * (position - lower)
}

function independentBucket(row: TriggerOutcomeRow, dimension: TriggerOutcomeSegmentDimension): TriggerOutcomeSegmentValue {
  if (dimension === 'scoreBand') {
    const value = row.triggerScore
    return !Number.isFinite(value) || value < 0 || value > 100 ? 'UNKNOWN'
      : value < 40 ? 'LOW' : value < 60 ? 'MID_LOW' : value < 80 ? 'MID_HIGH' : 'HIGH'
  }
  if (dimension === 'spreadExpansion') {
    if (row.snapshotBasis !== 'CURRENT' || !row.spreadDiagnosticDate
      || row.spreadDiagnosticDate > row.eventDate || row.spreadExpansionAvailable !== true
      || typeof row.bullishMaOrder !== 'boolean' || !Number.isFinite(row.maSpreadPct)
      || !Number.isFinite(row.maSpreadSlope) || !Number.isFinite(row.maSpreadExpansionRatio)) return 'UNKNOWN'
    return row.spreadExpansionPass === true ? 'PASS' : row.spreadExpansionPass === false ? 'FAIL' : 'UNKNOWN'
  }
  const axis = dimension.slice('stage:'.length)
  const stage = row[`${axis}Stage` as keyof TriggerOutcomeRow]
  return Number.isInteger(stage) && Number(stage) >= 1 && Number(stage) <= 6
    ? `S${stage}` as TriggerOutcomeSegmentValue : 'UNKNOWN'
}

function equalNumber(actual: number | null, expected: number | null, label: string): void {
  if (actual === null || expected === null) assert.equal(actual, expected, label)
  else assert.ok(Math.abs(actual - expected) <= 1e-10, `${label}: ${actual} vs ${expected}`)
}

function checkGroup(rows: TriggerOutcomeRow[], dimensions: TriggerOutcomeSegmentDimension[],
  group: Awaited<ReturnType<typeof getOutcomeSegmentation>>['segmentation']['groups'][number]): void {
  const selected = rows.filter((row) => dimensions.every(
    (dimension) => independentBucket(row, dimension) === group.keys[dimension],
  ))
  assert.equal(group.eventCount, selected.length)
  assert.equal(group.uniqueTickerCount, new Set(selected.map((row) => row.ticker)).size)
  for (const horizon of group.horizons) {
    const n = horizon.horizonSessions
    const eligible = selected.filter((row) => row[`availability${n}`] === 'AVAILABLE')
    const returns = eligible.map((row) => row[`return${n}`]).filter((value): value is number => value !== null)
    const mfe = eligible.map((row) => row[`mfe${n}`]).filter((value): value is number => value !== null)
    const mae = eligible.map((row) => row[`mae${n}`]).filter((value): value is number => value !== null)
    assert.equal(returns.length, eligible.length, `${n}d eligible return count`)
    assert.equal(horizon.totalEventCount, selected.length)
    assert.equal(horizon.eligibleCount, eligible.length)
    assert.equal(horizon.unavailableCount, selected.length - eligible.length)
    assert.equal(horizon.smallSample, eligible.length < 30)
    equalNumber(horizon.meanReturn, returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null, 'mean')
    equalNumber(horizon.medianReturn, quantile(returns, .5), 'median')
    equalNumber(horizon.positiveReturnRatio, returns.length
      ? returns.filter((value) => value > 0).length / returns.length : null, 'positive')
    equalNumber(horizon.p25Return, quantile(returns, .25), 'q25')
    equalNumber(horizon.p75Return, quantile(returns, .75), 'q75')
    equalNumber(horizon.medianMfe, quantile(mfe, .5), 'mfe')
    equalNumber(horizon.medianMae, quantile(mae, .5), 'mae')
  }
}

function csv(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

async function main(): Promise<void> {
  const cases = JSON.parse(process.env.TRIGGER_SEGMENT_QA_CASES ?? '[]') as AuditCase[]
  assert.ok(cases.length > 0 && cases.length <= 12, 'provide 1-12 QA cases')
  const records: unknown[][] = [[
    'case', 'timeframe', 'eventSelector', 'sourceJobId', 'dimensions', 'cell', 'eventCount',
    'uniqueTickerCount', 'horizonSessions', 'eligibleCount', 'unavailableCount', 'smallSample',
    'meanReturn', 'medianReturn', 'positiveReturnRatio', 'q25Return', 'q75Return', 'medianMfe', 'medianMae',
  ]]
  const summary: Array<Record<string, unknown>> = []
  for (const item of cases) {
    const source = outcomeResultPaths(item.jobId).rowsByDate
    const before = await readFile(source)
    const sourceHash = hash(before)
    const result = await getOutcomeSegmentation({ outcomeJobId: item.jobId, dimensions: item.dimensions })
    const rows = before.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as TriggerOutcomeRow)
    assert.equal(hash(await readFile(source)), sourceHash, `${item.label}: source changed`)
    assert.equal(result.overall.selectedEventCount, rows.length)
    assert.equal(result.integrity.eventCountMatchesOverall, true)
    assert.ok(Object.values(result.integrity.eligibleCountsMatchOverall).every(Boolean))
    assert.ok(Object.values(result.integrity.weightedMeanMatchesOverall).every(Boolean))
    for (const group of result.segmentation.groups) {
      checkGroup(rows, item.dimensions, group)
      for (const horizon of group.horizons) records.push([
        item.label, result.meta.source.timeframe, result.meta.source.eventSelector,
        item.jobId, item.dimensions.join(' x '), JSON.stringify(group.keys),
        group.eventCount, group.uniqueTickerCount, horizon.horizonSessions, horizon.eligibleCount,
        horizon.unavailableCount, horizon.smallSample, horizon.meanReturn, horizon.medianReturn,
        horizon.positiveReturnRatio, horizon.p25Return, horizon.p75Return,
        horizon.medianMfe, horizon.medianMae,
      ])
    }
    summary.push({ label: item.label, dimensions: item.dimensions, timeframe: result.meta.source.timeframe,
      eventSelector: result.meta.source.eventSelector, events: rows.length,
      uniqueTickers: result.overall.uniqueTickerCount, cells: result.segmentation.groups.length,
      hash: sourceHash, performance: result.meta.performance, source: result.meta.source,
      spreadDiagnosticsStatus: result.meta.spreadDiagnosticsStatus ?? null })
  }
  const root = join(process.cwd(), 'docs')
  await writeFile(join(root, 'phase-12d1-segmentation-real-results.csv'), `${records.map((record) => record.map(csv).join(',')).join('\n')}\n`)
  await writeFile(join(root, 'phase-12d1-segmentation-real-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.map(({ label, events, cells, performance }) => ({ label, events, cells, performance }))))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
