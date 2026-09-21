import { errorResponse, getRankingSnapshot, responseMeta } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ docId: string }> }) {
  try {
    const { docId } = await context.params
    if (!/^[A-Za-z0-9]{5,40}$/.test(docId)) return Response.json({ error: 'invalid_document_id' }, { status: 400 })
    const snapshot = await getRankingSnapshot()
    const filing = snapshot.filings.find((item) => item.documentId === docId)
    if (!filing) return Response.json({ error: 'filing_not_found' }, { status: 404 })
    const positions = snapshot.investors.flatMap((investor) => investor.positions
      .filter((position) => position.documentId === docId)
      .map((position) => ({ ...position, investorName: investor.displayName,
        investorClass: investor.investorClass })))
    return Response.json({ filing, positions,
      evidence: { authority: 'EDINET', documentId: docId,
        officialReference: filing.sourceUrl, sourceSha256: filing.sourceSha256,
        hashStatus: filing.sourceVerified ? 'VERIFIED_AT_SNAPSHOT_BUILD' : 'UNVERIFIED',
        manifestSha256: snapshot.manifestSha256 }, ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
