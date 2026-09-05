import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { FINANCIAL_TIMELINE_METRICS } from '@/lib/financial-performance-timeline'
import { getFinancialPerformanceTimelineReadModel } from '@/lib/server/financial-performance-timeline-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const

async function main() {
  const asOf = '2026-08-21'
  const cutoff = normalizeAsOf(asOf)
  const models = new Map<string, Awaited<ReturnType<typeof getFinancialPerformanceTimelineReadModel>>>()

  for (const ticker of TICKERS) {
    const model = await getFinancialPerformanceTimelineReadModel(ticker, asOf)
    models.set(ticker, model)
    assert.equal(model.contractVersion, 'financial-performance-timeline-v1')
    assert.equal(model.asOf, asOf)
    assert.ok(model.coverage.facts > 0, `${ticker}: facts are required`)
    for (const series of Object.values(model.modes)) {
      assert.ok(series.periods.length > 0, `${ticker}: ${series.mode} should have periods`)
      assert.deepEqual(
        [...series.periods].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).map((period) => period.key),
        series.periods.map((period) => period.key),
        `${ticker}: ${series.mode} periods must be chronological`,
      )
      for (const period of series.periods) {
        assert.ok(period.publishedAt <= cutoff, `${ticker}: period leaked after as_of`)
        for (const metric of FINANCIAL_TIMELINE_METRICS) {
          const value = period.metrics[metric]
          if (!value) continue
          assert.ok(Number.isFinite(value.value), `${ticker}: ${metric} must be finite`)
          assert.ok(value.publishedAt <= cutoff, `${ticker}: ${metric} leaked after as_of`)
          assert.ok(value.inputIds.length > 0, `${ticker}: ${metric} must be reproducible`)
          if (value.revision) {
            assert.ok(value.revision.previousPublishedAt < value.publishedAt)
          }
        }
      }
    }
    assert.ok(model.modes.STANDALONE.periods.some((period) => period.metrics.eps_basic?.source === 'calculated'), `${ticker}: standalone EPS should be derived from matching period inputs`)
    assert.ok(model.modes.LTM.periods.some((period) => period.metrics.eps_basic?.source === 'calculated'), `${ticker}: LTM EPS should be derived from matching period inputs`)
  }

  const toyota = models.get('7203')!
  const latestForecast = toyota.modes.FY.periods.find((period) => period.pointType === 'current_forecast')
  assert.equal(latestForecast?.targetFiscalYear, 2027)
  assert.equal(latestForecast?.metrics.revenue?.value, 54_000_000_000_000)
  assert.equal(latestForecast?.metrics.revenue?.revision?.previousValue, 51_000_000_000_000)
  assert.ok((latestForecast?.metrics.revenue?.revision?.ratePercent ?? 0) > 5)

  const pit = await getFinancialPerformanceTimelineReadModel('7203', '2026-06-30')
  const pitForecasts = pit.modes.FY.periods.filter((period) => period.pointType !== 'actual')
  assert.equal(pitForecasts.length, 1)
  assert.equal(pitForecasts[0].pointType, 'next_forecast')
  assert.equal(pitForecasts[0].metrics.revenue?.value, 51_000_000_000_000)
  assert.ok(pitForecasts.every((period) => period.publishedAt <= normalizeAsOf('2026-06-30')))

  assert.equal(models.get('8306')!.modes.FY.periods.some((period) => period.pointType !== 'actual'), false, 'bank has no company forecast snapshots and must not be zero-filled')
  assert.equal(models.get('4755')!.modes.FY.periods.some((period) => period.pointType !== 'actual'), false, 'loss-making company has no company forecast snapshots and must not be zero-filled')
  assert.ok(models.get('4502')!.modes.FY.periods.some((period) => period.accountingStandard === 'IFRS'))
  assert.ok(models.get('7974')!.modes.FY.periods.some((period) => period.accountingStandard === 'JGAAP'))

  console.log('Financial performance timeline tests passed')
}

main().catch((error) => {
  console.error('Financial performance timeline tests failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
