import { NextResponse } from 'next/server'
import { getKabutanGoodBadDisclosureNews, getKabutanMaterialNews } from '@/lib/queries/kabutan-material-news'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const rawLimit = Number(url.searchParams.get('limit') ?? 12)
    const limit = Number.isFinite(rawLimit) ? Math.min(30, Math.max(1, Math.floor(rawLimit))) : 12
    const [material, goodBad] = await Promise.all([
      getKabutanMaterialNews(limit),
      getKabutanGoodBadDisclosureNews(Math.min(10, limit)),
    ])
    return NextResponse.json({
      articles: material.articles,
      goodBadArticles: goodBad.articles,
      lastRun: material.lastRun ?? goodBad.lastRun,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      { articles: [], goodBadArticles: [], lastRun: null, error: (error as Error).message },
      { status: 500 },
    )
  }
}
