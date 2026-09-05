import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { getShareholderReturnsReadModel } from '@/lib/server/shareholder-returns-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974', '9104', '2163'] as const
const PIT_DATES = ['2024-06-28', '2025-06-30'] as const

async function main() {
  const models = new Map<string, Awaited<ReturnType<typeof getShareholderReturnsReadModel>>>()
  for (const ticker of TICKERS) {
    const startedAt = performance.now()
    const model = await getShareholderReturnsReadModel(ticker, '2026-08-21')
    const elapsedMs = performance.now() - startedAt
    models.set(ticker, model)
    assert.equal(model.contractVersion, 'shareholder-returns-v1')
    assert.equal(model.asOf, '2026-08-21')
    assert.ok(model.coverage.facts > 0, `${ticker}: normalized facts are required`)
    assert.ok(model.history.rows.every((row) => row.publishedAt <= normalizeAsOf(model.asOf)), `${ticker}: actual or forecast history leaked after as_of`)
    assert.ok(model.forecastRevisions.every((row) => row.publishedAt <= normalizeAsOf(model.asOf)), `${ticker}: forecast revision leaked after as_of`)
    assert.equal(model.buybacks.annualBuybackAmount.value, null)
    assert.equal(model.totalReturns.availability, 'unavailable')
    assert.equal(model.coverage.buybackAmountAvailable, false)
    assert.ok(model.definitions.dividendYield.version)
    assert.ok(model.definitions.standardFcf.version)
    console.log(JSON.stringify({
      ticker,
      elapsedMs: Math.round(elapsedMs),
      actualDividendYears: model.coverage.actualDividendYears,
      forecastRevisionRows: model.coverage.forecastRevisionRows,
      current: {
        forecastDps: model.current.forecastDps.value,
        forecastYield: model.current.forecastDividendYield.value,
        payoutRatio: model.current.payoutRatio.value,
        actualDps: model.current.actualDps.value,
        dpsYoy: model.current.dpsYoY.value,
        fcfYield: model.current.fcfYield.value,
      },
      direction: {
        consecutiveIncreaseYears: model.direction.consecutiveIncreaseYears.value,
        consecutiveNonDecreaseYears: model.direction.consecutiveNonDecreaseYears.value,
        cutsLast5Years: model.direction.cutsLast5Years.value,
        dpsCagr3y: model.direction.dpsCagr3y.value,
        dpsCagr5y: model.direction.dpsCagr5y.value,
      },
    }))
  }

  const toyota = models.get('7203')!
  const toyotaSplit = toyota.history.adjustments.find((item) => item.factor === 5)
  assert.ok(toyotaSplit, '7203: 1:5 stock split must be detected')
  const toyota2021 = toyota.history.rows.find((row) => row.fiscalYear === 2021)!
  assert.equal(toyota2021.rawActualDps, 240)
  assert.equal(toyota2021.actualDps.value, 48)
  assert.equal(toyota2021.splitAdjustmentFactor, 5)
  assert.ok((toyota.direction.dpsCagr5y.value ?? 0) > 0)

  const nintendo = models.get('7974')!
  assert.ok(nintendo.history.adjustments.some((item) => item.factor === 10), '7974: 1:10 stock split must be detected')
  const nintendo2022 = nintendo.history.rows.find((row) => row.fiscalYear === 2022)!
  assert.equal(nintendo2022.rawActualDps, 2030)
  assert.equal(nintendo2022.actualDps.value, 203)
  assert.ok(nintendo.history.rows.some((row) => row.direction === 'decrease'), '7974: a dividend cut must be visible')

  const bank = models.get('8306')!
  assert.equal(bank.isFinancialSector, true)
  assert.equal(bank.current.fcfYield.availability, 'not_applicable')
  assert.equal(bank.sustainability.standardFcf.availability, 'not_applicable')
  assert.ok((bank.direction.consecutiveIncreaseYears.value ?? 0) >= 1)

  const noDividend = models.get('4755')!
  assert.equal(noDividend.current.actualDps.value, 0)
  assert.equal(noDividend.history.rows.filter((row) => row.actualDps.availability === 'available').at(-1)?.direction, 'no_dividend')
  assert.ok(noDividend.sustainability.facts.some((fact) => /赤字/.test(fact)))

  const highDividend = models.get('2163')!
  assert.ok((highDividend.current.forecastDividendYield.value ?? 0) >= 5, '2163: high forecast dividend yield case is required')

  for (const asOf of PIT_DATES) {
    const pit = await getShareholderReturnsReadModel('7203', asOf)
    const cutoff = normalizeAsOf(asOf)
    assert.equal(pit.asOf, asOf)
    assert.ok((pit.priceDate ?? '') <= asOf)
    assert.ok(pit.history.rows.every((row) => row.publishedAt <= cutoff), `7203: history PIT leak at ${asOf}`)
    assert.ok(pit.forecastRevisions.every((row) => row.publishedAt <= cutoff), `7203: revision PIT leak at ${asOf}`)
    if (pit.current.forecastDps.publishedAt) assert.ok(pit.current.forecastDps.publishedAt <= cutoff)
  }

  const warmStartedAt = performance.now()
  await getShareholderReturnsReadModel('7203', '2026-08-21')
  const warmElapsedMs = performance.now() - warmStartedAt
  assert.ok(warmElapsedMs < 50, `shareholder returns cache read took ${warmElapsedMs.toFixed(1)}ms`)
  console.log(`Shareholder returns tests passed; cached 7203 read ${warmElapsedMs.toFixed(1)}ms`)
}

main().catch((error) => {
  console.error('Shareholder returns tests failed:', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
