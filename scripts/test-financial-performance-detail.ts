import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { FINANCIAL_PERFORMANCE_DETAIL_METRICS } from '@/lib/financial-performance-detail'
import { getFinancialPerformanceDetailReadModel } from '@/lib/server/financial-performance-detail-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const

async function main() {
  const asOf = '2026-08-21'
  const cutoff = normalizeAsOf(asOf)
  const models = new Map<string, Awaited<ReturnType<typeof getFinancialPerformanceDetailReadModel>>>()

  for (const ticker of TICKERS) {
    const model = await getFinancialPerformanceDetailReadModel(ticker, asOf)
    models.set(ticker, model)
    assert.equal(model.contractVersion, 'financial-performance-detail-v1')
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
        for (const metric of FINANCIAL_PERFORMANCE_DETAIL_METRICS) {
          const value = period.metrics[metric]
          if (!value) continue
          assert.ok(Number.isFinite(value.value), `${ticker}: ${metric} must be finite`)
          assert.ok(value.publishedAt <= cutoff, `${ticker}: ${metric} leaked after as_of`)
          assert.ok(value.inputIds.length > 0, `${ticker}: ${metric} must preserve provenance`)
        }
      }
    }
    assert.ok(
      model.modes.FY.periods.some((period) => period.pointType === 'actual' && period.metrics.net_income_attributable),
      `${ticker}: FY net income is required`,
    )
    assert.ok(model.forecastHistory.every((row) => row.publishedAt <= cutoff), `${ticker}: forecast history leaked after as_of`)
  }

  const toyota = models.get('7203')!
  const latestRevision = toyota.forecastHistory[0]
  assert.equal(latestRevision.targetFiscalYear, 2027)
  assert.equal(latestRevision.forecastScope, 'current_fy')
  assert.equal(latestRevision.direction, 'up')
  assert.equal(latestRevision.metrics.revenue?.value, 54_000_000_000_000)
  assert.equal(latestRevision.metrics.revenue?.previousValue, 51_000_000_000_000)
  assert.ok((latestRevision.metrics.revenue?.revisionPercent ?? 0) > 5)
  assert.ok(toyota.summary.profitability.operatingMargin.value != null)
  assert.ok(toyota.summary.growth.epsCagr3y.value != null)

  const pit = await getFinancialPerformanceDetailReadModel('7203', '2026-06-30')
  assert.ok(pit.forecastHistory.every((row) => row.publishedAt <= normalizeAsOf('2026-06-30')))
  assert.equal(pit.forecastHistory[0].targetFiscalYear, 2027)
  assert.equal(pit.forecastHistory[0].forecastScope, 'next_fy')
  assert.equal(pit.forecastHistory[0].metrics.revenue?.value, 51_000_000_000_000)
  assert.equal(pit.forecastHistory.some((row) => row.metrics.revenue?.value === 54_000_000_000_000), false)

  const bank = models.get('8306')!
  assert.equal(bank.isFinancialSector, true)
  assert.equal(bank.summary.profitability.operatingMargin.value, null)
  assert.equal(bank.summary.profitability.operatingMargin.availability, 'not_applicable')

  const lossMaker = models.get('4755')!
  assert.ok((lossMaker.summary.scale.netIncome.value ?? 0) < 0)
  assert.equal(lossMaker.summary.growth.epsCagr3y.value, null)
  assert.equal(lossMaker.summary.growth.epsCagr3y.availability, 'not_meaningful')
  assert.equal(lossMaker.forecastHistory.length, 0)

  assert.ok(models.get('4502')!.modes.FY.periods.some((period) => period.accountingStandard === 'IFRS'))
  assert.ok(models.get('7974')!.modes.FY.periods.some((period) => period.accountingStandard === 'JGAAP'))

  console.log('Financial performance detail tests passed')
}

main().catch((error) => {
  console.error('Financial performance detail tests failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
