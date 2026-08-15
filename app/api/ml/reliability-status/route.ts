import { NextResponse } from 'next/server'
import { getMlModelStatus } from '@/lib/queries/ml-insights'
import { summarizeJpMlReliabilityStatus } from '@/lib/ml/reliability-status'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  try {
    return NextResponse.json(summarizeJpMlReliabilityStatus(await getMlModelStatus()))
  } catch (error) {
    console.error('ML reliability status API error:', error)
    return NextResponse.json(
      { error: 'ML reliability status failed' },
      { status: 500 },
    )
  }
}
