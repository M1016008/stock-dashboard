import { NextRequest, NextResponse } from 'next/server'
import { parseUniverseFilter } from '@/lib/market-universe'
import {
  getFilteredSectorConstituents,
} from '@/lib/queries/sector-constituents'
import type {
  SectorConstituentFilters,
  SectorConstituentPreset,
  SectorConstituentSort,
  SectorMaDirection,
  SectorMaOrder,
} from '@/lib/sector-constituents'
import { SECTOR_STRUCTURE_AXES } from '@/lib/sector-structure'
import { normalizeSectorStructureTaxonomy } from '@/lib/sector-stage-distribution'
import type { StageLevel } from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function numberParam(params: URLSearchParams, key: string, min?: number, max?: number) {
  const raw = params.get(key)
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, value))
}

function enumParam<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? value as T : fallback
}

function parseStages(params: URLSearchParams): SectorConstituentFilters['stages'] {
  return Object.fromEntries(SECTOR_STRUCTURE_AXES.flatMap((axis) => {
    const raw = params.get(axis.key)
    if (!raw) return []
    const values = Array.from(new Set(raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value): value is StageLevel => Number.isInteger(value) && value >= 1 && value <= 6)))
    return values.length > 0 ? [[axis.key, values]] : []
  }))
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const taxonomy = normalizeSectorStructureTaxonomy(params.get('taxonomy'))
    const groupKey = params.get('groupKey')?.trim() ?? ''
    const rawDate = params.get('date')
    const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
    if (!taxonomy || !groupKey || groupKey.length > 240 || (rawDate && !date)) {
      return NextResponse.json({ error: 'invalid_parameters' }, { status: 400 })
    }

    const filters: SectorConstituentFilters = {
      preset: enumParam<SectorConstituentPreset>(params.get('preset'), ['all', 'up_emerging', 'up_continuation', 'reversal', 'risk', 'down_emerging', 'down_continuation'], 'all'),
      stages: parseStages(params),
      maDirection: enumParam<SectorMaDirection>(params.get('maDirection'), ['all', 'up', 'down'], 'all'),
      maMinCount: Math.round(numberParam(params, 'maMinCount', 1, 4) ?? 2),
      maOrder: enumParam<SectorMaOrder>(params.get('maOrder'), ['all', 'bullish', 'bearish', 'converging', 'other'], 'all'),
      scoreMin: numberParam(params, 'scoreMin', 0, 100),
      scoreMax: numberParam(params, 'scoreMax', 0, 100),
      changeMin: numberParam(params, 'changeMin', -1000, 1000),
      changeMax: numberParam(params, 'changeMax', -1000, 1000),
      marketCapMin: numberParam(params, 'marketCapMin', 0),
      volumeMin: numberParam(params, 'volumeMin', 0),
      sort: enumParam<SectorConstituentSort>(params.get('sort'), ['strategyMatch', 'trendScore', 'changePct', 'marketCap', 'ticker'], params.get('preset') === 'all' ? 'trendScore' : 'strategyMatch'),
      sortDir: params.get('sortDir') === 'asc' ? 'asc' : 'desc',
      offset: Math.floor(numberParam(params, 'offset', 0, 100_000) ?? 0),
    }
    const page = await getFilteredSectorConstituents({
      taxonomy,
      groupKey,
      requestedDate: date,
      universeFilter: parseUniverseFilter(params.get('universe')),
      filters,
      sectorContext: {
        trendStructureScore: numberParam(params, 'sectorScore', 0, 100),
        momentum10d: numberParam(params, 'sectorMomentum10d', -1000, 1000),
        marketTrendStructureScore: numberParam(params, 'marketScore', 0, 100),
      },
    })
    if (!page) return NextResponse.json({ error: 'constituents_not_found' }, { status: 404 })
    return NextResponse.json(page, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    console.error('[sector-constituents]', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'sector_constituents_failed' }, { status: 500 })
  }
}
