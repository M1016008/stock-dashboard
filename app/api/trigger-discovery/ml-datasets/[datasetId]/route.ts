import { NextResponse } from 'next/server'
import { cancelMlDatasetJob, getMlDatasetJob } from '@/lib/server/trigger-ml-dataset-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type Context = { params: Promise<{ datasetId: string }> }

export async function GET(_request: Request, context: Context) {
  const result = await getMlDatasetJob((await context.params).datasetId)
  return NextResponse.json(result ?? { error: 'not_found' }, { status: result ? 200 : 404,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}

export async function DELETE(_request: Request, context: Context) {
  // DELETE cancels a pending build. Completed research snapshots are immutable and are never deleted here.
  const result = await cancelMlDatasetJob((await context.params).datasetId)
  return NextResponse.json(result ?? { error: 'not_found' }, { status: result ? 200 : 404,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}
