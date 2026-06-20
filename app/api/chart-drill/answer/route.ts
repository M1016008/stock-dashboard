import { NextRequest, NextResponse } from 'next/server'
import {
  answerDrillQuestion,
  normalizeAnswer,
  normalizeConfidence,
} from '@/lib/chart-drill/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const result = await answerDrillQuestion({
      problemId: String(body.problemId ?? ''),
      answer: normalizeAnswer(body.answer),
      confidence: normalizeConfidence(body.confidence),
      memo: typeof body.memo === 'string' ? body.memo : null,
    })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Chart drill answer API error:', error)
    return NextResponse.json(
      { error: 'Failed to answer chart drill question', message: (error as Error).message },
      { status: 500 },
    )
  }
}
