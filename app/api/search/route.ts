// app/api/search/route.ts
// Phase 3.5 で完全書き換え: Yahoo search の代わりに、
// ローカル ticker_universe と四季報分類を横断検索する。

import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const revalidate = 0

export function escapeSqlLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    if (q.length < 1) {
      return NextResponse.json([])
    }

    const escaped = escapeSqlLikeLiteral(q)
    const rows = await execAll<{
      ticker: string
      name: string | null
      sector17Name: string | null
      sector33Name: string | null
      marketSegment: string | null
      marginType: string | null
      majorCategory: string | null
      subIndustry: string | null
    }>(`
      WITH search_query(q, prefix_pattern, contains_pattern) AS (VALUES (?, ?, ?))
      SELECT
        u.ticker,
        u.name,
        u.sector17_name AS sector17Name,
        u.sector33_name AS sector33Name,
        u.market_segment AS marketSegment,
        u.margin_type AS marginType,
        c.major_category AS majorCategory,
        c.sub_industry AS subIndustry
      FROM ticker_universe u
      LEFT JOIN stock_classification c ON c.ticker = u.ticker
      CROSS JOIN search_query
      WHERE u.active = 1
        AND (
          u.ticker LIKE search_query.contains_pattern ESCAPE '\\'
          OR COALESCE(u.name, '') LIKE search_query.contains_pattern ESCAPE '\\'
          OR COALESCE(c.major_category, '') LIKE search_query.contains_pattern ESCAPE '\\'
          OR COALESCE(c.sub_industry, '') LIKE search_query.contains_pattern ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN u.ticker = search_query.q COLLATE NOCASE THEN 0
          WHEN COALESCE(u.name, '') = search_query.q COLLATE NOCASE THEN 1
          WHEN COALESCE(c.major_category, '') = search_query.q COLLATE NOCASE THEN 2
          WHEN COALESCE(c.sub_industry, '') = search_query.q COLLATE NOCASE THEN 3
          WHEN u.ticker LIKE search_query.prefix_pattern ESCAPE '\\' THEN 4
          WHEN COALESCE(u.name, '') LIKE search_query.prefix_pattern ESCAPE '\\' THEN 5
          WHEN COALESCE(c.major_category, '') LIKE search_query.prefix_pattern ESCAPE '\\' THEN 6
          WHEN COALESCE(c.sub_industry, '') LIKE search_query.prefix_pattern ESCAPE '\\' THEN 7
          ELSE 8
        END,
        u.ticker COLLATE NOCASE,
        u.ticker
      LIMIT 10
    `, [q, `${escaped}%`, `%${escaped}%`])

    return NextResponse.json(
      rows.map(r => ({
        ticker: r.ticker,
        name:   r.name ?? r.ticker,
        market: 'JP' as const,
        sector17Name: r.sector17Name,
        sector33Name: r.sector33Name,
        marketSegment: r.marketSegment,
        marginType: r.marginType,
        majorCategory: r.majorCategory,
        subIndustry: r.subIndustry,
      })),
    )
  } catch (error) {
    console.error('Search API error:', error)
    return NextResponse.json(
      { error: 'Search failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
