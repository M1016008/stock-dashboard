import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPublishedPointer, readSnapshotFile } from '@/lib/large-holders/snapshot-publication'
import { applyReviewDecisions, reviewDigest, reviewQueue } from '@/lib/large-holders/entity-review'
import { sha256 } from '@/lib/large-holders/evidence-provenance'
import { readReviewLedger } from './review-ledger'

export function largeHolderAdminAuthorized(request: Request): boolean {
  const expected = process.env.LARGE_HOLDER_ADMIN_TOKEN
  const supplied = request.headers.get('x-large-holder-admin-token')
  if (!expected || expected.length < 32 || !supplied) return false
  const left = Buffer.from(expected), right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function reviewAdminState() {
  const pointerPath = process.env.LARGE_HOLDER_RANKING_CURRENT_PATH
  const legacyPath = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
  const publication = pointerPath ? await readPublishedPointer(pointerPath) : null
  const basePath = publication && pointerPath
    ? join(dirname(pointerPath), `${publication.baseSnapshotId}.json`)
    : legacyPath
  if (!basePath) throw new Error('large_holder_snapshot_not_configured')
  const base = await readSnapshotFile(basePath)
  const evidenceDir = process.env.LARGE_HOLDER_EVIDENCE_DIR
    ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-evidence', 'phase-16a8')
  const manifestBytes = await readFile(join(evidenceDir, 'manifests', `${base.snapshot.manifestSha256}.json`))
  if (sha256(manifestBytes) !== base.snapshot.manifestSha256)
    throw new Error('review_certification_manifest_invalid')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { classificationLineages: {
    positionKey: string; decision: { confidence: string } }[] }
  const confidence = new Map(manifest.classificationLineages.map((lineage) =>
    [lineage.positionKey.slice('INVESTOR:'.length), lineage.decision.confidence]))
  const decisions = await readReviewLedger()
  const effective = applyReviewDecisions(base.snapshot, decisions)
  const queue = reviewQueue(effective, confidence)
  const counts = Object.fromEntries(['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED']
    .map((kind) => [kind, effective.investors.filter((row) => row.investorClass === kind).length]))
  return { base, publication, decisions, effective, queue, counts,
    reviewHash: reviewDigest(decisions),
    publishedReviewCurrent: publication
      ? publication.reviewHash === reviewDigest(decisions) : decisions.length === 0,
    documents: base.snapshot.filings.filter((row) => row.sourceVerified)
      .map((row) => ({ documentId: row.documentId, sourceSha256: row.sourceSha256,
        sourceUrl: row.sourceUrl, filingDate: row.filingDate,
        investorEntityIds: row.investorEntityIds })) }
}
