import { NextRequest, NextResponse } from 'next/server'
import {
  answerDrillQuestion,
  ChartDrillProblemError,
  normalizeAnswer,
  normalizeConfidence,
} from '@/lib/chart-drill/server'
import { chartDrillAnswerErrorResponse } from '@/lib/chart-drill/http'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ChartDrillProblemError('INVALID_PROBLEM_ID', '問題IDが不正です。次の問題を取得してください。')
    }
    body = parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ChartDrillProblemError) return chartDrillAnswerErrorResponse(error)
    return NextResponse.json(
      { error: 'invalid_request_body', message: 'リクエスト本文が不正です。' },
      { status: 400 },
    )
  }

  if (typeof body.problemId !== 'string' || !body.problemId.trim()) {
    return chartDrillAnswerErrorResponse(new ChartDrillProblemError(
      'INVALID_PROBLEM_ID',
      '問題IDが不正です。次の問題を取得してください。',
    ))
  }

  try {
    const result = await answerDrillQuestion({
      problemId: body.problemId,
      answer: normalizeAnswer(body.answer),
      confidence: normalizeConfidence(body.confidence),
      memo: typeof body.memo === 'string' ? body.memo : null,
    })
    return NextResponse.json(result)
  } catch (error) {
    if (!(error instanceof ChartDrillProblemError)) console.error('Chart drill answer API error:', error)
    return chartDrillAnswerErrorResponse(error)
  }
}
