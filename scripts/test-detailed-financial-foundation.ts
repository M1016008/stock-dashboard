import assert from 'node:assert/strict'

import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import {
  analyzeDetailedConceptGaps,
  DETAILED_FINANCIAL_SOURCE_POLICIES,
  parseEdinetDetailedFinancialFacts,
} from '@/lib/detailed-financial-foundation'
import { METRIC_DEFINITION_REGISTRY } from '@/lib/financial-metrics'
import { buildAdvancedFinancialMetricsForTicker } from '@/lib/server/detailed-financial-metrics'
import { loadDetailedFinancialFacts } from '@/lib/server/detailed-financial-foundation-store'

const synthetic = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:dei="urn:dei" xmlns:ifrs="urn:ifrs">
  <xbrli:context id="CurrentYearInstant"><xbrli:entity><xbrli:identifier scheme="x">E00001</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="CurrentYearDuration"><xbrli:entity><xbrli:identifier scheme="x">E00001</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="SegmentInstant"><xbrli:entity><xbrli:identifier scheme="x">E00001</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="ifrs:SegmentsAxis">ifrs:AlphaMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:unit id="JPY"><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unit>
  <dei:AccountingStandardsDEI contextRef="CurrentYearInstant">IFRS</dei:AccountingStandardsDEI>
  <ifrs:CashAndCashEquivalentsIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">100000000</ifrs:CashAndCashEquivalentsIFRS>
  <ifrs:InterestBearingLiabilitiesCLIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">40000000</ifrs:InterestBearingLiabilitiesCLIFRS>
  <ifrs:InterestBearingLiabilitiesNCLIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">60000000</ifrs:InterestBearingLiabilitiesNCLIFRS>
  <ifrs:BondsPayableNCLIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">30000000</ifrs:BondsPayableNCLIFRS>
  <ifrs:LeaseLiabilitiesNCLIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">10000000</ifrs:LeaseLiabilitiesNCLIFRS>
  <ifrs:GoodwillIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">5000000</ifrs:GoodwillIFRS>
  <ifrs:GoodwillIFRS contextRef="SegmentInstant" unitRef="JPY" decimals="-6">999000000</ifrs:GoodwillIFRS>
  <ifrs:NonControllingInterestsIFRS contextRef="CurrentYearInstant" unitRef="JPY" decimals="-6">2000000</ifrs:NonControllingInterestsIFRS>
  <ifrs:DepreciationAndAmortizationOpeCFIFRS contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">12000000</ifrs:DepreciationAndAmortizationOpeCFIFRS>
  <ifrs:PurchaseOfPropertyPlantAndEquipmentInvCFIFRS contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">-18000000</ifrs:PurchaseOfPropertyPlantAndEquipmentInvCFIFRS>
  <ifrs:PurchaseOfIntangibleAssetsInvCFIFRS contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">-2000000</ifrs:PurchaseOfIntangibleAssetsInvCFIFRS>
