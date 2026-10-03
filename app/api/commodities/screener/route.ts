import { NextRequest, NextResponse } from 'next/server'
import {
  commodityGroupFromSearchParam,
  commodityLeverageFromSearchParam,
  commodityMarketFromSearchParam,
  commodityProductFromSearchParam,
  getCommodityScreener,
} from '@/lib/queries/commodities'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const result = await getCommodityScreener({
      market: commodityMarketFromSearchParam(searchParams.get('market')),
      group: commodityGroupFromSearchParam(searchParams.get('group')),
      productType: commodityProductFromSearchParam(searchParams.get('productType')),
      leverage: commodityLeverageFromSearchParam(searchParams.get('leverage')),
      stage: searchParams.get('stage') ?? 'all',
      q: searchParams.get('q') ?? '',
      sort: searchParams.get('sort') ?? 'return20',
      dir: searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
      limit: Number(searchParams.get('limit') ?? 200),
    })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Commodity screener API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch commodity screener', message: (error as Error).message },
      { status: 500 },
    )
  }
}
