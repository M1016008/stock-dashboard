import { NextResponse } from 'next/server'
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'
import { getDataFreshness } from '@/lib/server/data-freshness'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const freshness = await getDataFreshness()
  return NextResponse.json(freshness, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

export async function POST() {
  return adminWriteDisabledResponse('最新データ自動更新')
}
