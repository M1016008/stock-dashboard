import { NextResponse } from 'next/server'
import { FormulaSyntaxError } from '@/lib/custom-charts/formula'
import { evaluateCustomChart } from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const result = await evaluateCustomChart(body)
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャートの計算に失敗しました。'
    const status = error instanceof FormulaSyntaxError ? 400 : 422
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}
