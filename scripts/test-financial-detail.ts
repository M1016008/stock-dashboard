import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { FINANCIAL_DETAIL_DEFINITION_KEYS } from '@/lib/financial-detail'
import { getFinancialDetailReadModel } from '@/lib/server/financial-detail-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const

function allPublishedAt(model: Awaited<ReturnType<typeof getFinancialDetailReadModel>>): string[] {
  return [
    ...Object.values(model.profitAndLoss).flat().map((period) => period.publishedAt),
    ...model.balanceSheet.FY.map((period) => period.publishedAt),
    ...model.balanceSheet.QUARTER.map((period) => period.publishedAt),
    ...Object.values(model.cashFlow).flat().map((period) => period.publishedAt),
  ]
}

async function main() {
  const asOf = '2026-08-21'
  const cutoff = normalizeAsOf(asOf)
  const models = new Map<string, Awaited<ReturnType<typeof getFinancialDetailReadModel>>>()

  for (const ticker of TICKERS) {
    const model = await getFinancialDetailReadModel(ticker, asOf)
    models.set(ticker, model)
    assert.equal(model.contractVersion, 'financial-detail-v1')
    assert.equal(model.asOf, asOf)
    assert.ok(model.coverage.facts > 0, `${ticker}: facts are required`)
    assert.ok(model.coverage.profitAndLossPeriods > 0, `${ticker}: P/L periods are required`)
    assert.ok(model.coverage.balanceSheetPeriods > 0, `${ticker}: B/S periods are required`)
    assert.ok(model.coverage.cashFlowPeriods > 0, `${ticker}: C/F periods are required`)
    assert.ok(allPublishedAt(model).every((publishedAt) => publishedAt <= cutoff), `${ticker}: PIT leak detected`)
    assert.deepEqual(Object.keys(model.definitions).sort(), [...FINANCIAL_DETAIL_DEFINITION_KEYS].sort())
    assert.ok(Object.values(model.definitions).every((definition) => definition.dataSource && definition.version))
    assert.ok(model.balanceSheet.FY.every((period) => period.periodKind === 'FY'))
    assert.ok(model.balanceSheet.QUARTER.every((period) => period.periodKind !== 'LTM'))
  }

  const toyota = models.get('7203')!
  const toyotaLatestFy = toyota.profitAndLoss.FY.at(-1)!
  assert.equal(toyotaLatestFy.accountingStandard, 'IFRS')
  assert.equal(toyotaLatestFy.consolidationScope, 'consolidated')
  assert.equal(toyotaLatestFy.metrics.ordinaryProfit.value, null)
  assert.ok(toyota.summary.financialHealth.totalAssets.value != null)
  assert.ok(toyota.summary.cashFlow.operatingCashFlow.value != null)
  assert.ok(toyota.metricPeriods.LTM.length > 0)
  assert.ok(toyota.metricPeriods.FY.length > 0)

  const mitsui = models.get('7003')!
  assert.equal(mitsui.profitAndLoss.FY.at(-1)?.accountingStandard, 'JGAAP')
  assert.ok(mitsui.profitAndLoss.FY.at(-1)!.metrics.ordinaryProfit.value != null)
  const mitsuiCf = mitsui.cashFlow.LTM.at(-1)!
  assert.equal(
    mitsuiCf.metrics.simpleFcf.value,
    mitsuiCf.metrics.operatingCashFlow.value! + mitsuiCf.metrics.investingCashFlow.value!,
  )

  const bank = models.get('8306')!
  assert.equal(bank.isFinancialSector, true)
  assert.equal(bank.summary.profitability.operatingMargin.availability, 'not_applicable')
  assert.equal(bank.summary.profitability.netMargin.availability, 'not_applicable')
  assert.equal(bank.summary.cashFlow.simpleFcf.availability, 'not_applicable')

  const lossMaker = models.get('4755')!
  assert.ok((lossMaker.profitAndLoss.LTM.at(-1)?.metrics.netIncome.value ?? 0) < 0)
  assert.notEqual(lossMaker.summary.capitalEfficiency.roe.value, 0)

  assert.ok(models.get('4502')!.profitAndLoss.FY.some((period) => period.accountingStandard === 'IFRS'))
  assert.ok(models.get('7974')!.profitAndLoss.FY.some((period) => period.accountingStandard === 'JGAAP'))

  const pit = await getFinancialDetailReadModel('7203', '2026-06-30')
  assert.equal(pit.asOf, '2026-06-30')
  assert.ok(allPublishedAt(pit).every((publishedAt) => publishedAt <= normalizeAsOf('2026-06-30')))
  assert.equal(pit.balanceSheet.QUARTER.some((period) => period.periodEnd === '2026-06-30'), false)

  console.log('Financial detail tests passed')
}

main().catch((error) => {
  console.error('Financial detail tests failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
