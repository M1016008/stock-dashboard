import { errorResponse, getRankingSnapshot, responseMeta } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  try {
    const { ticker } = await context.params
    if (!/^[0-9A-Z]{4,6}$/.test(ticker)) return Response.json({ error: 'invalid_ticker' }, { status: 400 })
    const snapshot = await getRankingSnapshot()
    const holders = snapshot.investors.flatMap((investor) => investor.positions
      .filter((position) => position.ticker === ticker)
      .map((position) => ({ ...position, investorName: investor.displayName,
        investorClass: investor.investorClass, investorEntityId: investor.investorEntityId,
        previousChange: snapshot.activities.filter((activity) => activity.investorEntityId === investor.investorEntityId
          && activity.ticker === ticker).toSorted((a, b) => b.obligationDate.localeCompare(a.obligationDate))[0] ?? null })))
    if (!holders.length) return Response.json({ error: 'ticker_not_found' }, { status: 404 })
    holders.sort((a, b) => (b.estimatedCurrentValue ?? -1) - (a.estimatedCurrentValue ?? -1))
    const byClass = Object.fromEntries(['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED']
      .map((name) => [name, holders.filter((holder) => holder.investorClass === name).length]))
    return Response.json({ ticker, issuerName: holders[0].issuerName,
      latestDisclosedLargeHolders: holders, holderCountByClass: byClass,
      totalObservedHolders: holders.length, ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
