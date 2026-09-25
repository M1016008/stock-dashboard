import { NextResponse } from 'next/server'
import { ChartDrillProblemError } from './server'

export function chartDrillAnswerErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChartDrillProblemError) {
    const status = error.code === 'INVALID_PROBLEM_ID' ? 400 : 404
    const code = error.code === 'INVALID_PROBLEM_ID'
      ? 'invalid_problem_id'
      : 'chart_drill_problem_not_found'
    return NextResponse.json({ error: code, message: error.message }, { status })
  }
  return NextResponse.json(
    {
      error: 'chart_drill_internal_error',
      message: 'チャートドリルの回答を処理できませんでした。',
    },
    { status: 500 },
  )
}
