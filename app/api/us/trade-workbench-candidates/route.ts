import { NextRequest, NextResponse } from 'next/server'
import { getUsTradeWorkbench } from '@/lib/queries/us-trade-workbench'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZONS = new Set([5, 10, 20, 40, 60, 90, 200])

function oneParam(request: NextRequest, name: string): string | null {
  const values = request.nextUrl.searchParams.getAll(name)
  if (values.length > 1) throw new Error(`DUPLICATE_${name.toUpperCase()}`)
  return values[0] ?? null
}

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (value == null) return fallback
  if (!/^\d+$/.test(value)) throw new Error('INVALID_INTEGER')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('INVALID_INTEGER')
  return parsed
}

export async function GET(request: NextRequest) {
  try {
    const horizonRaw = oneParam(request, 'horizon')
    const horizonDays = parseInteger(horizonRaw, 20, 5, 200)
    if (!HORIZONS.has(horizonDays)) {
      return NextResponse.json({ ok: false, error: 'invalid_horizon' }, { status: 400 })
    }
    const limit = parseInteger(oneParam(request, 'limit'), 40, 1, 120)
    const budgetUsd = parseInteger(oneParam(request, 'budgetUsd'), 5_000, 100, 1_000_000)
    const result = await getUsTradeWorkbench({ horizonDays, limit, budgetUsd })
    const status = result.coverage.availability === 'unavailable' ? 503 : 200
    return NextResponse.json({ ok: status === 200, market: 'US', ...result }, { status })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'INVALID_INTEGER' || message.startsWith('DUPLICATE_')) {
      return NextResponse.json({ ok: false, error: 'invalid_query_parameters' }, { status: 400 })
    }
    console.error('US trade workbench API failed:', error)
    return NextResponse.json(
      { ok: false, error: 'us_trade_workbench_unavailable' },
      { status: 503 },
    )
  }
}
