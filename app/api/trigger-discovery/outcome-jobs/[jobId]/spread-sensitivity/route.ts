import { NextResponse } from 'next/server'
import {
  getSpreadSensitivity, SpreadSensitivitySourceDriftError,
} from '@/lib/server/trigger-discovery-spread-sensitivity'
import { TriggerOutcomeSegmentationSourceError } from '@/lib/server/trigger-discovery-outcome-segmentation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext) {
  const query = new URL(request.url).searchParams
  if ([...query.keys()].some((key) => key !== 'parameterPreset')
    || query.getAll('parameterPreset').length > 1
    || (query.has('parameterPreset') && query.get('parameterPreset') !== 'DEFAULT_GRID')) {
    return NextResponse.json({ error: 'invalid_parameter_preset' }, { status: 400 })
  }
  try {
    return NextResponse.json(await getSpreadSensitivity((await context.params).jobId), {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    if (error instanceof TriggerOutcomeSegmentationSourceError) {
      const status = error.code === 'outcome_analysis_job_not_found' ? 404
        : error.code === 'outcome_analysis_job_not_completed' ? 409 : 410
      return NextResponse.json({ error: error.code }, { status })
    }
    if (error instanceof SpreadSensitivitySourceDriftError) {
      console.error('[trigger-discovery/spread-sensitivity:source-drift]', error)
      return NextResponse.json({ error: 'spread_source_data_changed' }, { status: 409 })
    }
    console.error('[trigger-discovery/spread-sensitivity:get]', error)
    return NextResponse.json({ error: 'spread_sensitivity_unavailable' }, { status: 500 })
  }
}
