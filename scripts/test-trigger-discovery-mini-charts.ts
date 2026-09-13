import assert from 'node:assert/strict'
import {
  getTriggerDiscoveryMiniCharts,
  parseTriggerDiscoveryMiniChartsRequest,
  TriggerDiscoveryMiniChartInputError,
  type TriggerDiscoveryMiniChartDataSource,
} from '@/lib/server/trigger-discovery-mini-charts'
import type { OHLCV } from '@/types/stock'

const RESOLVED_AS_OF = '2026-09-04'

function monthlyRows(ticker: string, count = 150): Array<OHLCV & { ticker: string }> {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`${RESOLVED_AS_OF}T00:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() - (count - 1 - index))
    date.setUTCDate(index === count - 1 ? 4 : 20)
    const close = 100 + index * 0.5
    return { ticker, date: date.toISOString().slice(0, 10), open: close, high: close, low: close, close, volume: 1_000 }
  })
}

class FixtureSource implements TriggerDiscoveryMiniChartDataSource {
  resolveCalls = 0
  loadCalls = 0
  requestedTickers: string[][] = []

  async resolveAsOf() {
    this.resolveCalls += 1
    return { value: RESOLVED_AS_OF, queryCount: 1, queryMs: 1 }
  }

  async loadOhlcv(input: { tickers: string[]; fromDate: string; throughDate: string }) {
    this.loadCalls += 1
    this.requestedTickers.push(input.tickers)
    const rows = input.tickers.flatMap((ticker) => ticker === '9999'
      ? []
      : monthlyRows(ticker, ticker === '1002' ? 10 : 150))
    rows.push({ ticker: input.tickers[0], date: '2026-09-07', open: 999, high: 999, low: 999, close: 999, volume: 1_000 })
    return { value: rows, queryCount: 1, queryMs: 2 }
  }

  async loadBiweeklyPoints(input: {
    tickers: string[]
    throughDate: string
    ma1Period: number
    ma2Period: number
    displayPoints: number
  }) {
    const value = new Map(input.tickers.filter((ticker) => ticker !== '9999').map((ticker) => [
      ticker,
      ticker === '1002' ? [] : Array.from({ length: input.displayPoints }, (_, index) => {
        const date = new Date(`${input.throughDate}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() - (input.displayPoints - 1 - index) * 14)
        return {
          date: date.toISOString().slice(0, 10),
          close: 100 + index,
          ma1: 90 + index,
          ma2: 85 + index,
        }
      }),
    ]))
    return {
      value,
      tickersWithPrices: new Set(input.tickers.filter((ticker) => ticker !== '9999')),
      queryCount: 3,
      queryMs: 3,
      biweekly: {
        latestPriceQueryMs: 1,
        weeklyHistoryQueryMs: 1,
        currentWeekQueryMs: 1,
        weeklyAssemblyMs: 0.2,
        biweeklyAggregationMs: 0.3,
        maCalculationMs: 0.4,
      },
    }
  }
}

function tickers(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(1100 + index))
}

