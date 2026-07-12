import { NextResponse } from 'next/server'
import { createSharedCustomChart, listSharedCustomCharts } from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    const charts = await listSharedCustomCharts()
    return NextResponse.json({ charts }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャート一覧を取得できませんでした。'
    return NextResponse.json({ error: message }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const chart = await createSharedCustomChart(body)
    return NextResponse.json({ chart }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャートを保存できませんでした。'
    return NextResponse.json({ error: message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
}
