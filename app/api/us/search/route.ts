import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    if (!q) return NextResponse.json([])
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`).toUpperCase()}%`
    const rows = await execAll<{
      ticker: string
      name: string | null
      exchange: string | null
      sector: string | null
      industry: string | null
      asset_type: string | null
    }>(
      `
      SELECT ticker, name, exchange, sector, industry, asset_type
      FROM market_universe
      WHERE market = 'US' AND active = 1
        AND (ticker LIKE ? ESCAPE '\\' OR UPPER(COALESCE(name, '')) LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN ticker = ? THEN 0 WHEN ticker LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ticker
      LIMIT 10
      `,
      [pattern, pattern, q.toUpperCase(), `${q.toUpperCase()}%`],
    )
    return NextResponse.json(rows.map((row) => ({
      ticker: row.ticker,
      name: row.name ?? row.ticker,
      market: 'US' as const,
      exchange: row.exchange,
      sectorName: row.sector,
      industryName: row.industry,
      assetType: row.asset_type,
    })))
  } catch (error) {
    console.error('US search API error:', error)
    return NextResponse.json(
      { error: 'US search failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
