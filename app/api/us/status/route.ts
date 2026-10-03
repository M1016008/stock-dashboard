import { NextResponse } from 'next/server'
import { getUsStatusSummary } from '@/lib/us-status'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  return NextResponse.json(await getUsStatusSummary())
}
