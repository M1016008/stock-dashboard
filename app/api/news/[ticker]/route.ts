// app/api/news/[ticker]/route.ts
import { NextResponse } from 'next/server'
import { fetchStockNews } from '@/lib/news'

export const revalidate = 1800 // 30分キャッシュ

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params
  try {
    const data = await fetchStockNews(decodeURIComponent(ticker))
    return NextResponse.json(data)
  } catch (error) {
    console.error('news API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch news', message: (error as Error).message },
      { status: 500 },
    )
  }
}
