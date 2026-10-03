import { errorResponse, getRankingSnapshot, responseMeta } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) return Response.json({ error: 'invalid_investor_id' }, { status: 400 })
    const snapshot = await getRankingSnapshot()
    const investor = snapshot.investors.find((item) => item.investorEntityId === id)
    if (!investor) return Response.json({ error: 'investor_not_found' }, { status: 404 })
    const allocation = new Map<string, { estimatedCurrentValue: number; valuedPositionCount: number }>()
    for (const position of investor.positions) {
      if (position.estimatedCurrentValue == null) continue
      const sector = position.industry33 ?? '未分類'
      const bucket = allocation.get(sector) ?? { estimatedCurrentValue: 0, valuedPositionCount: 0 }
      bucket.estimatedCurrentValue += position.estimatedCurrentValue
      bucket.valuedPositionCount++
      allocation.set(sector, bucket)
    }
    const docIds = new Set(investor.positions.map((position) => position.documentId))
    const jointHolderEntityIds = [...new Set(investor.positions.flatMap((position) =>
      snapshot.investors.flatMap((peer) => peer.investorEntityId !== id
        && peer.positions.some((item) => item.documentId === position.documentId)
        ? [peer.investorEntityId] : [])))]
    const activity = snapshot.activities.filter((item) => item.investorEntityId === id)
      .toSorted((a, b) => b.obligationDate.localeCompare(a.obligationDate))
    return Response.json({ identity: { investorEntityId: id,
      displayName: investor.displayName, aliases: investor.aliases,
      investorClass: investor.investorClass, investorType: investor.investorType },
      portfolioSummary: { estimatedCurrentValue: investor.estimatedCurrentValue,
        ownershipEstimatedValue: investor.ownershipEstimatedValue,
        investmentAuthorityEstimatedValue: investor.investmentAuthorityEstimatedValue,
        votingAuthorityEstimatedValue: investor.votingAuthorityEstimatedValue,
        valuedPositionCount: investor.valuedPositionCount,
        totalRelevantPositionCount: investor.totalRelevantPositionCount,
        unvaluedPositionCount: investor.unvaluedPositionCount,
        portfolioCompleteness: investor.portfolioCompleteness,
        concentrationOfValuedPositions: investor.estimatedCurrentValue && investor.largestPositionValue
          ? investor.largestPositionValue / investor.estimatedCurrentValue : null },
      positions: investor.positions, sectorAllocation: [...allocation].map(([sector, values]) => ({ sector, ...values })),
      recentActivities: activity, filingTimeline: snapshot.filings.filter((filing) =>
        filing.investorEntityIds.includes(id))
        .toSorted((a, b) => b.filingDate.localeCompare(a.filingDate)),
      jointHolderEntityIds, evidenceSummary: {
        publicReadyPositionCount: investor.valuedPositionCount,
        officialDocumentCount: docIds.size, manifestSha256: snapshot.manifestSha256 },
      ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
