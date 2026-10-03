import { enumParam, errorResponse, getRankingSnapshot, paginate, paging,
  responseMeta } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const investorClass = enumParam(params, 'investorClass',
      ['ALL', 'INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'] as const, 'ALL')
    const sort = enumParam(params, 'sort', ['value_desc', 'name_asc', 'latest_filing_desc'] as const, 'value_desc')
    const { page, pageSize } = paging(params)
    const search = (params.get('search') ?? '').trim().toLocaleLowerCase('ja')
    if (search.length > 100) throw new Error('invalid_search')
    const investorType = params.get('investorType')
    const snapshot = await getRankingSnapshot()
    const rows = snapshot.investors.filter((investor) =>
      (investorClass === 'ALL' || investor.investorClass === investorClass)
      && (!investorType || investor.investorType === investorType)
      && (!search || investor.displayName.toLocaleLowerCase('ja').includes(search)
        || investor.aliases.some((alias) => alias.toLocaleLowerCase('ja').includes(search))))
      .map((investor) => ({ ...investor, positions: undefined }))
      .sort((a, b) => sort === 'name_asc' ? a.displayName.localeCompare(b.displayName, 'ja')
        : sort === 'latest_filing_desc'
          ? (b.latestFilingDate ?? '').localeCompare(a.latestFilingDate ?? '')
          : (b.estimatedCurrentValue ?? -1) - (a.estimatedCurrentValue ?? -1))
    return Response.json({ ...paginate(rows, page, pageSize), investorClass, sort,
      ...responseMeta(snapshot) })
  } catch (error) { return errorResponse(error) }
}
