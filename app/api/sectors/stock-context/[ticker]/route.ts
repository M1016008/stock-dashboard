import { NextRequest, NextResponse } from 'next/server'
import { parseUniverseFilter } from '@/lib/market-universe'
import { getStockSectorContext } from '@/lib/queries/stock-sector-context'
import { normalizeSectorStructureTaxonomy } from '@/lib/sector-stage-distribution'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker } = await params
    const search = request.nextUrl.searchParams
    const taxonomy = normalizeSectorStructureTaxonomy(search.get('taxonomy')) ?? 'major'
    const rawDate = search.get('date')
    const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
    const context = await getStockSectorContext({
      ticker: decodePathSegment(ticker),
      taxonomy,
      requestedDate: date,
      universe: parseUniverseFilter(search.get('universe')),
    })
    return NextResponse.json({ context }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    console.error('[stock-sector-context]', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'stock_sector_context_failed' }, { status: 500 })
  }
}