</xbrli:xbrl>`

async function main() {
const reader = new XbrlFactReader(synthetic)
const parsed = parseEdinetDetailedFinancialFacts(reader, {
  ticker: '0001', documentId: 'DOC1', publishedAt: '2026-06-01T10:00:00',
  periodEnd: '2026-03-31', documentType: '120',
})
assert.equal(parsed.find((fact) => fact.metric === 'goodwill')?.value, 5_000_000, 'dimensioned segment fact leaked into whole-company fact')
assert.equal(parsed.find((fact) => fact.metric === 'capex')?.value, 20_000_000)
assert.equal(parsed.find((fact) => fact.metric === 'interest_bearing_debt')?.value, 100_000_000, 'inclusive IFRS debt was double counted with bonds or leases')
assert.ok(parsed.every((fact) => fact.unit === 'JPY' && fact.currency === 'JPY'))
assert.ok(parsed.find((fact) => fact.metric === 'capex')?.inputFactIds.length === 2)

const customConceptReader = new XbrlFactReader(synthetic.replace(
  '</xbrli:xbrl>',
  '<ifrs:CompanySpecificBorrowings contextRef="CurrentYearInstant" unitRef="JPY">123</ifrs:CompanySpecificBorrowings></xbrli:xbrl>',
))
const debtGap = analyzeDetailedConceptGaps(customConceptReader, parsed.filter((fact) => (
  !['interest_bearing_debt', 'short_term_debt', 'long_term_debt', 'bonds', 'lease_liabilities'].includes(fact.metric)
)))
assert.ok(debtGap.debt?.some((concept) => concept.endsWith(':CompanySpecificBorrowings')))

const corrected = parseEdinetDetailedFinancialFacts(reader, {
  ticker: '0001', documentId: 'DOC2', publishedAt: '2026-06-02T10:00:00',
  periodEnd: '2026-03-31', documentType: '130',
})
assert.notEqual(parsed[0].factId, corrected[0].factId, 'correction overwrote the original fact identity')
assert.ok(corrected.every((fact) => fact.correctionStatus === 'corrected'))

assert.equal(DETAILED_FINANCIAL_SOURCE_POLICIES.cash_and_cash_equivalents.primary, 'jquants_summary')
assert.equal(DETAILED_FINANCIAL_SOURCE_POLICIES.depreciation_amortization.primary, 'edinet_xbrl')
assert.equal(DETAILED_FINANCIAL_SOURCE_POLICIES.capex.primary, 'calculated')
for (const key of ['net_debt', 'ebitda', 'standard_fcf', 'enterprise_value', 'ev_ebitda', 'fcf_yield', 'roic'] as const) {
  assert.ok(METRIC_DEFINITION_REGISTRY[key].version)
  assert.ok(METRIC_DEFINITION_REGISTRY[key].requiredInputs.length > 0)
}

const tickers = ['7203', '7003', '8306', '4755', '4502', '7974'] as const
const summaries = []
for (const ticker of tickers) {
  const [facts, result] = await Promise.all([
    loadDetailedFinancialFacts(ticker, '2026-08-21'),
    buildAdvancedFinancialMetricsForTicker(ticker, '2026-08-21'),
  ])
  assert.ok(facts.length > 0, `${ticker}: detailed facts missing`)
  assert.ok(facts.every((fact) => fact.publishedAt <= '2026-08-21T23:59:59'), `${ticker}: future fact leaked`)
  assert.ok(facts.every((fact) => fact.source !== 'calculated' || fact.inputFactIds.length > 0), `${ticker}: derived lineage missing`)
  assert.ok(result.metrics.every((metric) => metric.inputFactIds.length > 0 && metric.definitionVersion), `${ticker}: calculated lineage missing`)
  if (ticker === '8306') {
    assert.equal(result.isFinancialSector, true)
    assert.equal(result.metrics.length, 0, 'financial-sector advanced metrics must be N/A')
  }
  summaries.push({
    ticker,
    facts: facts.length,
    accountingStandards: [...new Set(facts.map((fact) => fact.accountingStandard))],
    advancedMetrics: Object.fromEntries(result.metrics.map((metric) => [metric.metric, metric.value])),
  })
}

const toyotaBefore = await buildAdvancedFinancialMetricsForTicker('7203', '2026-06-09')
const toyotaAfter = await buildAdvancedFinancialMetricsForTicker('7203', '2026-06-10')
assert.equal(toyotaBefore.metrics.find((metric) => metric.metric === 'net_debt')?.periodEnd, '2025-03-31')
assert.equal(toyotaAfter.metrics.find((metric) => metric.metric === 'net_debt')?.periodEnd, '2026-03-31')
assert.ok(toyotaAfter.metrics.every((metric) => metric.asOf === '2026-06-10'))

const toyotaFacts = await loadDetailedFinancialFacts('7203', '2026-06-10')
assert.equal(
  toyotaFacts.find((fact) => fact.metric === 'depreciation_amortization' && fact.periodEnd === '2026-03-31')?.value,
  2_392_519_000_000,
)
assert.equal(
  toyotaFacts.find((fact) => fact.metric === 'capex' && fact.periodEnd === '2026-03-31')?.value,
  5_293_348_000_000,
)

console.log(JSON.stringify({
  syntheticFacts: parsed.length,
  pit: {
    beforePublicationPeriod: toyotaBefore.metrics.find((metric) => metric.metric === 'net_debt')?.periodEnd ?? null,
    afterPublicationPeriod: toyotaAfter.metrics.find((metric) => metric.metric === 'net_debt')?.periodEnd ?? null,
  },
  summaries,
}, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
