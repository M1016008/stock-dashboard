import { errorResponse, getRankingSnapshot, responseMeta, withinPeriod } from '@/lib/server/large-holders/ranking-read-model'
import type { HolderActivity } from '@/lib/large-holders/ranking-core'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  try {
    const { ticker } = await context.params
    if (!/^[0-9A-Z]{4,6}$/.test(ticker)) return Response.json({ error: 'invalid_ticker' }, { status: 400 })
    const snapshot = await getRankingSnapshot()
    const quarantine = snapshot.quarantines?.filter((item) => item.ticker === ticker) ?? []
    const filings = new Map(snapshot.filings.map((filing) => [filing.documentId, filing]))
    const allActivities = snapshot.activities.filter((activity) => activity.ticker === ticker)
      .toSorted((a, b) => b.obligationDate.localeCompare(a.obligationDate)
        || b.filingDate.localeCompare(a.filingDate))
    const recentActivities = allActivities.filter((activity) =>
      withinPeriod(activity, snapshot.certificationDate, '90D'))
    const latestActivity = new Map<string, HolderActivity>()
    for (const activity of allActivities) {
      if (!latestActivity.has(activity.investorEntityId)) latestActivity.set(activity.investorEntityId, activity)
    }
    const holders = snapshot.investors.flatMap((investor) => investor.positions
      .filter((position) => position.ticker === ticker)
      .map((position) => ({ ...position, investorName: investor.displayName,
        investorClass: investor.investorClass, investorType: investor.investorType,
        investorEntityId: investor.investorEntityId,
        previousChange: latestActivity.get(investor.investorEntityId) ?? null,
        filingSourceUrl: filings.get(position.documentId)?.sourceUrl ?? null })))
    holders.sort((a, b) => (b.estimatedCurrentValue ?? -1) - (a.estimatedCurrentValue ?? -1))
    const currentHolders = holders.filter((holder) => holder.reportedShares != null
      ? holder.reportedShares > 0 : (holder.reportedHoldingPct ?? 0) > 0)
    const byClass = Object.fromEntries(['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED']
      .map((name) => [name, currentHolders.filter((holder) => holder.investorClass === name).length]))
    const activityCounts = Object.fromEntries(['NEW_5PCT', 'INCREASE', 'DECREASE', 'EXIT_5PCT']
      .map((type) => [type, recentActivities.filter((activity) => activity.eventType === type).length]))
    return Response.json({ ticker, issuerName: holders[0]?.issuerName ?? recentActivities[0]?.issuerName ?? null,
      currentState: quarantine.length ? 'CURRENT_STATE_BLOCKED_BY_SOURCE' : 'CURRENT',
      blockedSourceDocuments: quarantine,
      latestDisclosedLargeHolders: holders, holderCountByClass: byClass,
      totalObservedHolders: currentHolders.length, zeroPositionCount: holders.length - currentHolders.length,
      activityWindowEnd: snapshot.certificationDate,
      activityCounts, recentActivities: recentActivities.map((activity) => ({ ...activity,
        investorName: snapshot.investors.find((investor) => investor.investorEntityId === activity.investorEntityId)?.displayName ?? '—',
        filingSourceUrl: filings.get(activity.documentId)?.sourceUrl ?? null })),
      ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
