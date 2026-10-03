import { NextResponse } from 'next/server'
import { getDashboardAvailableDates } from '@/lib/queries/dashboard-cache'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: Request) {
  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? 10000)
  const limit = Number.isFinite(rawLimit) ? Math.min(10000, Math.max(1, Math.floor(rawLimit))) : 10000
  const dates = await getDashboardAvailableDates(limit)
  return NextResponse.json({ dates }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
