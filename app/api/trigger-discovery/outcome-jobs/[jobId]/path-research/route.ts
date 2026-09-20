import { NextResponse } from 'next/server'
import { createPathResearchJob, PathResearchSourceError } from '@/lib/server/trigger-path-research-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function POST(_request: Request, context: RouteContext) {
  try {
    const result = await createPathResearchJob((await context.params).jobId)
    return NextResponse.json(result, { status: result.reused ? 200 : 202,
      headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    if (error instanceof PathResearchSourceError) {
      const status = error.code === 'source_not_found' ? 404 : error.code === 'source_not_completed' ? 409 : 410
      return NextResponse.json({ error: error.code }, { status })
    }
    console.error('[trigger-discovery/path-research:start]', error)
    return NextResponse.json({ error: 'path_research_start_failed' }, { status: 500 })
  }
}
