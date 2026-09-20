import { NextResponse } from 'next/server'
import { getPathResearchSegments, parsePathResearchQuery, PathResearchInputError } from '@/lib/server/trigger-path-research-segmentation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const query = parsePathResearchQuery(request.url)
    const result = await getPathResearchSegments((await context.params).jobId, query)
    if (result === null) return NextResponse.json({ error: 'path_research_job_not_found' }, { status: 404 })
    if (result === 'NOT_READY') return NextResponse.json({ error: 'path_research_job_not_completed' }, { status: 409 })
    if (result === 'EXPIRED') return NextResponse.json({ error: 'path_research_result_expired' }, { status: 410 })
    if (!Object.values(result.integrity).every(Boolean)) {
      console.error('[trigger-discovery/path-research:segments] integrity', result.integrity)
      return NextResponse.json({ error: 'path_research_integrity_failure' }, { status: 500 })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    if (error instanceof PathResearchInputError) return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    console.error('[trigger-discovery/path-research:segments]', error)
    return NextResponse.json({ error: 'path_research_segments_unavailable' }, { status: 500 })
  }
}
