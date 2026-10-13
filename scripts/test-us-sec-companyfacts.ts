import assert from 'node:assert/strict'
import { deriveFinancialFacts, normalizeAsOf } from '@/lib/financial-foundation'
import { normalizeSecCompanyFacts, type SecCompanyFacts } from '@/lib/us-sec-companyfacts'

const payload: SecCompanyFacts = {
  cik: 320193,
  entityName: 'Fixture Corp.',
  facts: {
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            { end: '2025-10-17', val: 100, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31' },
          ],
        },
      },
    },
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            { start: '2024-09-29', end: '2025-09-27', val: 400, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
            { start: '2025-09-28', end: '2025-12-27', val: 110, accn: '0002', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', frame: 'CY2025Q4' },
            { start: '2025-09-28', end: '2026-03-28', val: 230, accn: '0003', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
            { start: '2025-12-28', end: '2026-03-28', val: 120, accn: '0003', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01', frame: 'CY2026Q1' },
            { start: '2025-09-28', end: '2026-06-27', val: 360, accn: '0004', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-07-31' },
            { start: '2026-03-29', end: '2026-06-27', val: 130, accn: '0004', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-07-31', frame: 'CY2026Q2' },
            { start: '2024-09-29', end: '2025-09-27', val: 405, accn: '0001A', fy: 2025, fp: 'FY', form: '10-K/A', filed: '2026-02-10', frame: 'CY2025' },
            { start: '2025-09-28', end: '2025-12-27', val: 999, accn: 'ignore', fy: 2026, fp: 'Q1', form: '8-K', filed: '2026-01-31', frame: 'CY2025Q4' },
          ],
        },
      },
      Revenues: {
        units: {
          USD: [
            { start: '2023-10-01', end: '2024-09-28', val: 300, accn: '0000', fy: 2025, fp: 'FY', form: '10-K', filed: '2024-10-31', frame: 'CY2024' },
            { start: '2024-09-29', end: '2025-09-27', val: 999, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
          ],
        },
      },
      OperatingIncomeLoss: {
        units: {
          USD: [
            { start: '2024-09-29', end: '2025-09-27', val: 80, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            { start: '2024-09-29', end: '2025-09-27', val: 60, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
          ],
        },
      },
      EarningsPerShareBasic: {
        units: {
          'USD/shares': [
            { start: '2024-09-29', end: '2025-09-27', val: 0.6, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
          ],
        },
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        units: {
          USD: [
            { start: '2024-09-29', end: '2025-09-27', val: 25, accn: '0001', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', frame: 'CY2025' },
          ],
        },
      },
    },
  },
}

const normalized = normalizeSecCompanyFacts('aapl', payload)
assert.equal(normalized.forecasts.length, 0, 'SEC facts must not be presented as company forecasts')
assert.ok(normalized.disclosures.every((row) => row.source === 'sec_companyfacts'))
assert.ok(normalized.facts.every((row) => row.ticker === 'AAPL' && row.source === 'sec_companyfacts'))
assert.equal(normalized.facts.some((row) => row.disclosureId === 'ignore'), false, '8-K values are outside the statement contract')
assert.equal(normalized.facts.some((row) => row.metric === 'revenue' && row.value === 300), true, 'fallback concepts preserve non-overlapping history')
assert.equal(normalized.facts.some((row) => row.metric === 'revenue' && row.value === 999), false, 'preferred concepts win duplicate filing contexts')
assert.equal(normalized.facts.find((row) => row.metric === 'revenue' && row.value === 300)?.targetFiscalYear, 2024, 'FY label follows the fact period, not the later comparative filing focus')

const capex = normalized.facts.find((row) => row.metric === 'capex')
assert.equal(capex?.value, -25, 'cash outflow is normalized with a negative sign')
assert.equal(capex?.unit, 'USD')

const asOf = (date: string) => normalized.facts.filter((fact) => fact.publishedAt <= normalizeAsOf(date))
const beforeOriginal = asOf('2025-10-31')
assert.equal(beforeOriginal.some((row) => row.metric === 'revenue' && row.value === 400), false, 'date-only SEC facts become eligible conservatively on the next day')
const afterOriginal = asOf('2025-11-01')
assert.equal(afterOriginal.some((row) => row.metric === 'revenue' && row.value === 400), true)
const beforeAmendment = asOf('2026-02-10')
assert.equal(beforeAmendment.some((row) => row.value === 405), false, 'amendment cannot leak into its filing date')
const afterAmendment = asOf('2026-02-11')
assert.equal(afterAmendment.some((row) => row.value === 405 && row.correctionStatus === 'amended'), true)

const derived = deriveFinancialFacts(normalized.facts)
assert.equal(derived.some((row) => row.metric === 'revenue' && row.accumulationKind === 'LTM'), true)
assert.equal(normalized.facts.some((row) => row.value === 0), false, 'missing facts are never zero-filled')

console.log('US SEC Companyfacts normalization, PIT, amendment, units, and null-policy tests passed')
