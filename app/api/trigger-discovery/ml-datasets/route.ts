import { NextResponse } from 'next/server'
import { createMlDatasetJob } from '@/lib/server/trigger-ml-dataset-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>
    if (!body || typeof body.pathResearchJobId !== 'string' ||
      body.splitPolicy != null && (typeof body.splitPolicy !== 'object' || Array.isArray(body.splitPolicy))) {
      return NextResponse.json({ error: 'invalid_ml_dataset_request' }, { status: 400 })
    }
    const jobId = await createMlDatasetJob({ pathResearchJobId: body.pathResearchJobId,
      splitPolicy: body.splitPolicy as Parameters<typeof createMlDatasetJob>[0]['splitPolicy'] })
    return NextResponse.json({ datasetId: jobId, status: 'QUEUED' }, {
      status: 202, headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof SyntaxError || /^(invalid_|ml_path_source_unavailable|ml_scan_source_unavailable|ml_source_chain_mismatch)/.test(message)) {
      return NextResponse.json({ error: 'invalid_or_unavailable_ml_dataset_source' }, { status: 400 })
    }
    console.error('[trigger-discovery/ml-datasets:start]', error)
    return NextResponse.json({ error: 'ml_dataset_start_failed' }, { status: 500 })
  }
}