async function main() {
  for (const count of [1, 25, 50, 100]) {
    const parsed = parseTriggerDiscoveryMiniChartsRequest({
      tickers: tickers(count), requestedAsOf: '2026-09-06', ma1Period: 20, ma2Period: 25,
    })
    assert.equal(parsed.tickers.length, count)
    assert.equal(parsed.timeframe, 'MONTHLY')
    assert.equal(parsed.displayPoints, 36)
  }
  assert.throws(() => parseTriggerDiscoveryMiniChartsRequest({
    tickers: tickers(101), requestedAsOf: '2026-09-06', ma1Period: 20, ma2Period: 25,
  }), TriggerDiscoveryMiniChartInputError)
  assert.throws(() => parseTriggerDiscoveryMiniChartsRequest({
    tickers: ['bad ticker'], requestedAsOf: '2026-09-06', ma1Period: 20, ma2Period: 25,
  }), TriggerDiscoveryMiniChartInputError)
  assert.throws(() => parseTriggerDiscoveryMiniChartsRequest({
    tickers: ['1001'], requestedAsOf: '2026-09-06', timeframe: 'WEEKLY', ma1Period: 20, ma2Period: 25,
  }), TriggerDiscoveryMiniChartInputError)

  const duplicate = parseTriggerDiscoveryMiniChartsRequest({
    tickers: ['1001', ' 1001 ', '617a'], requestedAsOf: '2026-09-06', ma1Period: 20, ma2Period: 25,
  })
  assert.deepEqual(duplicate.tickers, ['1001', '617A'])

  const source = new FixtureSource()
  const result = await getTriggerDiscoveryMiniCharts({
    tickers: ['1001', '1001', '1002', '9999'],
    requestedAsOf: '2026-09-06',
    ma1Period: 20,
    ma2Period: 25,
  }, { dataSource: source })
  assert.equal(result.resolvedAsOf, RESOLVED_AS_OF, 'weekend resolves to the prior available market date')
  assert.equal(result.timeframe, 'MONTHLY')
  assert.equal(result.displayPoints, 36)
  assert.equal(result.performance.queryCount, 2, 'batch size does not change the constant query count')
  assert.equal(source.resolveCalls, 1)
  assert.equal(source.loadCalls, 1)
  assert.deepEqual(source.requestedTickers, [['1001', '1002', '9999']], 'duplicate tickers are loaded once')
  assert.equal(result.charts.length, 3)
  assert.equal(result.charts.find((chart) => chart.ticker === '1001')?.availability, 'available')
  assert.equal(result.charts.find((chart) => chart.ticker === '1002')?.availability, 'insufficient_history')
  assert.equal(result.charts.find((chart) => chart.ticker === '9999')?.availability, 'missing')
  assert.ok(result.charts.every((chart) => chart.points.every((point) => point.date <= RESOLVED_AS_OF)), 'future OHLCV is excluded before chart calculation')
  assert.equal(result.charts.find((chart) => chart.ticker === '1001')?.latestPointDate, RESOLVED_AS_OF)
  assert.equal(result.charts.find((chart) => chart.ticker === '1001')?.points.length, 36)

  const biweekly = await getTriggerDiscoveryMiniCharts({
    tickers: ['1001', '1002', '9999'],
    requestedAsOf: RESOLVED_AS_OF,
    timeframe: 'BIWEEKLY',
    ma1Period: 20,
    ma2Period: 25,
  }, { dataSource: new FixtureSource() })
  assert.equal(biweekly.timeframe, 'BIWEEKLY')
  assert.equal(biweekly.displayPoints, 36)
  assert.equal(biweekly.performance.queryCount, 4)
  assert.ok(biweekly.performance.biweekly)
  assert.equal(biweekly.charts.find((chart) => chart.ticker === '1001')?.availability, 'available')
  assert.equal(biweekly.charts.find((chart) => chart.ticker === '1001')?.points.length, 36)
  assert.equal(biweekly.charts.find((chart) => chart.ticker === '1002')?.availability, 'insufficient_history')
  assert.equal(biweekly.charts.find((chart) => chart.ticker === '9999')?.availability, 'missing')
  assert.ok(biweekly.charts.every((chart) => chart.points.every((point) => point.date <= RESOLVED_AS_OF)))

  for (const [ma1Period, ma2Period] of [[10, 20], [20, 50], [50, 100]]) {
    const arbitrary = await getTriggerDiscoveryMiniCharts({
      tickers: ['1001'], requestedAsOf: RESOLVED_AS_OF, ma1Period, ma2Period,
    }, { dataSource: new FixtureSource() })
    assert.equal(arbitrary.charts[0].availability, 'available', `${ma1Period}/${ma2Period} arbitrary MA pair`)
    assert.ok(arbitrary.charts[0].points.at(-1)?.ma1 != null)
    assert.ok(arbitrary.charts[0].points.at(-1)?.ma2 != null)
  }

  console.log('trigger discovery Mini Chart tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
