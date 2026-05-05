// app/api/search/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { searchTickers } from '@/lib/yahoo-finance'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''

    if (q.length < 1) {
      return NextResponse.json([])
    }

    const results = await searchTickers(q)
    return NextResponse.json(results)
  } catch (error) {
    console.error('Search API error:', error)
    return NextResponse.json(
      { error: 'Search failed', message: (error as Error).message },
      { status: 500 }
    )
  }
}
