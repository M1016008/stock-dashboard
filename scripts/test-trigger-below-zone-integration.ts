import assert from 'node:assert/strict'
import { getTriggerDiscoveryOptions } from '@/lib/server/trigger-discovery-options'
import { getTriggerDiscovery, type TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import { getTriggerHistoricalScan } from '@/lib/server/trigger-discovery-historical-scan'

async function main() {
const timeframe = 'BIWEEKLY' as const
const pair = { ma1Period: 25, ma2Period: 44 }
const asOf = process.env.TRIGGER_BELOW_AS_OF ?? (await getTriggerDiscoveryOptions()).latestAsOf
assert.ok(asOf, 'a latest price date is required')

const cases: Array<{ label: string; enabled: boolean; max: number }> = [
  { label: 'OFF', enabled: false, max: 3 },
  ...[1, 2, 3, 5].map((max) => ({ label: `${max}%`, enabled: true, max })),
]
const results = []
for (const item of cases) {
  const result = await getTriggerDiscovery({
    asOf,
    triggerConfig: { ...pair, belowZoneToleranceEnabled: item.enabled, maxBelowZonePct: item.max },
    limit: 10_000,
  }, { timeframe })
  const below = result.rows.filter((row) => row.triggerStatus === 'BELOW_ZONE')
  for (const row of below) {
    assert.equal(row.fromAbove, true)
    assert.equal(row.bothRising, true)
    assert.ok(row.zoneDistancePct < 0 && row.zoneDistancePct + item.max >= -1e-9)
    assert.equal(row.maDate <= asOf, true)
    assert.equal(row.priceDate <= asOf, true)
  }
  if (!item.enabled) assert.equal(below.length, 0)
  results.push({
    label: item.label, matched: result.totalMatched, below: below.length,
    representatives: below.slice(0, 6).map((row) => `${row.ticker} ${row.companyName} ${row.zoneDistancePct.toFixed(3)}%`),
    durationMs: result.diagnostics.performance.totalMs,
    queries: result.diagnostics.performance.queryCount,
    rows: result.rows,
  })
  console.log(JSON.stringify({ condition: item.label, matched: result.totalMatched, below: below.length,
    representatives: results.at(-1)?.representatives, durationMs: result.diagnostics.performance.totalMs,
    queries: result.diagnostics.performance.queryCount }))
}
for (let index = 1; index < results.length; index += 1) {
  const previous = new Set(results[index - 1].rows.map((row) => row.ticker))
  const current = new Set(results[index].rows.map((row) => row.ticker))
  assert.ok([...previous].every((ticker) => current.has(ticker)), 'wider tolerance must only add candidates')
}

const columns = (row: TriggerDiscoveryRow) => ({
  ticker: row.ticker, status: row.triggerStatus, score: row.triggerScore,
  price: row.price, ma1: row.ma1Value, ma2: row.ma2Value,
  zone: row.zoneDistancePct, spread: row.maSpreadPct,
  stages: [row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage],
})
const legacy = await getTriggerDiscovery({ asOf, triggerConfig: pair, limit: 10_000 }, { timeframe })
assert.deepEqual(legacy.rows.map(columns), results[0].rows.map(columns), 'missing field must match explicit OFF')

if (process.env.TRIGGER_BELOW_PERIOD_PARITY === '1') {
  const startDate = process.env.TRIGGER_BELOW_START_DATE ?? '2026-08-03'
  const endDate = process.env.TRIGGER_BELOW_END_DATE ?? '2026-08-31'
  const config = { ...pair, belowZoneToleranceEnabled: true, maxBelowZonePct: 3 }
  const byDate = new Map<string, TriggerDiscoveryRow[]>()
  const period = await getTriggerHistoricalScan({
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    timeframe,
    criteria: { triggerConfig: config },
    eventOffset: 0,
    eventLimit: 10,
  }, { onDay: (day, rows) => { byDate.set(day, rows) } })
  assert.ok(period.dailyCounts.length >= 20, 'period parity requires about 20 market sessions')
  for (const { date, candidateCount } of period.dailyCounts) {
    const single = await getTriggerDiscovery({ asOf: date, triggerConfig: config, limit: 10_000 }, { timeframe })
    assert.equal(single.resolvedAsOf, date)
    assert.equal(candidateCount, single.totalMatched, `${date} count`)
    const periodRows = byDate.get(date) ?? []
    const singles = new Map(single.rows.map((row) => [row.ticker, row]))
    assert.deepEqual(periodRows.map((row) => row.ticker).sort(), [...singles.keys()].sort(), `${date} ticker set`)
    for (const row of periodRows) {
      const other = singles.get(row.ticker)!
      assert.equal(row.triggerStatus, other.triggerStatus, `${date} ${row.ticker} status`)
      assert.equal(row.triggerScore, other.triggerScore, `${date} ${row.ticker} score`)
      assert.deepEqual(columns(row).stages, columns(other).stages, `${date} ${row.ticker} stage`)
      for (const field of ['price', 'ma1Value', 'ma2Value', 'zoneDistancePct'] as const) {
        const expected = other[field]
        assert.ok(Math.abs(row[field] - expected) <= Math.max(1, Math.abs(expected)) * 1e-9,
          `${date} ${row.ticker} ${field}`)
      }
    }
    console.log(JSON.stringify({ parityDate: date, candidates: candidateCount,
      below: periodRows.filter((row) => row.triggerStatus === 'BELOW_ZONE').length }))
  }
}
console.log('Trigger Below Zone integration passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
