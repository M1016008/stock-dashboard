import { basisValue, enumParam, errorResponse, getRankingSnapshot, paginate, paging,
  responseMeta, withinPeriod } from '@/lib/server/large-holders/ranking-read-model'
import { summarizeInvestor } from '@/lib/large-holders/ranking-core'
import type { HolderActivity, InvestorSummary } from '@/lib/large-holders/ranking-core'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const classes = ['ALL', 'INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'] as const
const types = ['TOTAL_VALUE', 'RECENT_INCREASE', 'NEW_5PCT', 'DECREASE'] as const
const periods = ['7D', '30D', '90D', '1Y'] as const
const bases = ['OWNERSHIP', 'INVESTMENT_AUTHORITY'] as const
const completenesses = ['ALL', 'COMPLETE', 'PARTIAL', 'NONE'] as const
const sorts = ['value_desc', 'value_asc', 'name_asc', 'latest_filing_desc'] as const

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const investorClass = enumParam(params, 'investorClass', classes, 'ALL')
    const rankingType = enumParam(params, 'rankingType', types, 'TOTAL_VALUE')
    const period = enumParam(params, 'period', periods, '30D')
    const basis = enumParam(params, 'basis', bases, 'OWNERSHIP')
    const completeness = enumParam(params, 'completeness', completenesses, 'ALL')
    const sort = enumParam(params, 'sort', sorts, 'value_desc')
    const { page, pageSize } = paging(params)
    const market = params.get('market'), industry17 = params.get('industry17'),
      industry33 = params.get('industry33')
    const search = (params.get('search') ?? '').trim().toLocaleLowerCase('ja')
    if (search.length > 100) throw new Error('invalid_search')
    const snapshot = await getRankingSnapshot()
    const eligible = snapshot.investors.filter((investor) =>
      (investorClass === 'ALL' || investor.investorClass === investorClass)
      && (completeness === 'ALL' || investor.portfolioCompleteness === completeness)
      && (!search || investor.displayName.toLocaleLowerCase('ja').includes(search)
        || investor.aliases.some((alias) => alias.toLocaleLowerCase('ja').includes(search))))
    const positionMatches = (position: InvestorSummary['positions'][number]) =>
      (!market || position.market === market) && (!industry17 || position.industry17 === industry17)
      && (!industry33 || position.industry33 === industry33)
    const byId = new Map(eligible.map((investor) => [investor.investorEntityId, investor]))
    const latestActivity = new Map<string, HolderActivity>()
    for (const activity of snapshot.activities) {
      const previous = latestActivity.get(activity.investorEntityId)
      if (!previous || activity.obligationDate > previous.obligationDate)
        latestActivity.set(activity.investorEntityId, activity)
    }
    const compare = (a: { value: number | null; name: string; date: string | null },
      b: { value: number | null; name: string; date: string | null }) => {
      if (sort === 'name_asc') return a.name.localeCompare(b.name, 'ja')
      if (sort === 'latest_filing_desc') return (b.date ?? '').localeCompare(a.date ?? '')
      if (a.value == null) return b.value == null ? a.name.localeCompare(b.name, 'ja') : 1
      if (b.value == null) return -1
      return (sort === 'value_asc' ? a.value - b.value : b.value - a.value)
        || a.name.localeCompare(b.name, 'ja')
    }
    if (rankingType === 'TOTAL_VALUE') {
      const rows = eligible.filter((investor) => investor.positions.some(positionMatches))
        .map((investor) => {
          const selected = market || industry17 || industry33
            ? summarizeInvestor({ investorEntityId: investor.investorEntityId,
              displayName: investor.displayName, investorClass: investor.investorClass,
              investorType: investor.investorType, aliases: investor.aliases,
              positions: investor.positions.filter(positionMatches) }) : investor
          const largestOnBasis = selected.positions.filter((position) => position.holdingBasis === basis
            && position.estimatedCurrentValue != null)
            .toSorted((a, b) => b.estimatedCurrentValue! - a.estimatedCurrentValue!)[0]
          return { ...investor, positions: undefined,
            selectedPositionCount: selected.totalRelevantPositionCount,
            selectedValuedPositionCount: selected.valuedPositionCount,
            selectedPortfolioCompleteness: selected.portfolioCompleteness,
            latestActivityType: latestActivity.get(investor.investorEntityId)?.eventType ?? null,
            latestActivityDate: latestActivity.get(investor.investorEntityId)?.obligationDate ?? null,
            rankingLargestPositionTicker: largestOnBasis?.ticker ?? null,
            rankingLargestPositionValue: largestOnBasis?.estimatedCurrentValue ?? null,
            rankingBasis: basis, rankingValue: basisValue(selected, basis),
            rankingValueLabel: basis === 'OWNERSHIP' ? '所有等ベース推定時価' : '運用権限ベース推定時価' }
        })
        .sort((a, b) => compare({ value: a.rankingValue, name: a.displayName, date: a.latestFilingDate },
          { value: b.rankingValue, name: b.displayName, date: b.latestFilingDate }))
      return Response.json({ ...paginate(rows, page, pageSize), rankingType, investorClass,
        basis, completeness, sort, ...responseMeta(snapshot) })
    }
    const eventType = rankingType === 'RECENT_INCREASE' ? 'INCREASE'
      : rankingType === 'DECREASE' ? 'DECREASE' : 'NEW_5PCT'
    const events = snapshot.activities.filter((activity) => activity.eventType === eventType
      && byId.has(activity.investorEntityId)
      && withinPeriod(activity, snapshot.certificationAsOf, period)
      && activity.holdingBasis === basis
      && byId.get(activity.investorEntityId)!.positions.some((position) =>
        position.ticker === activity.ticker && positionMatches(position)))
    const coverage = { activityCoverage: snapshot.effectiveFilingArchiveComplete
      ? 'FULL_EFFECTIVE_FILINGS_CERTIFIED_INSTRUMENTS' : 'PARTIAL_VERIFIED_ONLY',
    activityCoverageWarning: snapshot.effectiveFilingArchiveComplete
      ? '全有効開示の公式原本を照合済み。同一認定証券クラスと現行公開評価可能Positionの変化のみを集計。未観測の5%未満保有等は対象外。'
      : '前後の公式原本と同一証券クラスを照合できたイベントのみ。0件は変化なしを意味しません。' }
    if (rankingType === 'NEW_5PCT') {
      const rows = events.map((event) => ({ ...event,
        investorName: byId.get(event.investorEntityId)!.displayName,
        estimatedCurrentValue: event.currentValueEquivalent }))
        .sort((a, b) => compare({ value: a.estimatedCurrentValue, name: a.investorName, date: a.filingDate },
          { value: b.estimatedCurrentValue, name: b.investorName, date: b.filingDate }))
      return Response.json({ ...paginate(rows, page, pageSize), rankingType, period, investorClass,
        basis, sort, activityCount: events.length, ...coverage, ...responseMeta(snapshot) })
    }
    const grouped = new Map<string, HolderActivity[]>()
    for (const event of events) grouped.set(event.investorEntityId,
      [...(grouped.get(event.investorEntityId) ?? []), event])
    const rows = [...grouped].map(([id, items]) => {
      const investor = byId.get(id)!
      return { investorEntityId: id, displayName: investor.displayName,
        investorClass: investor.investorClass,
        currentValueEquivalent: items.reduce((sum, item) => sum + (item.currentValueEquivalent ?? 0), 0),
        activityCount: items.length, tickerCount: new Set(items.map((item) => item.ticker)).size,
        latestActivityDate: items.reduce((max, item) => item.obligationDate > max ? item.obligationDate : max, ''),
        events: items.toSorted((a, b) => b.obligationDate.localeCompare(a.obligationDate)),
        portfolioCompleteness: investor.portfolioCompleteness,
      }
    }).sort((a, b) => compare({ value: a.currentValueEquivalent, name: a.displayName,
      date: a.latestActivityDate }, { value: b.currentValueEquivalent, name: b.displayName,
      date: b.latestActivityDate }))
    return Response.json({ ...paginate(rows, page, pageSize), rankingType, period, investorClass,
      basis, sort, activityCount: events.length,
      activityValueLabel: rankingType === 'RECENT_INCREASE'
        ? '増加株式の現在時価換算' : '減少株式の現在時価換算',
      ...coverage, ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
