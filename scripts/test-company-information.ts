import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { getCompanyInformationReadModel } from '@/lib/server/company-information-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const

async function main() {
  for (const ticker of TICKERS) {
    const startedAt = performance.now()
    const model = await getCompanyInformationReadModel(ticker, '2026-08-24')
    const elapsedMs = performance.now() - startedAt
    assert.ok(model, `${ticker}: company information is required`)
    assert.equal(model.contractVersion, 'company-information-v1')
    assert.equal(model.asOf, '2026-08-24')
    assert.ok(model.snapshot.publishedAt <= normalizeAsOf(model.asOf), `${ticker}: snapshot leaked after as_of`)
    assert.ok(model.overview.businessDescription?.text, `${ticker}: business description is required`)
    assert.ok(model.employees.latest.consolidated || model.employees.latest.nonConsolidated, `${ticker}: employees are required`)
    assert.ok(model.officers.officers.length > 0, `${ticker}: officers are required`)
    assert.ok(model.shareholders.major.length > 0, `${ticker}: major shareholders are required`)
    assert.ok(model.employees.history.every((row) => row.publishedAt <= normalizeAsOf(model.asOf)))
    console.log(JSON.stringify({
      ticker,
      elapsedMs: Math.round(elapsedMs),
      documentId: model.snapshot.documentId,
      periodEnd: model.snapshot.periodEnd,
      accountingStandard: model.identity.accountingStandard,
      edinetCode: model.identity.edinetCode,
      segments: model.coverage.segmentCount,
      employeeHistory: model.employees.history.length,
      officers: model.coverage.officerCount,
      majorShareholders: model.coverage.majorShareholderCount,
      policyHoldings: model.coverage.policyHoldingCount,
    }))
  }

  const toyota = await getCompanyInformationReadModel('7203', '2026-08-24')
  assert.ok(toyota)
  assert.equal(toyota.identity.edinetCode, 'E02144')
  assert.equal(toyota.identity.accountingStandard, 'IFRS')
  assert.equal(toyota.segmentInformation.segments.length, 4)
  assert.equal(toyota.employees.latest.consolidated?.employeeCount, 390_927)
  assert.equal(toyota.employees.latest.nonConsolidated?.employeeCount, 73_133)
  assert.equal(toyota.officers.officers.length, 10)
  assert.equal(toyota.shareholders.major.length, 10)
  assert.equal(toyota.shareholders.policy.length, 37)
  assert.ok((toyota.shareholders.policySummary.bookValueTotal ?? 0) > 0)

  const pit2025 = await getCompanyInformationReadModel('7203', '2025-06-30')
  assert.ok(pit2025)
  assert.equal(pit2025.snapshot.documentId, 'S100VWVY')
  assert.equal(pit2025.snapshot.periodEnd, '2025-03-31')
  assert.ok(pit2025.snapshot.publishedAt <= normalizeAsOf('2025-06-30'))

  const pit2026 = await getCompanyInformationReadModel('7203', '2026-06-30')
  assert.ok(pit2026)
  assert.equal(pit2026.snapshot.documentId, 'S100Y8NY')
  assert.equal(pit2026.snapshot.periodEnd, '2026-03-31')
  assert.ok(pit2026.snapshot.publishedAt <= normalizeAsOf('2026-06-30'))

  const beforeCoverage = await getCompanyInformationReadModel('7203', '2025-06-01')
  assert.equal(beforeCoverage, null, 'PIT before the first stored filing must not use future EDINET data')

  const warmStartedAt = performance.now()
  await getCompanyInformationReadModel('7203', '2026-08-24')
  const warmElapsedMs = performance.now() - warmStartedAt
  assert.ok(warmElapsedMs < 50, `company information cache read took ${warmElapsedMs.toFixed(1)}ms`)
  console.log(`Company information tests passed; cached 7203 read ${warmElapsedMs.toFixed(1)}ms`)
}

main().catch((error) => {
  console.error('Company information tests failed:', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
