import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { sha256 } from '@/lib/large-holders/evidence-provenance'
import { applyReviewDecisions, previewReviewDecision, reviewDigest, reviewQueue,
  type ReviewDecision } from '@/lib/large-holders/entity-review'
import { summarizeInvestor, type RankedPosition, type RankingSnapshot } from '@/lib/large-holders/ranking-core'
import { publishValidatedSnapshot, readPublishedSnapshot, writeImmutableSnapshot } from '@/lib/large-holders/snapshot-publication'
import { appendReviewDecision, readReviewLedger } from '@/lib/server/large-holders/review-ledger'
import { priceUpdateCompleted } from '@/lib/server/large-holders/current-fingerprint'
import { largeHolderAdminAuthorized } from '@/lib/server/large-holders/review-admin'

const sourceHash = 'a'.repeat(64)
const certHash = 'b'.repeat(64)
const positionHash = 'c'.repeat(64)
const currentHash = 'd'.repeat(64)
const classHash = 'e'.repeat(64)

function fixture(): RankingSnapshot {
  const investors = Array.from({ length: 20 }, (_, index) => {
    const id = `entity-${index + 1}`
    const position: RankedPosition = { positionKey: `p-${index + 1}`, documentId: `DOC${index + 1}`,
      investorEntityId: id, ticker: String(7000 + index), issuerName: `Issuer ${index + 1}`,
      reportedShares: 1000, reportedHoldingPct: 6, certifiedUnits: 1000,
      estimatedCurrentValue: (index + 1) * 100_000, holdingBasis: 'OWNERSHIP',
      filingDate: '2026-09-20', obligationDate: '2026-09-18', holdingInformationDate: '2026-09-18',
      priceDate: '2026-09-22', valuationStatus: 'PUBLIC_CURRENT_VALUATION_READY',
      market: 'プライム', industry17: '機械', industry33: '機械',
      source: { authority: 'EDINET', documentId: `DOC${index + 1}`, sourceSha256: sourceHash } }
    return summarizeInvestor({ investorEntityId: id,
      displayName: index < 2 ? '同名投資家' : `Investor ${index + 1}`,
      investorClass: index === 0 ? 'UNCLASSIFIED' : 'INSTITUTIONAL',
      investorType: index === 0 ? 'UNCLASSIFIED' : 'FUND', aliases: [], positions: [position] })
  })
  return { version: 1, certificationAsOf: '2026-09-22', certificationDate: '2026-09-22',
    manifestSha256: certHash, activityEvidenceManifestSha256: null,
    effectiveFilingArchiveComplete: true, latestEdinetDataAt: '2026-09-20T12:00:00',
    latestPositionDate: '2026-09-18', priceDate: '2026-09-22',
    filingWatermark: { count: 20, maxImportedAt: 1, maxSubmittedAt: '2026-09-20T12:00:00' },
    positionFingerprintSha256: positionHash, publicCurrentValuationReadyCount: 20,
    currentPositionCount: 20, investors, activities: [],
    filings: investors.map((row, index) => ({ documentId: `DOC${index + 1}`,
      filingType: 'INITIAL', filingDate: '2026-09-20', obligationDate: '2026-09-18',
      issuerName: `Issuer ${index + 1}`, ticker: String(7000 + index),
      sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100TEST${index + 1}`,
      sourceSha256: sourceHash, sourceVerified: true, rootFilingId: `DOC${index + 1}`,
      isCorrection: false, investorEntityIds: [row.investorEntityId] })) }
}

const evidence = { documentId: 'DOC1', sourceSha256: sourceHash,
  note: 'Official EDINET holder field establishes the identity.' }
async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'stockboard-large-holder-ops-'))
  try {
  process.env.STOCKBOARD_DB_PATH = join(dir, 'fixture.db')
  const priorAdminToken = process.env.LARGE_HOLDER_ADMIN_TOKEN
  process.env.LARGE_HOLDER_ADMIN_TOKEN = 'test-admin-token-with-at-least-32-characters'
  assert.equal(largeHolderAdminAuthorized(new Request('http://localhost/admin')), false)
  assert.equal(largeHolderAdminAuthorized(new Request('http://localhost/admin', {
    headers: { 'x-large-holder-admin-token': 'wrong-token' },
  })), false)
  assert.equal(largeHolderAdminAuthorized(new Request('http://localhost/admin', {
    headers: { 'x-large-holder-admin-token': process.env.LARGE_HOLDER_ADMIN_TOKEN },
  })), true)
  if (priorAdminToken === undefined) delete process.env.LARGE_HOLDER_ADMIN_TOKEN
  else process.env.LARGE_HOLDER_ADMIN_TOKEN = priorAdminToken
  const db = new DatabaseSync(process.env.STOCKBOARD_DB_PATH)
  try {
    db.exec(`CREATE TABLE ohlcv_daily (ticker TEXT, date TEXT);
      CREATE TABLE jquants_daily_coverage (date TEXT, expected_rows INTEGER);
      CREATE TABLE jquants_sync_runs (id INTEGER PRIMARY KEY, target_date TEXT, api_type TEXT,
        expected_rows INTEGER, status TEXT, finished_at INTEGER);
      CREATE TABLE batch_runs (id INTEGER PRIMARY KEY, job_type TEXT, status TEXT,
        succeeded INTEGER, finished_at INTEGER);
      INSERT INTO jquants_daily_coverage VALUES ('2026-09-22',2);
      INSERT INTO jquants_sync_runs VALUES
        (1,'2026-09-22','equities/bars/daily:date',2,'success',100);
      INSERT INTO batch_runs VALUES (1,'update_latest','success',1,101);
      INSERT INTO ohlcv_daily VALUES ('7003','2026-09-22');`)
    assert.equal(priceUpdateCompleted(db, '2026-09-22'), false,
      'a partial price date must not become a published valuation date')
    db.exec(`INSERT INTO ohlcv_daily VALUES ('7203','2026-09-22')`)
    assert.equal(priceUpdateCompleted(db, '2026-09-22'), true)
    db.exec(`INSERT INTO batch_runs VALUES (2,'update_latest','failed',0,102)`)
    assert.equal(priceUpdateCompleted(db, '2026-09-22'), false,
      'the latest failed update must close the price completion gate')
    db.exec(`INSERT INTO batch_runs VALUES (3,'update_latest','partial',1,103)`)
    assert.equal(priceUpdateCompleted(db, '2026-09-22'), true,
      'a completed required update with optional failures retains the price proof')
    db.exec(`INSERT INTO jquants_sync_runs VALUES
      (2,'2026-09-22','equities/bars/daily:date',2,'running',104)`)
    assert.equal(priceUpdateCompleted(db, '2026-09-22'), false)
  } finally { db.close() }
  const ledgerPath = join(dir, 'review.ndjson')
  const base = fixture()
  const queue = reviewQueue(base)
  assert.equal(queue.find((item) => item.investorEntityId === 'entity-1')?.reasons.includes('UNCLASSIFIED'), true)
  assert.equal(queue.find((item) => item.investorEntityId === 'entity-1')?.possibleMatches.includes('entity-2'), true)
  const classify: ReviewDecision = { id: randomUUID(), at: new Date().toISOString(),
    kind: 'CLASSIFY', entityId: 'entity-1', category: 'INDIVIDUAL', evidence }
  const classified = applyReviewDecisions(base, [classify])
  assert.equal(classified.investors[0].investorClass, 'INDIVIDUAL')
  assert.equal(base.investors[0].investorClass, 'UNCLASSIFIED')
  assert.equal(classified.currentPositionCount, 20)
  assert.throws(() => applyReviewDecisions(base, [{ ...classify, evidence: { ...evidence,
    sourceSha256: 'f'.repeat(64) } }]), /review_official_source_unverified/)

  const merge: ReviewDecision = { id: randomUUID(), at: new Date().toISOString(),
    kind: 'MERGE', sourceEntityId: 'entity-1', targetEntityId: 'entity-2', evidence }
  const preview = previewReviewDecision(base, [], { kind: 'MERGE', sourceEntityId: 'entity-1',
    targetEntityId: 'entity-2', evidence })
  assert.equal(preview.before.investorCount, 20)
  assert.equal(preview.after.investorCount, 19)
  assert.equal(preview.before.combinedValue, preview.after.combinedValue)
  assert.equal(preview.after.positionCount, 20)
  const merged = applyReviewDecisions(base, [merge])
  assert.equal(merged.investors.find((item) => item.investorEntityId === 'entity-2')?.positions.length, 2)
  assert.equal(merged.investors.some((item) => item.investorEntityId === 'entity-1'), false)
  const overlapping = fixture()
  overlapping.investors[1].positions[0].ticker = '7000'
  assert.throws(() => applyReviewDecisions(overlapping, [merge]), /review_merge_position_overlap/)
  const duplicateActivity = fixture()
  const event = { eventType: 'NEW_5PCT' as const, investorEntityId: 'entity-1',
    investorClass: 'UNCLASSIFIED' as const, ticker: '7000', issuerName: 'Issuer 1',
    documentId: 'DOC1', filingDate: '2026-09-20', obligationDate: '2026-09-18',
    reportedHoldingPct: 6, previousHoldingPct: null, reportedShares: 1000,
    sharesDelta: null, holdingPctDelta: null, currentValueEquivalent: 100_000,
    holdingBasis: 'OWNERSHIP' as const, priceDate: '2026-09-22' }
  duplicateActivity.activities.push(event, event)
  await assert.rejects(writeImmutableSnapshot(join(dir, 'duplicate'), duplicateActivity),
    /snapshot_population_invalid/)
  assert.equal(applyReviewDecisions(base, [merge, {
    id: randomUUID(), at: new Date().toISOString(), kind: 'UNDO', undoId: merge.id,
    note: 'Incorrect identity adjudication.',
  }]).investors.length, 20)

  const saved = await appendReviewDecision(base, classify, ledgerPath)
  assert.equal(saved.count, 1)
  assert.deepEqual(await readReviewLedger(ledgerPath), [classify])
  const undo: ReviewDecision = { id: randomUUID(), at: new Date().toISOString(),
    kind: 'UNDO', undoId: classify.id, note: 'Official source was reinterpreted.' }
  await appendReviewDecision(base, undo, ledgerPath)
  assert.equal(applyReviewDecisions(base, await readReviewLedger(ledgerPath)).investors[0].investorClass,
    'UNCLASSIFIED')

  const rankingDir = join(dir, 'rankings')
  const pointerPath = join(rankingDir, 'current.json')
  const basePath = await writeImmutableSnapshot(rankingDir, base)
  const baseId = basePath.split('/').at(-1)!.replace('.json', '')
  const publish = (snapshotId: string, reviewHash: string, sourceFilingCount = base.filingWatermark.count) => publishValidatedSnapshot(pointerPath, {
    snapshotId, baseSnapshotId: baseId, generatedAt: new Date().toISOString(),
    sourceEdinetCutoff: base.latestEdinetDataAt, priceDate: base.priceDate,
    sourceFilingCount,
    sourceLatestImportedAt: base.filingWatermark.maxImportedAt,
    sourceLatestSubmittedAt: base.filingWatermark.maxSubmittedAt,
    positionHash, currentPositionHash: currentHash, certificationHash: certHash,
    classificationHash: classHash, reviewHash })
  assert.equal(await publish(baseId, reviewDigest([])), 'PUBLISHED')
  assert.equal(await publish(baseId, reviewDigest([])), 'UNCHANGED')
  assert.equal(await publish(baseId, reviewDigest([]), 21), 'PUBLISHED',
    'verified historical-only backfill must update the source watermark without rewriting the snapshot')
  assert.equal((await readPublishedSnapshot(pointerPath)).publication.sourceFilingCount, 21)
  assert.equal(await publish(baseId, reviewDigest([]), 21), 'UNCHANGED')
  const repriced = structuredClone(base)
  repriced.priceDate = '2026-09-23'
  repriced.certificationAsOf = '2026-09-23'
  repriced.investors[0].positions[0].estimatedCurrentValue = 200_000
  const repricedPath = await writeImmutableSnapshot(rankingDir, repriced)
  assert.notEqual(repricedPath, basePath, 'new price/value must produce a new immutable snapshot')
  const reviewedPath = await writeImmutableSnapshot(rankingDir, classified)
  const reviewedId = reviewedPath.split('/').at(-1)!.replace('.json', '')
  assert.equal((await readPublishedSnapshot(pointerPath)).publication.snapshotId, baseId,
    'crash before pointer swap must leave old snapshot current')
  assert.equal(await publish(reviewedId, reviewDigest([classify])), 'PUBLISHED')
  assert.equal((await readPublishedSnapshot(pointerPath)).publication.snapshotId, reviewedId)
  await writeFile(ledgerPath, (await readFile(ledgerPath, 'utf8')).replace('CLASSIFY', 'CLASSIFX'))
  await assert.rejects(readReviewLedger(ledgerPath), /review_ledger_integrity_failed/)
  const shadowRoot = join(dir, 'stock-dashboard', 'qa', 'phase16d-shadow', 'run')
  const shadowRankingDir = join(shadowRoot, 'rankings')
  const priorShadowQa = process.env.PHASE16D_SHADOW_QA
  const priorFailpoint = process.env.PHASE16D_SHADOW_FAIL_AT
  const priorDbPath = process.env.STOCKBOARD_DB_PATH
  try {
    process.env.PHASE16D_SHADOW_QA = '1'
    process.env.PHASE16D_SHADOW_FAIL_AT = 'SNAPSHOT_GENERATION'
    process.env.STOCKBOARD_DB_PATH = join(shadowRoot, 'shadow.db')
    await assert.rejects(writeImmutableSnapshot(shadowRankingDir, base),
      /phase16d_shadow_controlled_failure:SNAPSHOT_GENERATION/)
    assert.deepEqual(await readdir(shadowRankingDir), [],
      'failed materialization must remove the temporary snapshot')
  } finally {
    if (priorShadowQa === undefined) delete process.env.PHASE16D_SHADOW_QA
    else process.env.PHASE16D_SHADOW_QA = priorShadowQa
    if (priorFailpoint === undefined) delete process.env.PHASE16D_SHADOW_FAIL_AT
    else process.env.PHASE16D_SHADOW_FAIL_AT = priorFailpoint
    if (priorDbPath === undefined) delete process.env.STOCKBOARD_DB_PATH
    else process.env.STOCKBOARD_DB_PATH = priorDbPath
  }
  console.log('large-holder review and atomic publication: PASS')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
