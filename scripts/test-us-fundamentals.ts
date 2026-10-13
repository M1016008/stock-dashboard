import assert from 'node:assert/strict'
import type { NormalizedFinancialFact } from '@/lib/financial-foundation'
import { buildUsFundamentalsModel } from '@/lib/us-fundamentals'

let sequence = 0
function fact(
  metric: string,
  value: number,
  periodEnd: string,
  accumulationKind: NormalizedFinancialFact['accumulationKind'],
  options: Partial<NormalizedFinancialFact> = {},
): NormalizedFinancialFact {
  sequence += 1
  return {
    factId: `fact-${sequence}`,
    eventId: 'event',
    ticker: 'TEST',
    publishedAt: options.publishedAt ?? '2026-02-01T23:59:59.999Z',
    periodStart: options.periodStart ?? (accumulationKind === 'INSTANT' ? null : '2025-01-01'),
    periodEnd,
    fiscalYearStart: options.fiscalYearStart ?? '2025-01-01',
    fiscalYearEnd: options.fiscalYearEnd ?? (accumulationKind === 'FY' ? periodEnd : null),
    targetFiscalYear: options.targetFiscalYear ?? Number(periodEnd.slice(0, 4)),
    periodKind: options.periodKind ?? (accumulationKind === 'FY' ? 'FY' : accumulationKind === 'LTM' ? 'LTM' : 'OTHER'),
    accumulationKind,
    valueKind: options.valueKind ?? (accumulationKind === 'INSTANT' ? 'instant' : 'duration'),
    metric,
    value,
    unit: options.unit ?? (metric.includes('shares') ? 'SHARES' : 'USD'),
    currency: options.currency === undefined ? 'USD' : options.currency,
    consolidationScope: 'consolidated',
    accountingStandard: 'USGAAP',
    correctionStatus: 'original',
    source: options.source ?? 'sec_companyfacts',
    sourceField: options.sourceField ?? `us-gaap:${metric}`,
    disclosureId: '0001',
    isDerived: options.isDerived ?? accumulationKind === 'LTM',
    derivationMethod: options.derivationMethod ?? null,
    inputFactIds: options.inputFactIds ?? [],
    definitionVersion: options.definitionVersion ?? null,
  }
}

const facts = [
  fact('revenue', 900, '2024-12-31', 'LTM'),
  fact('revenue', 1000, '2025-12-31', 'LTM'),
  fact('operating_profit', 200, '2025-12-31', 'LTM'),
  fact('net_income_attributable', 120, '2025-12-31', 'LTM'),
  fact('eps_basic', 6, '2025-12-31', 'LTM', { unit: 'USD_PER_SHARE' }),
  fact('total_assets', 2000, '2025-12-31', 'INSTANT'),
  fact('equity_attributable', 700, '2024-12-31', 'INSTANT'),
  fact('equity_attributable', 800, '2025-12-31', 'INSTANT'),
  fact('cash_and_equivalents', 300, '2025-12-31', 'INSTANT'),
  fact('shares_outstanding', 100, '2025-12-31', 'INSTANT', { unit: 'SHARES', currency: null }),
  fact('operating_cash_flow', 220, '2025-12-31', 'LTM'),
  fact('capex', -70, '2025-12-31', 'LTM'),
  fact('cash_dividends_paid', 40, '2025-12-31', 'LTM'),
  fact('share_repurchases', 60, '2025-12-31', 'LTM'),
  fact('revenue', 900, '2024-12-31', 'FY', { targetFiscalYear: 2024, periodKind: 'FY' }),
  fact('revenue', 1000, '2025-12-31', 'FY', { targetFiscalYear: 2025, periodKind: 'FY' }),
  fact('operating_profit', 200, '2025-12-31', 'FY', { targetFiscalYear: 2025, periodKind: 'FY' }),
  fact('net_income_attributable', 120, '2025-12-31', 'FY', { targetFiscalYear: 2025, periodKind: 'FY' }),
  fact('eps_basic', 6, '2025-12-31', 'FY', { targetFiscalYear: 2025, periodKind: 'FY', unit: 'USD_PER_SHARE' }),
  fact('revenue', 5000, '2026-03-31', 'LTM', { publishedAt: '2026-04-30T23:59:59.999Z' }),
]

