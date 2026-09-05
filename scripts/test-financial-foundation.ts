import assert from 'node:assert/strict'
import {
  deriveFinancialFacts,
  deriveStandaloneQuarterFacts,
  normalizeJQuantsFinancialRows,
  selectForecastsAsOf,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import { calculateFinancialMetrics, METRIC_DEFINITION_REGISTRY } from '@/lib/financial-metrics'
import type { JFinsSummaryRow } from '@/lib/jquants'

function row(overrides: Partial<JFinsSummaryRow>): JFinsSummaryRow {
  return {
    DiscDate: '2026-01-01', DiscTime: '15:00:00', Code: '72030', DiscNo: 'base',
    DocType: 'FYFinancialStatements_Consolidated_IFRS', CurPerType: 'FY',
    CurPerSt: '2025-04-01', CurPerEn: '2026-03-31', CurFYSt: '2025-04-01', CurFYEn: '2026-03-31',
    Sales: '', OP: '', NP: '', EPS: '', DEPS: '', TA: '', Eq: '', EqAR: '', BPS: '',
    ShOutFY: '', TrShFY: '', AvgSh: '',
    ...overrides,
  }
}

function fiscalRows(fiscalEndYear: number, revenue: number, netIncome: number, equity: number): JFinsSummaryRow[] {
  const startYear = fiscalEndYear - 1
  const fyStart = `${startYear}-04-01`
  const fyEnd = `${fiscalEndYear}-03-31`
  return [
    row({ DiscNo: `${fiscalEndYear}-q1`, DiscDate: `${startYear}-08-01`, DocType: '1QFinancialStatements_Consolidated_IFRS', CurPerType: '1Q', CurPerSt: fyStart, CurPerEn: `${startYear}-06-30`, CurFYSt: fyStart, CurFYEn: fyEnd, Sales: String(revenue * 0.2), NP: String(netIncome * 0.2), OP: String(netIncome * 0.25), Eq: String(equity * 0.94), TA: String(equity * 2.1), CFO: '120', CFI: '-40', AvgSh: '10' }),
    row({ DiscNo: `${fiscalEndYear}-q2`, DiscDate: `${startYear}-11-01`, DocType: '2QFinancialStatements_Consolidated_IFRS', CurPerType: '2Q', CurPerSt: fyStart, CurPerEn: `${startYear}-09-30`, CurFYSt: fyStart, CurFYEn: fyEnd, Sales: String(revenue * 0.45), NP: String(netIncome * 0.45), OP: String(netIncome * 0.55), Eq: String(equity * 0.96), TA: String(equity * 2.15), CFO: '260', CFI: '-90', AvgSh: '10' }),
    row({ DiscNo: `${fiscalEndYear}-q3`, DiscDate: `${fiscalEndYear}-02-01`, DocType: '3QFinancialStatements_Consolidated_IFRS', CurPerType: '3Q', CurPerSt: fyStart, CurPerEn: `${startYear}-12-31`, CurFYSt: fyStart, CurFYEn: fyEnd, Sales: String(revenue * 0.72), NP: String(netIncome * 0.7), OP: String(netIncome * 0.8), Eq: String(equity * 0.98), TA: String(equity * 2.2), CFO: '430', CFI: '-150', AvgSh: '10' }),
    row({ DiscNo: `${fiscalEndYear}-fy`, DiscDate: `${fiscalEndYear}-05-01`, CurPerType: 'FY', CurPerSt: fyStart, CurPerEn: fyEnd, CurFYSt: fyStart, CurFYEn: fyEnd, Sales: String(revenue), NP: String(netIncome), OP: String(netIncome * 1.1), EPS: String(netIncome / 10), Eq: String(equity), TA: String(equity * 2.25), BPS: String(equity / 10), CFO: '600', CFI: '-220', ShOutFY: '10', TrShFY: '0', AvgSh: '10' }),
  ]
}

const rows = [
  ...fiscalRows(2023, 4000, 400, 3000),
  ...fiscalRows(2024, 4300, 430, 3300),
  ...fiscalRows(2025, 4700, 470, 3600),
  ...fiscalRows(2026, 5200, 520, 4000),
  row({
    DiscNo: '2026-fy-forecast', DiscDate: '2026-05-08', CurPerType: 'FY', CurPerSt: '2025-04-01',
    CurPerEn: '2026-03-31', CurFYSt: '2025-04-01', CurFYEn: '2026-03-31', NxtFYSt: '2026-04-01',
    NxtFYEn: '2027-03-31', NxFSales: '6000', NxFOP: '650', NxFNp: '560', NxFEPS: '56', NxFDivAnn: '10',
  }),
  row({
    DiscNo: '2027-q1-forecast', DiscDate: '2026-08-04', DocType: '1QFinancialStatements_Consolidated_IFRS',
    CurPerType: '1Q', CurPerSt: '2026-04-01', CurPerEn: '2026-06-30', CurFYSt: '2026-04-01',
    CurFYEn: '2027-03-31', FSales: '6300', FOP: '700', FNP: '600', FEPS: '60', FDivAnn: '12',
  }),
]

const normalized = normalizeJQuantsFinancialRows(rows)
const fy2027Revenue = normalized.forecasts.filter((forecast) => (
  forecast.targetFiscalYear === 2027 && forecast.metric === 'revenue' && forecast.forecastPeriod === 'FY'
))
assert.equal(fy2027Revenue.length, 2)
assert.deepEqual(fy2027Revenue.map((forecast) => forecast.forecastScope).sort(), ['current_fy', 'next_fy'])
assert.deepEqual(fy2027Revenue.map((forecast) => forecast.value).sort((a, b) => a - b), [6000, 6300])

const beforeQ1 = selectForecastsAsOf(normalized.forecasts, '2026-06-30')
assert.equal(beforeQ1.some((forecast) => forecast.forecastScope === 'current_fy' && forecast.targetFiscalYear === 2027), false)
assert.equal(beforeQ1.some((forecast) => forecast.forecastScope === 'next_fy' && forecast.targetFiscalYear === 2027), true)
const afterQ1 = selectForecastsAsOf(normalized.forecasts, '2026-08-04')
assert.equal(afterQ1.some((forecast) => forecast.forecastScope === 'current_fy' && forecast.value === 6300), true)
const oneSecondBeforeQ1 = selectForecastsAsOf(normalized.forecasts, '2026-08-04T05:59:59.000Z')
assert.equal(oneSecondBeforeQ1.some((forecast) => forecast.forecastScope === 'current_fy' && forecast.targetFiscalYear === 2027), false)
const atQ1Publication = selectForecastsAsOf(normalized.forecasts, '2026-08-04T06:00:00.000Z')
assert.equal(atQ1Publication.some((forecast) => forecast.forecastScope === 'current_fy' && forecast.targetFiscalYear === 2027), true)

const derived = deriveFinancialFacts(normalized.facts)
const fy2026RevenueQuarters = derived.filter((fact) => (
  fact.metric === 'revenue' && fact.fiscalYearEnd === '2026-03-31' && fact.accumulationKind === 'STANDALONE'
))
assert.deepEqual(fy2026RevenueQuarters.map((fact) => Math.round(fact.value)), [1040, 1300, 1404, 1456])
const latestRevenueLtm = derived.filter((fact) => fact.metric === 'revenue' && fact.accumulationKind === 'LTM').at(-1)
assert.equal(Math.round(latestRevenueLtm?.value ?? 0), 5200)
assert.equal(latestRevenueLtm?.inputFactIds.length, 4)
assert.equal(latestRevenueLtm?.derivationMethod, 'sum_four_standalone_quarters')
const fallbackInput = normalizeJQuantsFinancialRows([
  ...fiscalRows(2025, 4700, 470, 3600).filter((candidate) => ['2025-q1', '2025-fy'].includes(candidate.DiscNo)),
  fiscalRows(2026, 5200, 520, 4000).find((candidate) => candidate.DiscNo === '2026-q1')!,
]).facts
const fallbackLtm = deriveFinancialFacts(fallbackInput).find((fact) => (
  fact.metric === 'revenue' && fact.periodEnd === '2025-06-30' && fact.accumulationKind === 'LTM'
))
assert.equal(fallbackLtm?.derivationMethod, 'previous_fy_plus_current_ytd_minus_prior_ytd')
assert.equal(fallbackLtm?.inputFactIds.length, 3)

const mismatchFacts: NormalizedFinancialFact[] = [
  { ...normalized.facts.find((fact) => fact.disclosureId === '2026-q1' && fact.metric === 'revenue')!, correctionStatus: 'original' },
  { ...normalized.facts.find((fact) => fact.disclosureId === '2026-q2' && fact.metric === 'revenue')!, correctionStatus: 'restated' },
]
assert.equal(deriveStandaloneQuarterFacts(mismatchFacts).some((fact) => fact.periodKind === 'Q2'), false)

const allFacts = [...normalized.facts, ...derived]
const metrics = calculateFinancialMetrics({
  ticker: '7203', asOf: '2026-08-21', facts: allFacts, forecasts: normalized.forecasts,
  price: { value: 300, date: '2026-08-21', inputId: 'price:test' }, isFinancialSector: false,
})
for (const key of ['eps', 'bps', 'per', 'forward_per', 'pbr', 'psr', 'roe', 'roa', 'revenue_growth', 'eps_growth', 'revenue_cagr_3y', 'revenue_cagr_5y', 'dividend_yield', 'payout_ratio', 'simple_fcf'] as const) {
  assert.ok(METRIC_DEFINITION_REGISTRY[key], `registry missing ${key}`)
  assert.ok(METRIC_DEFINITION_REGISTRY[key].version, `version missing ${key}`)
}
for (const key of ['forward_per', 'roe', 'revenue_growth', 'revenue_cagr_3y'] as const) {
  const metric = metrics.find((candidate) => candidate.metric === key)
  assert.ok(metric, `calculation missing ${key}`)
  assert.ok(metric.inputFactIds.length > 0, `lineage missing ${key}`)
  assert.equal(metric.definitionVersion, METRIC_DEFINITION_REGISTRY[key].version)
}
assert.equal(metrics.find((metric) => metric.metric === 'forward_per')?.value, 5)
assert.ok(Math.abs((metrics.find((metric) => metric.metric === 'revenue_cagr_3y')?.value ?? 0) - 9.139) < 0.01)

const metricsBeforeQ1 = calculateFinancialMetrics({
  ticker: '7203', asOf: '2026-06-30', facts: allFacts, forecasts: normalized.forecasts,
  price: { value: 280, date: '2026-06-30', inputId: 'price:test:before-q1' }, isFinancialSector: false,
})
assert.equal(metricsBeforeQ1.find((metric) => metric.metric === 'forward_per')?.value, 5)

console.log('Financial foundation tests passed')
