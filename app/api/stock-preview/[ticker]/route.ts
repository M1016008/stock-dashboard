import { NextRequest, NextResponse } from 'next/server'
import { decodePathSegment } from '@/lib/url-path'
import { getStockPreview, StockPreviewInputError } from '@/lib/server/stock-preview-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const startedAt = Date.now()
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodePathSegment(rawTicker)
    const market = request.nextUrl.searchParams.get('market')?.toUpperCase() === 'US' ? 'US' : 'JP'
    const asOf = request.nextUrl.searchParams.get('as_of')
    const includeChart = request.nextUrl.searchParams.get('include') === 'chart'
    const result = await getStockPreview({ ticker, market, asOf, includeChart })
    if (!result) return NextResponse.json({ error: 'not_found', message: '銘柄データがありません。' }, { status: 404 })
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': asOf ? 'private, max-age=3600' : 'private, max-age=30',
        'Server-Timing': `stock-preview;dur=${Date.now() - startedAt}`,
      },
    })
  } catch (error) {
    if (error instanceof StockPreviewInputError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    console.error('Stock preview API error:', error)
    return NextResponse.json({ error: 'internal_error', message: 'データを取得できませんでした。' }, { status: 500 })
  }
}
