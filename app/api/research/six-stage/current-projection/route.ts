import { NextRequest, NextResponse } from 'next/server'
import { buildFixtureCurrentServingProjection } from '@/lib/research/six-stage-current-serving-projection-fixture'
import { isSixStageResearchRequestAllowed } from '@/lib/research/six-stage-research-isolation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function integer(value: string | null, fallback: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error('invalid_integer')
  return parsed
}

export async function GET(request: NextRequest) {
  if (!isSixStageResearchRequestAllowed({
    mode: 'fixture',
    hostname: request.nextUrl.hostname,
    headers: request.headers,
  })) return new NextResponse('Not Found', { status: 404 })

  try {
    const market = request.nextUrl.searchParams.get('market')?.toUpperCase()
    if (market !== 'JP' && market !== 'US') throw new Error('invalid_market')
    const page = integer(request.nextUrl.searchParams.get('page'), 1)
    const pageSize = integer(request.nextUrl.searchParams.get('pageSize'), 100)
    if (page < 1 || pageSize < 1 || pageSize > 200) throw new Error('invalid_pagination')
    const ticker = request.nextUrl.searchParams.get('ticker')?.trim().toUpperCase() ?? ''
    const payload = buildFixtureCurrentServingProjection()
    const requestedGeneration = request.nextUrl.searchParams.get('generation')
    if (requestedGeneration && requestedGeneration !== payload.generationId) {
      return NextResponse.json({ error: 'current_projection_generation_mismatch' }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    const matching = payload.rows.filter((row) => row.market === market && (!ticker || row.ticker.toUpperCase().includes(ticker)))
    const offset = (page - 1) * pageSize
    return NextResponse.json({
      kind: payload.kind,
      fixture: true,
      generationId: payload.generationId,
      generatedAt: payload.generatedAt,
      definitionVersion: payload.definitionVersion,
      market,
      watermark: payload.marketWatermarks[market],
      total: matching.length,
      page,
      pageSize,
      rows: matching.slice(offset, offset + pageSize),
    }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'current_projection_request_failed'
    return NextResponse.json({ error: message.startsWith('invalid_') ? message : 'current_projection_request_failed' }, {
      status: message.startsWith('invalid_') ? 400 : 500,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
