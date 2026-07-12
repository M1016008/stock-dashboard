import { NextResponse } from 'next/server'
import { getKabutanThemes } from '@/lib/queries/kabutan-themes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const rawLimit = Number(url.searchParams.get('limit') ?? 30)
    const limit = Number.isFinite(rawLimit) ? Math.min(60, Math.max(1, Math.floor(rawLimit))) : 30
    const result = await getKabutanThemes(limit)
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      { themes: [], lastRun: null, error: (error as Error).message },
      { status: 500 },
    )
  }
}
