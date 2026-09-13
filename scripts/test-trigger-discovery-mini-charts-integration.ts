import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { getTriggerDiscoveryMiniCharts } from '@/lib/server/trigger-discovery-mini-charts'
import { getTriggerDiscovery } from '@/lib/server/trigger-discovery-read-model'

function closeEnough(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9
}

async function main() {
  const search = await getTriggerDiscovery({
    asOf: '2026-09-07',
    triggerConfig: { ma1Period: 20, ma2Period: 25 },
    limit: 100,
  })
  assert.ok(search.rows.length >= 100, 'fixture date must provide 100 Trigger candidates')

  for (const size of [25, 50, 100]) {
    const startedAt = performance.now()
    const result = await getTriggerDiscoveryMiniCharts({
      tickers: search.rows.slice(0, size).map((row) => row.ticker),
      requestedAsOf: '2026-09-07',
      ma1Period: 20,
      ma2Period: 25,
    })
    const serialized = JSON.stringify(result)
    assert.equal(result.charts.length, size)
    assert.equal(result.performance.queryCount, 2)
    assert.ok(result.charts.every((chart) => chart.points.every((point) => point.date <= '2026-09-07')))
    console.log(JSON.stringify({
      batchSize: size,
      dbQueryMs: result.performance.dbQueryMs,
      maCalculationMs: result.performance.maCalculationMs,
      readModelTotalMs: result.performance.totalMs,
      measuredTotalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      payloadBytes: Buffer.byteLength(serialized),
      queryCount: result.performance.queryCount,
    }))
  }

  const sampleRows = search.rows.slice(0, 25)
  const mini = await getTriggerDiscoveryMiniCharts({
    tickers: sampleRows.map((row) => row.ticker),
    requestedAsOf: '2026-09-07',
    ma1Period: 20,
    ma2Period: 25,
  })
  const chartByTicker = new Map(mini.charts.map((chart) => [chart.ticker, chart]))
  for (const row of sampleRows) {
    const latest = chartByTicker.get(row.ticker)?.points.at(-1)
    assert.ok(latest, `${row.ticker} Mini Chart latest point`)
    assert.equal(latest.date, row.maDate, `${row.ticker} MA date`)
    assert.ok(closeEnough(latest.close, row.price), `${row.ticker} close`)
    assert.ok(closeEnough(latest.ma1, row.ma1Value), `${row.ticker} MA1`)
    assert.ok(closeEnough(latest.ma2, row.ma2Value), `${row.ticker} MA2`)
  }

  for (const [ma1Period, ma2Period] of [[10, 20], [20, 50], [50, 100]]) {
    const result = await getTriggerDiscoveryMiniCharts({
      tickers: ['7003', '7203'],
      requestedAsOf: '2026-09-07',
      ma1Period,
      ma2Period,
    })
    assert.ok(result.charts.every((chart) => chart.availability === 'available'), `${ma1Period}/${ma2Period} availability`)
    assert.ok(result.charts.every((chart) => chart.points.at(-1)?.ma1 != null && chart.points.at(-1)?.ma2 != null))
  }

  const pit = await getTriggerDiscoveryMiniCharts({
    tickers: ['7003', '7203'],
    requestedAsOf: '2026-08-25',
    ma1Period: 20,
    ma2Period: 25,
  })
  assert.equal(pit.resolvedAsOf, '2026-08-25')
  assert.ok(pit.charts.every((chart) => chart.latestPointDate != null && chart.latestPointDate <= '2026-08-25'))
  assert.ok(pit.charts.every((chart) => chart.points.every((point) => point.date <= '2026-08-25')))

  const weekend = await getTriggerDiscoveryMiniCharts({
    tickers: ['7003'], requestedAsOf: '2026-09-06', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(weekend.resolvedAsOf, '2026-09-04')
  assert.ok(weekend.charts[0].points.every((point) => point.date <= '2026-09-04'))

  const missing = await getTriggerDiscoveryMiniCharts({
    tickers: ['9999'], requestedAsOf: '2026-09-07', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(missing.charts[0].availability, 'missing')

  const biweeklySearch = await getTriggerDiscovery({
    asOf: '2026-09-07',
    triggerConfig: { ma1Period: 20, ma2Period: 25 },
    limit: 100,
  }, { timeframe: 'BIWEEKLY' })
  assert.ok(biweeklySearch.rows.length >= 25, 'Biweekly fixture date must provide 25 Trigger candidates')

  for (const size of [25, 50, 100]) {
    const sample = biweeklySearch.rows.slice(0, Math.min(size, biweeklySearch.rows.length))
    const startedAt = performance.now()
    const result = await getTriggerDiscoveryMiniCharts({
      tickers: sample.map((row) => row.ticker),
      requestedAsOf: '2026-09-07',
      timeframe: 'BIWEEKLY',
      ma1Period: 20,
      ma2Period: 25,
    })
    const serialized = JSON.stringify(result)
    assert.equal(result.timeframe, 'BIWEEKLY')
    assert.equal(result.charts.length, sample.length)
    assert.equal(result.performance.queryCount, 4)
    assert.ok(result.performance.biweekly)
    assert.ok(result.charts.every((chart) => chart.points.length <= 36))
    assert.ok(result.charts.every((chart) => chart.points.every((point) => point.date <= '2026-09-07')))
    console.log(JSON.stringify({
      timeframe: 'BIWEEKLY',
      requestedBatchSize: size,
      actualBatchSize: sample.length,
      latestPriceQueryMs: result.performance.biweekly?.latestPriceQueryMs,
      weeklyHistoryQueryMs: result.performance.biweekly?.weeklyHistoryQueryMs,
      currentWeekQueryMs: result.performance.biweekly?.currentWeekQueryMs,
      biweeklyGenerationMs: (result.performance.biweekly?.weeklyAssemblyMs ?? 0)
        + (result.performance.biweekly?.biweeklyAggregationMs ?? 0),
      maCalculationMs: result.performance.biweekly?.maCalculationMs,
      readModelTotalMs: result.performance.totalMs,
      measuredTotalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      payloadBytes: Buffer.byteLength(serialized),
      queryCount: result.performance.queryCount,
    }))
  }

  const biweeklyRows = biweeklySearch.rows.slice(0, 25)
  const biweeklyMini = await getTriggerDiscoveryMiniCharts({
    tickers: biweeklyRows.map((row) => row.ticker),
    requestedAsOf: '2026-09-07',
    timeframe: 'BIWEEKLY',
    ma1Period: 20,
    ma2Period: 25,
  })
  const biweeklyChartByTicker = new Map(biweeklyMini.charts.map((chart) => [chart.ticker, chart]))
  for (const row of biweeklyRows) {
    const latest = biweeklyChartByTicker.get(row.ticker)?.points.at(-1)
    assert.ok(latest, `${row.ticker} Biweekly Mini Chart latest point`)
    assert.equal(latest.date, row.maDate, `${row.ticker} Biweekly MA date`)
    assert.ok(closeEnough(latest.close, row.price), `${row.ticker} Biweekly close`)
    assert.ok(closeEnough(latest.ma1, row.ma1Value), `${row.ticker} Biweekly MA1`)
    assert.ok(closeEnough(latest.ma2, row.ma2Value), `${row.ticker} Biweekly MA2`)
  }

  const biweeklyPit = await getTriggerDiscoveryMiniCharts({
    tickers: ['7003', '7203'],
    requestedAsOf: '2026-08-25',
    timeframe: 'BIWEEKLY',
    ma1Period: 20,
    ma2Period: 25,
  })
  assert.equal(biweeklyPit.resolvedAsOf, '2026-08-25')
  assert.ok(biweeklyPit.charts.every((chart) => chart.points.every((point) => point.date <= '2026-08-25')))

  console.log('trigger discovery Mini Chart integration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
