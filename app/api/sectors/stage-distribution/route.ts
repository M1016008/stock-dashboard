import { NextRequest, NextResponse } from 'next/server'
import { getSectorStageConstituents } from '@/lib/queries/sector-stage-distribution'
import { parseUniverseFilter } from '@/lib/market-universe'
import {
  normalizeSectorStage,
  normalizeSectorStructureAxis,
  normalizeSectorStructureTaxonomy,
} from '@/lib/sector-stage-distribution'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function isoDate(value: string | null): string | null {
  if (!value) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const taxonomy = normalizeSectorStructureTaxonomy(params.get('taxonomy'))
    const groupKey = params.get('groupKey')?.trim() ?? ''
    const axis = normalizeSectorStructureAxis(params.get('axis'))
    const stage = normalizeSectorStage(params.get('stage'))
    const rawDate = params.get('date')
    const date = isoDate(rawDate)

    if (!taxonomy || !groupKey || groupKey.length > 240 || !axis || !stage || (rawDate && !date)) {
      return NextResponse.json({ error: 'invalid_parameters' }, { status: 400 })
    }

    const page = await getSectorStageConstituents({
      taxonomy,
      groupKey,
      axis,
      stage,
      requestedDate: date,
      cursor: params.get('cursor'),
      universeFilter: parseUniverseFilter(params.get('universe')),
    })
    if (!page) return NextResponse.json({ error: 'distribution_not_found' }, { status: 404 })

    return NextResponse.json(page, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    console.error('[sector-stage-distribution]', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'stage_distribution_failed' }, { status: 500 })
  }
}
