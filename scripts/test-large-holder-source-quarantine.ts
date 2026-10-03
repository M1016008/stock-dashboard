import assert from 'node:assert/strict'
import { HolderCountMismatchError, parseLargeHolderFiling } from '@/lib/large-holders/filing'
import { reviewedSourceQuarantine } from '@/lib/large-holders/source-quarantine'
import { validateRankingSnapshot } from '@/lib/large-holders/snapshot-publication'
import { summarizeInvestor, type RankedPosition, type RankingSnapshot } from '@/lib/large-holders/ranking-core'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'

const version = '16a6-1'
const cases = [
  { id: 'S100Z34W', sha: 'b76ebaabaf1d65fbab54ce9952b3caf3436b85f813749d1bea0be15b6b5ab872',
    ticker: '7956', cover: 2, parsed: 3 },
  { id: 'S100Z3AM', sha: 'c3e063cfeb2f8fdbe188e32910d35981093eaf3ba25de27f36adb838d5c64ad3',
    ticker: '8136', cover: 6, parsed: 7 },
  { id: 'S100Z2WE', sha: '8bb22620485e05aa26c094779d70054bfc76ad2e96e964d09658bd34fe0ab760',
    ticker: '4502', cover: 13, parsed: 14 },
] as const

for (const item of cases) {
  const members = Array.from({ length: item.parsed }, (_, index) => ({
    member: `Holder${index + 1}Member`, name: `Holder ${index + 1}`,
    address: `Address ${index + 1}`, shares: item.id === 'S100Z3AM' && index === 4 ? 0 : 100,
  }))
  const error = new HolderCountMismatchError(item.id, item.cover, item.parsed,
    item.parsed, members, item.ticker, null, item.sha)
  const accepted = reviewedSourceQuarantine(error, version)
  assert.equal(accepted?.disposition, 'QUARANTINED_SOURCE_INCONSISTENCY')
  assert.equal(accepted?.reviewStatus, 'APPROVED_FOR_QUARANTINE')
  assert.equal(accepted?.reviewVersion, item.id === 'S100Z2WE' ? '16D-4' : '16D-2')
  assert.equal(accepted?.affectedHolderMembers.length, item.parsed)
  assert.equal(reviewedSourceQuarantine(new HolderCountMismatchError(item.id,
    item.cover, item.parsed, item.parsed, members, item.ticker, null,
    '0'.repeat(64)), version), null, 'changed official source must return to review')
  assert.equal(reviewedSourceQuarantine(new HolderCountMismatchError('S100UNKNOWN',
    item.cover, item.parsed, item.parsed, members, item.ticker, null,
    item.sha), version), null, 'unknown mismatch must not auto-quarantine')
  assert.equal(reviewedSourceQuarantine(new HolderCountMismatchError(item.id,
    item.cover, item.parsed - 1, item.parsed, members, item.ticker, null,
    item.sha), version), null, 'changed legal holder count must return to review')
}

const digest = 'a'.repeat(64)
const base: RankingSnapshot = {
  version: 1, certificationAsOf: '2026-09-18', certificationDate: '2026-09-22',
  manifestSha256: digest, activityEvidenceManifestSha256: null,
  effectiveFilingArchiveComplete: true, latestEdinetDataAt: null,
  latestPositionDate: null, priceDate: '2026-09-18',
  filingWatermark: { count: 0, maxImportedAt: null, maxSubmittedAt: null },
  positionFingerprintSha256: digest, publicCurrentValuationReadyCount: 20,
  currentPositionCount: 0, investors: [], activities: [], filings: [{
    documentId: 'PRIOR', filingType: 'CHANGE', filingDate: '2026-09-01',
    obligationDate: '2026-08-31', issuerName: 'prior', ticker: '7956',
    sourceUrl: 'https://example.test', sourceSha256: digest,
    sourceVerified: true, rootFilingId: 'PRIOR', isCorrection: false,
    investorEntityIds: [],
  }],
  quarantines: cases.map((item) => ({ documentId: item.id, ticker: item.ticker,
    issuerName: null, reasonCode: 'HOLDER_COUNT_INTERNAL_INCONSISTENCY',
    sourceSha256: item.sha, affectedHolderCount: item.parsed })),
  quarantineMetadata: { quarantinedDocumentCount: 3, quarantinedPositionScopeCount: 24,
    affectedIssuerCount: 3, affectedInvestorCount: 0,
    quarantineReasons: { HOLDER_COUNT_INTERNAL_INCONSISTENCY: 3 } },
}
assert.throws(() => validateRankingSnapshot(base), /snapshot_quarantine_population_invalid/)
const blockedOnly = summarizeInvestor({ investorEntityId: 'known-prior', displayName: 'Prior',
  investorClass: 'UNCLASSIFIED', investorType: 'UNCLASSIFIED', aliases: [],
  positions: [], blockedPositionCount: 1 })
assert.equal(blockedOnly.portfolioCompleteness, 'NONE')
assert.equal(blockedOnly.totalRelevantPositionCount, 1)
const partial = summarizeInvestor({ investorEntityId: 'known-prior', displayName: 'Prior',
  investorClass: 'UNCLASSIFIED', investorType: 'UNCLASSIFIED', aliases: [],
  positions: [{ estimatedCurrentValue: 100, holdingBasis: 'OWNERSHIP', ticker: '7203',
    reportedHoldingPct: 5 } as RankedPosition], blockedPositionCount: 1 })
assert.equal(partial.portfolioCompleteness, 'PARTIAL')
assert.equal(partial.estimatedCurrentValue, 100)
assert.equal(partial.totalRelevantPositionCount, 2)
const fixturePath = process.env.PHASE16D_SOURCE_FIXTURE_DB
if (fixturePath) {
  if (!fixturePath.includes('/stock-dashboard/qa/phase16d-shadow/'))
    throw new Error('source_fixture_must_be_shadow')
  const db = new DatabaseSync(fixturePath, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    for (const item of cases) {
      const row = db.prepare(`SELECT f.raw_index_json,s.xbrl_xml
        FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
        WHERE f.document_id=?`).get(item.id) as { raw_index_json: string; xbrl_xml: string }
      assert.ok(row, `official fixture ${item.id} must exist`)
      assert.throws(() => parseLargeHolderFiling(JSON.parse(row.raw_index_json), row.xbrl_xml),
        (error: unknown) => error instanceof HolderCountMismatchError
          && reviewedSourceQuarantine(error, version)?.documentId === item.id)
      assert.throws(() => parseLargeHolderFiling(JSON.parse(row.raw_index_json), `${row.xbrl_xml} `),
        (error: unknown) => error instanceof HolderCountMismatchError
          && reviewedSourceQuarantine(error, version) === null)
    }
    const newlyReviewed = db.prepare(`SELECT f.raw_index_json,s.xbrl_xml
      FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
      WHERE f.document_id='S100Z2WE'`).get() as { raw_index_json: string; xbrl_xml: string } | undefined
    if (newlyReviewed) assert.throws(() => parseLargeHolderFiling(JSON.parse(newlyReviewed.raw_index_json), newlyReviewed.xbrl_xml),
      (error: unknown) => error instanceof HolderCountMismatchError
        && error.coverDeclaredCount === 13 && error.parsedLegalHolderCount === 14
        && reviewedSourceQuarantine(error, version)?.reviewVersion === '16D-4',
      'only the reviewed official source may be quarantined')
  } finally { db.close() }
}
assert.equal(cases[0].cover, 2)
assert.equal(cases[1].parsed, 7)
console.log('large-holder source quarantine: PASS')
