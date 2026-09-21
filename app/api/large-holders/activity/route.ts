import { enumParam, errorResponse, getRankingSnapshot, paginate, paging,
  responseMeta, withinPeriod } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const eventType = enumParam(params, 'eventType',
      ['ALL', 'NEW_5PCT', 'INCREASE', 'DECREASE', 'EXIT_5PCT'] as const, 'ALL')
    const investorClass = enumParam(params, 'investorClass',
      ['ALL', 'INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'] as const, 'ALL')
    const period = enumParam(params, 'period', ['7D', '30D', '90D', '1Y', 'ALL'] as const, '30D')
    const sort = enumParam(params, 'sort',
      ['obligation_desc', 'filing_desc', 'value_desc'] as const, 'obligation_desc')
    const { page, pageSize } = paging(params)
    const search = (params.get('search') ?? '').trim().toLocaleLowerCase('ja')
    if (search.length > 100) throw new Error('invalid_search')
    const market = params.get('market'), industry17 = params.get('industry17'),
      industry33 = params.get('industry33')
    const snapshot = await getRankingSnapshot()
    const investors = new Map(snapshot.investors.map((investor) => [investor.investorEntityId, investor]))
    const filings = new Map(snapshot.filings.map((filing) => [filing.documentId, filing]))
    const rows = snapshot.activities.flatMap((event) => {
      if (eventType !== 'ALL' && event.eventType !== eventType) return []
      if (investorClass !== 'ALL' && event.investorClass !== investorClass) return []
      if (period !== 'ALL' && !withinPeriod(event, snapshot.certificationAsOf, period)) return []
      const investor = investors.get(event.investorEntityId)
      if (!investor) return []
      const position = investor.positions.find((item) => item.ticker === event.ticker)
      if ((market && position?.market !== market) || (industry17 && position?.industry17 !== industry17)
        || (industry33 && position?.industry33 !== industry33)) return []
      if (search && !investor.displayName.toLocaleLowerCase('ja').includes(search)
        && !event.ticker.toLocaleLowerCase('ja').includes(search)
        && !(event.issuerName ?? '').toLocaleLowerCase('ja').includes(search)) return []
      const filing = filings.get(event.documentId)
      const fellowNames = (filing?.investorEntityIds ?? []).filter((id) => id !== event.investorEntityId)
        .map((id) => investors.get(id)?.displayName ?? id)
      return [{ ...event, investorName: investor.displayName, investorType: investor.investorType,
        market: position?.market ?? null, industry17: position?.industry17 ?? null,
        industry33: position?.industry33 ?? null, filingSourceUrl: filing?.sourceUrl ?? null,
        sourceVerified: filing?.sourceVerified ?? false, fellowNames }]
    }).sort((a, b) => sort === 'value_desc'
      ? (b.currentValueEquivalent ?? -1) - (a.currentValueEquivalent ?? -1)
      : sort === 'filing_desc' ? b.filingDate.localeCompare(a.filingDate)
        : b.obligationDate.localeCompare(a.obligationDate))
    return Response.json({ ...paginate(rows, page, pageSize), eventType, investorClass, period, sort,
      activityCoverage: snapshot.effectiveFilingArchiveComplete
        ? 'FULL_EFFECTIVE_FILINGS_CERTIFIED_INSTRUMENTS' : 'PARTIAL_VERIFIED_ONLY',
      ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
