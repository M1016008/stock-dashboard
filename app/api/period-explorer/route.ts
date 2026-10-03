import { NextRequest, NextResponse } from 'next/server'
import {
  PERIOD_EXPLORER_AXIS_KEYS,
  isPeriodExplorerRankingKey,
  type PeriodExplorerAxisKey,
} from '@/lib/period-explorer'
import {
  PeriodExplorerInputError,
  queryPeriodExplorer,
  type PeriodExplorerFilters,
  type PeriodExplorerSortKey,
  type PeriodExplorerTaxonomy,
} from '@/lib/server/period-explorer-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

function csv(params: URLSearchParams, key: string): string[] | undefined {
  const values = params.getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length ? [...new Set(values)].slice(0, 100) : undefined
}

function numberParam(params: URLSearchParams, key: string): number | null | undefined {
  const raw = params.get(key)
  if (raw == null || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new PeriodExplorerInputError(`${key}は数値で指定してください。`)
  return value
}

function taxonomyParam(value: string | null): PeriodExplorerTaxonomy {
  return value === 'sector17' || value === 'major' || value === 'subIndustry' ? value : 'sector33'
}

function sortParam(value: string | null): PeriodExplorerSortKey | undefined {
  return value === 'periodReturn' || value === 'price' || value === 'marketCap'
    || value === 'avgTurnover' || value === 'avgVolume' || value === 'ticker' || value === 'ranking'
    ? value
    : undefined
}

function stageFilters(params: URLSearchParams): Partial<Record<PeriodExplorerAxisKey, number[]>> {
  const result: Partial<Record<PeriodExplorerAxisKey, number[]>> = {}
  for (const axis of PERIOD_EXPLORER_AXIS_KEYS) {
    const values = csv(params, `stage_${axis}`)
      ?.map(Number)
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 6)
    if (values?.length) result[axis] = [...new Set(values)]
  }
  return result
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const params = new URL(request.url).searchParams
    const rankingValue = params.get('ranking')
    if (rankingValue && !isPeriodExplorerRankingKey(rankingValue)) {
      return NextResponse.json({ error: 'invalid_ranking' }, { status: 400 })
    }
    const filters: PeriodExplorerFilters = {
      markets: csv(params, 'market'),
      sectors: csv(params, 'sector'),
      marginTypes: csv(params, 'margin'),
      marketCapMin: numberParam(params, 'marketCapMin'),
      marketCapMax: numberParam(params, 'marketCapMax'),
      avgVolumeMin: numberParam(params, 'avgVolumeMin'),
      avgVolumeMax: numberParam(params, 'avgVolumeMax'),
      avgTurnoverMin: numberParam(params, 'avgTurnoverMin'),
      avgTurnoverMax: numberParam(params, 'avgTurnoverMax'),
      priceMin: numberParam(params, 'priceMin'),
      priceMax: numberParam(params, 'priceMax'),
      high52WithinPct: numberParam(params, 'high52WithinPct'),
      low52WithinPct: numberParam(params, 'low52WithinPct'),
      ma25Position: params.get('ma25') === 'above' || params.get('ma25') === 'below' ? params.get('ma25') as 'above' | 'below' : null,
      ma75Position: params.get('ma75') === 'above' || params.get('ma75') === 'below' ? params.get('ma75') as 'above' | 'below' : null,
      universe: params.get('universe') === 'nikkei225' ? 'nikkei225' : null,
      stages: stageFilters(params),
    }
    const result = await queryPeriodExplorer({
      from: params.get('from'),
      to: params.get('to'),
      ranking: rankingValue && isPeriodExplorerRankingKey(rankingValue) ? rankingValue : null,
      taxonomy: taxonomyParam(params.get('taxonomy')),
      filters,
      sort: sortParam(params.get('sort')),
      direction: params.get('direction') === 'asc' ? 'asc' : params.get('direction') === 'desc' ? 'desc' : undefined,
      limit: numberParam(params, 'limit') ?? undefined,
      offset: numberParam(params, 'offset') ?? undefined,
    })
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `period-explorer;dur=${Date.now() - startedAt}`,
      },
    })
  } catch (error) {
    if (error instanceof PeriodExplorerInputError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    console.error('[period-explorer]', error)
    return NextResponse.json({ error: 'period_explorer_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
