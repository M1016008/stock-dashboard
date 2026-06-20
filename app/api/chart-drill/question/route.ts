import { NextRequest, NextResponse } from 'next/server'
import { createDrillQuestion, normalizeQuestionParams } from '@/lib/chart-drill/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const question = await createDrillQuestion(normalizeQuestionParams(searchParams))
    return NextResponse.json(question)
  } catch (error) {
    console.error('Chart drill question API error:', error)
    return NextResponse.json(
      { error: 'Failed to create chart drill question', message: (error as Error).message },
      { status: 500 },
    )
  }
}
