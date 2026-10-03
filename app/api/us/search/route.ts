import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import { findUsAliasTickers, getUsDisplayName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    if (!q) return NextResponse.json([])
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`).toUpperCase()}%`
    const qUpper = q.toUpperCase()
    const aliasTickers = findUsAliasTickers(q)
    const aliasPlaceholders = aliasTickers.map(() => '?').join(',')
    const aliasFilter = aliasTickers.length ? ` OR ticker IN (${aliasPlaceholders})` : ''
    const aliasOrder = aliasTickers.length ? ` WHEN ticker IN (${aliasPlaceholders}) THEN 1` : ''
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
        AND ${usInvestableSymbolSql('ticker')}
        AND (ticker LIKE ? ESCAPE '\\' OR UPPER(COALESCE(name, '')) LIKE ? ESCAPE '\\'${aliasFilter})
      ORDER BY CASE WHEN ticker = ? THEN 0${aliasOrder} WHEN ticker LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, ticker
      LIMIT 10
      `,
      [pattern, pattern, ...aliasTickers, qUpper, ...aliasTickers, `${qUpper}%`],
    )
    return NextResponse.json(rows.map((row) => ({
      ticker: row.ticker,
      name: getUsDisplayName(row.ticker, row.name),
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
