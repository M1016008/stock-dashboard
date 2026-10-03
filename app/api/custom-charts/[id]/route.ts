import { NextResponse } from 'next/server'
import {
  deleteSharedCustomChart,
  getSharedCustomChart,
  updateSharedCustomChart,
} from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    const chart = await getSharedCustomChart(id)
    if (!chart) return NextResponse.json({ error: '合成チャートが見つかりません。' }, { status: 404 })
    return NextResponse.json({ chart }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャートを取得できませんでした。'
    return NextResponse.json({ error: message }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    const body = await request.json()
    const chart = await updateSharedCustomChart(id, body)
    return NextResponse.json({ chart }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャートを更新できませんでした。'
    return NextResponse.json({ error: message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteSharedCustomChart(id)
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '合成チャートを削除できませんでした。'
    return NextResponse.json({ error: message }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
