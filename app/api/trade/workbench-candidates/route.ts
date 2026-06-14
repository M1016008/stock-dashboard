import { NextRequest, NextResponse } from 'next/server'
import { getTradeWorkbench } from '@/lib/queries/trade-workbench'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function positiveNumber(value: string | null): number | null {
  const parsed = Number(value ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const result = await getTradeWorkbench({
      horizonDays: positiveInteger(searchParams.get('horizonDays') ?? searchParams.get('horizon')),
      limit: positiveInteger(searchParams.get('limit')),
      budgetYen: positiveNumber(searchParams.get('budgetYen')),
    })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Trade workbench candidates API error:', error)
    return NextResponse.json(
      { error: 'trade_workbench_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
