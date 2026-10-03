import { NextResponse } from 'next/server'
import { searchCustomChartSymbols } from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const q = url.searchParams.get('q') ?? ''
    const symbols = await searchCustomChartSymbols(q)
    return NextResponse.json({ symbols }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '候補検索に失敗しました。'
    return NextResponse.json({ error: message }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
