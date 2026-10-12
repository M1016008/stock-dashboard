import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveFinancialFacts, normalizeAsOf } from '@/lib/financial-foundation'
import {
  deriveSecInstantFinancialFacts,
  normalizeSecCompanyfacts,
  secTickerAliases,
  type SecCompanyFactsPayload,
  type SecSubmissionsPayload,
} from '@/lib/us-sec-companyfacts'

const companyfacts: SecCompanyFactsPayload = {
  cik: 320193,
  entityName: 'Fixture Inc.',
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            { start: '2024-10-01', end: '2025-09-30', val: 1000, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
            { start: '2025-10-01', end: '2025-12-31', val: 260, accn: 'q1-1', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-02-01', frame: 'CY2025Q4' },
            { start: '2025-10-01', end: '2026-03-31', val: 550, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
            { start: '2026-01-01', end: '2026-03-31', val: 290, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01', frame: 'CY2026Q1' },
            { start: '2025-10-01', end: '2026-03-31', val: 552, accn: 'q2-a', fy: 2026, fp: 'Q2', form: '10-Q/A', filed: '2026-05-03' },
            { start: '2026-04-01', end: '2026-04-30', val: 99, accn: '8k-1', fy: 2026, fp: 'Q2', form: '8-K', filed: '2026-05-04' },
          ],
        },
      },
      Revenues: {
        units: {
          USD: [
            { start: '2025-10-01', end: '2026-03-31', val: 999, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            { start: '2024-10-01', end: '2025-09-30', val: 100, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
            { start: '2025-10-01', end: '2025-12-31', val: 22, accn: 'q1-1', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-02-01' },
            { start: '2025-10-01', end: '2026-03-31', val: 48, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
      WeightedAverageNumberOfSharesOutstandingBasic: {
        units: {
          shares: [
            { start: '2024-10-01', end: '2025-09-30', val: 50, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
            { start: '2025-10-01', end: '2025-12-31', val: 49, accn: 'q1-1', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-02-01' },
            { start: '2025-10-01', end: '2026-03-31', val: 48.5, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
      Assets: {
        units: {
          USD: [
            { end: '2025-09-30', val: 2000, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
            { end: '2026-03-31', val: 2100, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
      StockholdersEquity: {
        units: {
          USD: [
            { end: '2025-09-30', val: 800, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
            { end: '2026-03-31', val: 840, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
      CommonStockDividendsPerShareDeclared: {
        units: {
          'USD/shares': [
            { start: '2024-10-01', end: '2025-09-30', val: 1.2, accn: 'annual-1', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-11-01' },
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            { end: '2026-04-20', val: 48, accn: 'q2-1', fy: 2026, fp: 'Q2', form: '10-Q', filed: '2026-05-01' },
          ],
        },
      },
    },
  },
}

const submissions: SecSubmissionsPayload = {
  filings: {
    recent: {
      accessionNumber: ['q1-1', 'q2-1', 'q2-a'],
      acceptanceDateTime: ['2026-02-01T14:00:00.000Z', '2026-05-01T14:01:00.000Z', '2026-05-03T14:02:00.000Z'],
      filingDate: ['2026-02-01', '2026-05-01', '2026-05-03'],
      reportDate: ['2025-12-31', '2026-03-31', '2026-03-31'],
      form: ['10-Q', '10-Q', '10-Q/A'],
    },
  },
}

const normalized = normalizeSecCompanyfacts('fixture.a', companyfacts, submissions)

assert.equal(normalized.cik, '0000320193')
assert.equal(normalized.facts.every((fact) => fact.ticker === 'FIXTURE-A'), true)
assert.equal(normalized.facts.every((fact) => fact.source === 'sec_companyfacts'), true)
assert.equal(normalized.forecasts.length, 0)

const q2Revenue = normalized.facts.filter((fact) => (
  fact.metric === 'revenue' && fact.disclosureId === 'q2-1'
))
assert.equal(q2Revenue.length, 1, 'standalone quarter and lower-priority revenue concepts must not duplicate YTD revenue')
assert.equal(q2Revenue[0].value, 550)
assert.equal(q2Revenue[0].periodStart, '2025-10-01')
assert.equal(q2Revenue[0].accumulationKind, 'YTD')
assert.equal(q2Revenue[0].publishedAt, '2026-05-01T14:01:00.000Z')

const amended = normalized.facts.find((fact) => fact.disclosureId === 'q2-a' && fact.metric === 'revenue')
assert.ok(amended)
assert.equal(amended.correctionStatus, 'corrected')
assert.equal(amended.publishedAt, '2026-05-03T14:02:00.000Z')

const annual = normalized.facts.find((fact) => fact.disclosureId === 'annual-1' && fact.metric === 'revenue')
assert.ok(annual)
assert.equal(annual.publishedAt, '2025-11-01T23:59:59.999Z', 'missing acceptance time must use conservative end-of-day fallback')
assert.equal(annual.unit, 'USD')
assert.equal(annual.currency, 'USD')

const shares = normalized.facts.find((fact) => fact.metric === 'shares_outstanding')
assert.ok(shares)
assert.equal(shares.unit, 'SHARES')
assert.equal(shares.valueKind, 'instant')
assert.equal(shares.accumulationKind, 'INSTANT')

assert.equal(normalized.facts.some((fact) => fact.disclosureId === '8k-1'), false)
assert.ok(normalized.ignored.unsupportedForms > 0)
assert.ok(normalized.ignored.nonYtdDurations > 0)

const derived = deriveFinancialFacts(normalized.facts)
const instantDerived = deriveSecInstantFinancialFacts(normalized.facts)
const annualLtm = derived.find((fact) => (
  fact.metric === 'revenue' && fact.periodEnd === '2025-09-30' && fact.accumulationKind === 'LTM'
))
assert.ok(annualLtm)
assert.equal(annualLtm.value, 1000)
assert.equal(annualLtm.unit, 'USD')
assert.equal(annualLtm.source, 'calculated')
const equityRatio = instantDerived.find((fact) => fact.metric === 'equity_ratio' && fact.periodEnd === '2026-03-31')
assert.ok(equityRatio)
assert.equal(equityRatio.value, 0.4)
const bps = instantDerived.find((fact) => fact.metric === 'bps' && fact.periodEnd === '2026-03-31')
assert.ok(bps)
assert.equal(bps.value, 17.5)
assert.deepEqual(bps.inputFactIds.length, 2)

const cutoffBeforeQ2 = normalizeAsOf('2026-04-30')
assert.equal(normalized.facts.some((fact) => fact.publishedAt <= cutoffBeforeQ2 && fact.disclosureId === 'q2-1'), false)
const cutoffAfterQ2 = normalizeAsOf('2026-05-02')
assert.equal(normalized.facts.some((fact) => fact.publishedAt <= cutoffAfterQ2 && fact.disclosureId === 'q2-1'), true)
assert.equal(normalized.facts.some((fact) => fact.publishedAt <= cutoffAfterQ2 && fact.disclosureId === 'q2-a'), false)

assert.deepEqual(secTickerAliases('BRK.B'), ['BRK-B', 'BRK.B'])

async function verifyStore() {
  const fixtureDb = path.join(os.tmpdir(), `stockboard-us-sec-companyfacts-${process.pid}.db`)
  fs.rmSync(fixtureDb, { force: true })
  process.env.EXTERNAL_STORAGE_REQUIRED = 'false'
  process.env.USE_LOCAL_DB = '1'
  process.env.STOCKBOARD_DB_PATH = fixtureDb
  delete process.env.SKIP_SCHEMA_ENSURE

  const [{ upsertNormalizedFinancialDataset }, { execGet, client }] = await Promise.all([
    import('@/lib/server/financial-foundation-store'),
    import('@/lib/db/client'),
  ])
  await upsertNormalizedFinancialDataset({
    disclosures: normalized.disclosures,
    facts: [...normalized.facts, ...derived, ...instantDerived],
    forecasts: [],
  }, 1_700_000_000, { deferDerivedAndMetrics: true })
  const stored = await execGet<{ disclosures: number; sourceFacts: number; derivedFacts: number }>(`
    SELECT
      (SELECT COUNT(*) FROM financial_disclosures WHERE source = 'sec_companyfacts') AS disclosures,
      (SELECT COUNT(*) FROM normalized_financial_facts WHERE source = 'sec_companyfacts') AS sourceFacts,
      (SELECT COUNT(*) FROM normalized_financial_facts WHERE source = 'calculated') AS derivedFacts
  `)
  assert.equal(Number(stored?.disclosures), normalized.disclosures.length)
  assert.equal(Number(stored?.sourceFacts), normalized.facts.length)
  assert.equal(Number(stored?.derivedFacts), derived.length + instantDerived.length)
  client.close()
  fs.rmSync(fixtureDb, { force: true })
}

verifyStore()
  .then(() => {
    console.log(JSON.stringify({
      status: 'PASS',
      disclosures: normalized.disclosures.length,
      sourceFacts: normalized.facts.length,
      derivedFacts: derived.length + instantDerived.length,
      ignored: normalized.ignored,
      store: 'PASS',
    }, null, 2))
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
