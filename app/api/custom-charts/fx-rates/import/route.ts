import { NextResponse } from 'next/server'
import { importFxRatesFromCsv } from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const source = url.searchParams.get('source') ?? 'csv'
    const csvText = await request.text()
    const result = await importFxRatesFromCsv(csvText, source)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FX CSVを取り込めませんでした。'
    return NextResponse.json({ error: message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
}