const model = buildUsFundamentalsModel({
  ticker: 'TEST',
  name: 'Test Corp.',
  asOf: '2026-03-31',
  price: { date: '2026-03-31', close: 120 },
  facts,
  dividends: [
    { date: '2025-06-01', cash: 0.5 },
    { date: '2025-12-01', cash: 0.5 },
    { date: '2026-03-01', cash: 0.5 },
  ],
  dividendCoverageStart: '2020-01-02',
})

assert.equal(model.coverage.status, 'READY')
assert.equal(model.summary.revenueGrowth.value?.toFixed(2), '11.11')
assert.equal(model.summary.operatingMargin.value, 20)
assert.equal(model.summary.equityRatio.value, 40)
assert.equal(model.summary.roe.value, 16)
assert.equal(model.summary.trailingPer.value, 20)
assert.equal(model.valuation.marketCap.value, 12_000)
assert.equal(model.valuation.pbr.value, 15)
assert.equal(model.valuation.psr.value, 12)
assert.equal(model.financials.freeCashFlow.value, 150)
assert.equal(model.shareholderReturn.trailingDividendPerShare.value, 1.5)
assert.equal(model.shareholderReturn.trailingDividendYield.value, 1.25)
assert.equal(model.shareholderReturn.payoutRatio.value?.toFixed(2), '33.33')
assert.equal(model.shareholderReturn.buybackYield.value, 0.5)
assert.equal(model.performance.periods.length, 2)
assert.equal(model.coverage.forecasts, 'UNAVAILABLE')
assert.equal(model.summary.revenueGrowth.sourceFactIds.length, 2)
assert.equal(model.coverage.latestPublishedAt, '2026-02-01T23:59:59.999Z', 'future filing is excluded')

const lossModel = buildUsFundamentalsModel({
  ticker: 'LOSS',
  name: null,
  asOf: '2026-03-31',
  price: { date: '2026-03-31', close: 10 },
  facts: [
    fact('net_income_attributable', -5, '2025-12-31', 'LTM'),
    fact('eps_basic', -1, '2025-12-31', 'LTM', { unit: 'USD_PER_SHARE' }),
  ],
  dividends: [],
  dividendCoverageStart: '2020-01-02',
})
assert.equal(lossModel.summary.trailingPer.availability, 'not_meaningful')
assert.equal(lossModel.shareholderReturn.trailingDividendPerShare.value, 0, 'observed no-dividend is a measured zero')
assert.equal(lossModel.coverage.status, 'PARTIAL')

const mismatchedPayoutModel = buildUsFundamentalsModel({
  ticker: 'MISMATCH',
  name: null,
  asOf: '2026-03-31',
  price: { date: '2026-03-31', close: 10 },
  facts: [
    fact('net_income_attributable', 100, '2025-12-31', 'LTM'),
    fact('cash_dividends_paid', 25, '2025-09-30', 'FY', { periodKind: 'FY' }),
  ],
  dividends: [],
  dividendCoverageStart: '2020-01-02',
})
assert.equal(mismatchedPayoutModel.shareholderReturn.payoutRatio.availability, 'missing')
assert.equal(mismatchedPayoutModel.shareholderReturn.payoutRatio.value, null, 'FY dividends must not be mixed with LTM net income')

const uncoveredDividendModel = buildUsFundamentalsModel({
  ticker: 'NEW',
  name: null,
  asOf: '2026-03-31',
  price: { date: '2026-03-31', close: 10 },
  facts: [],
  dividends: [],
  dividendCoverageStart: '2026-01-02',
})
assert.equal(uncoveredDividendModel.shareholderReturn.trailingDividendPerShare.availability, 'missing')
assert.equal(uncoveredDividendModel.shareholderReturn.trailingDividendPerShare.value, null, 'uncovered dividends must not be zero-filled')

console.log('US fundamentals calculations, PIT exclusion, negative earnings, dividends, and null-policy tests passed')
