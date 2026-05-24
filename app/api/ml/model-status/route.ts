import { NextResponse } from 'next/server'
import { getMlModelStatus } from '@/lib/queries/ml-insights'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  try {
    return NextResponse.json(await getMlModelStatus())
  } catch (error) {
    console.error('ML model status API error:', error)
    return NextResponse.json(
      { error: 'ML model status failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
