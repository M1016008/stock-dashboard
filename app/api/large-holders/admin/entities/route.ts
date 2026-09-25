import { randomUUID } from 'node:crypto'
import { INVESTOR_CATEGORIES } from '@/lib/large-holders/classification'
import { previewReviewDecision, type ReviewDecision } from '@/lib/large-holders/entity-review'
import { largeHolderAdminAuthorized, reviewAdminState } from '@/lib/server/large-holders/review-admin'
import { appendReviewDecision } from '@/lib/server/large-holders/review-ledger'
import { sha256 } from '@/lib/large-holders/evidence-provenance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!largeHolderAdminAuthorized(request))
    return Response.json({ error: 'admin_authorization_required' }, { status: 403 })
  try {
    const state = await reviewAdminState()
    return Response.json({ counts: state.counts, queue: state.queue, documents: state.documents,
      history: state.decisions, reviewHash: state.reviewHash,
      publishedReviewCurrent: state.publishedReviewCurrent,
      snapshotId: state.publication?.snapshotId ?? state.base.snapshotId },
      { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'entity_review_unavailable' }, { status: 503 }) }
}

export async function POST(request: Request) {
  if (!largeHolderAdminAuthorized(request)) return Response.json({ error: 'admin_authorization_required' }, { status: 403 })
  if (!process.env.LARGE_HOLDER_RANKING_CURRENT_PATH)
    return Response.json({ error: 'validated_snapshot_publication_required' }, { status: 503 })
  try {
    const body = await request.json() as { action?: string; decision?: Partial<ReviewDecision>;
      previewHash?: string }
    const item = body.decision
    if (!item || !['CLASSIFY', 'MERGE', 'UNDO'].includes(item.kind ?? '')
      || !['preview', 'commit'].includes(body.action ?? ''))
      return Response.json({ error: 'invalid_review_request' }, { status: 400 })
    if (item.kind === 'CLASSIFY' && (!item.entityId || !INVESTOR_CATEGORIES.includes(item.category as never)))
      return Response.json({ error: 'invalid_review_classification' }, { status: 400 })
    if (item.kind === 'MERGE' && (!item.sourceEntityId || !item.targetEntityId))
      return Response.json({ error: 'invalid_review_merge' }, { status: 400 })
    if (item.kind === 'UNDO' && !item.undoId)
      return Response.json({ error: 'invalid_review_undo' }, { status: 400 })
    const state = await reviewAdminState()
    const input = {
      kind: item.kind as ReviewDecision['kind'], entityId: item.entityId,
      category: item.category, sourceEntityId: item.sourceEntityId,
      targetEntityId: item.targetEntityId, undoId: item.undoId,
      evidence: item.evidence, note: item.note,
    }
    const preview = previewReviewDecision(state.base.snapshot, state.decisions, input)
    const previewHash = sha256(JSON.stringify({ input, reviewHash: state.reviewHash,
      baseSnapshotId: state.base.snapshotId }))
    if (body.action === 'preview') return Response.json({ preview, previewHash })
    if (body.previewHash !== previewHash)
      return Response.json({ error: 'review_preview_expired' }, { status: 409 })
    const decision = { ...preview.decision, id: randomUUID(), at: new Date().toISOString() }
    const appended = await appendReviewDecision(state.base.snapshot, decision)
    return Response.json({ decision, ...appended, snapshotRefreshRequired: true }, { status: 201 })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'review_unavailable'
    return Response.json({ error: reason }, { status: reason.startsWith('review_') ? 409 : 503 })
  }
}
