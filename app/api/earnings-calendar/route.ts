// app/api/earnings-calendar/route.ts
// 決算ページと同じクエリ経路で、日付・絞り込み・ソート・limitを反映した決算データを返す。

import { NextRequest, NextResponse } from 'next/server'
import { gzipSync } from 'zlib'
import {
  getEarningsCalendarDashboard,
  type EarningsAverageVolumeWindow,
  type EarningsCalendarFilters,
  type EarningsRow,
  type EarningsSortDir,
  type EarningsSortKey,
  type EarningsVolumeCondition,
} from '@/lib/queries/dashboard'
import { parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

export const dynamic = 'force-dynamic'

function jsonResponse(request: NextRequest, payload: unknown, init?: ResponseInit): NextResponse {
  const json = JSON.stringify(payload)
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  const acceptEncoding = request.headers.get('accept-encoding') ?? ''
  if (json.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
    headers.set('content-encoding', 'gzip')
    headers.set('vary', 'Accept-Encoding')
    return new NextResponse(gzipSync(json), { ...init, headers })
  }
  return new NextResponse(json, { ...init, headers })
}

function isIsoDate(value: string | null): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseNumberParam(value: string | null): number | null {
  if (!value?.trim()) return null
  const n = Number(value.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseAverageVolumeWindow(value: string | null): EarningsAverageVolumeWindow | null {
  if (value === '10') return 10
  if (value === '30') return 30
  if (value === '60') return 60
  return null
}

function parseLimit(value: string | null): number | null {
  if (!value?.trim()) return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseVolumeCondition(value: string | null): EarningsVolumeCondition | null {
  if (
    value === 'volume_spike' ||
    value === 'above_avg' ||
    value === 'volume_10k' ||
    value === 'volume_100k'
  ) return value
  return null
}

function parseSortKey(value: string | null): EarningsSortKey | null {
  if (
    value === 'daysLeft' ||
    value === 'announceDate' ||
    value === 'ticker' ||
    value === 'name' ||
    value === 'market' ||
    value === 'sector17' ||
    value === 'sector33' ||
    value === 'price' ||
    value === 'changePct' ||
    value === 'avgVolume10' ||
    value === 'avgVolume30' ||
    value === 'avgVolume60' ||
    value === 'signalCount' ||
    value === 'stageCode' ||
    value === 'postEarningsChangePct'
  ) return value
  return null
}

function parseSortDir(value: string | null): EarningsSortDir | null {
  return value === 'asc' || value === 'desc' ? value : null
}

function normalizeRow(row: EarningsRow) {
  return {
    ...row,
    date: row.announce_date,
    displayCode: row.ticker,
    sectorLarge: row.sector17Name,
    sectorName: row.sector33Name,
    dailyPattern: row.daily_a_stage != null && row.daily_b_stage != null
      ? `${row.daily_a_stage}${row.daily_b_stage}`
      : null,
    stageCode: [
      row.daily_a_stage,
      row.daily_b_stage,
      row.weekly_a_stage,
      row.weekly_b_stage,
      row.monthly_a_stage,
      row.monthly_b_stage,
    ].every((value) => typeof value === 'number')
      ? `${row.daily_a_stage}${row.daily_b_stage}${row.weekly_a_stage}${row.weekly_b_stage}${row.monthly_a_stage}${row.monthly_b_stage}`
      : null,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const dateParam = searchParams.get('date')
    const selectedDate = isIsoDate(dateParam) ? dateParam : null
    const daysFwd = Math.max(1, Math.min(120, Number(searchParams.get('days') ?? 14)))
    const filters: EarningsCalendarFilters = {
      marketSegment: searchParams.get('market') ?? null,
      sector17: searchParams.get('sector17') ?? null,
      sector33: searchParams.get('sector33') ?? null,
      marginType: searchParams.get('marginType') ?? null,
      stageCode: searchParams.get('stageCode') ?? null,
      dailyPattern: searchParams.get('dailyPattern') ?? null,
      volumeCondition: parseVolumeCondition(searchParams.get('volume')),
      avgVolumeWindow: parseAverageVolumeWindow(searchParams.get('avgVolumeWindow')),
      avgVolumeMin: parseNumberParam(searchParams.get('avgVolumeMin')),
      avgVolumeMax: parseNumberParam(searchParams.get('avgVolumeMax')),
      priceMin: parseNumberParam(searchParams.get('priceMin')),
      priceMax: parseNumberParam(searchParams.get('priceMax')),
      signal: searchParams.get('signal') ?? null,
      sortBy: parseSortKey(searchParams.get('sort')),
      sortDir: parseSortDir(searchParams.get('dir')),
      limit: parseLimit(searchParams.get('limit')),
      completed: searchParams.get('completed') === '1' || searchParams.get('completed') === 'true',
      universe: parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM)),
    }
    const dashboard = await getEarningsCalendarDashboard(daysFwd, selectedDate, {
      preferLatestImport: !selectedDate,
      filters,
      includeCompleted: filters.completed === true,
    })

    return jsonResponse(request, {
      entries: dashboard.rows.map(normalizeRow),
      completedEntries: dashboard.completedRows.map(normalizeRow),
      referenceEntries: dashboard.referenceRows.map(normalizeRow),
      snapshotDate: dashboard.scope.scopeDate,
      from: dashboard.windowStart,
      to: dashboard.windowEnd,
      status: dashboard.status,
      message: dashboard.message,
      latestAnnounceDate: dashboard.latestAnnounceDate,
      latestImportedAt: dashboard.latestImportedAt,
      totalRows: dashboard.totalRows,
      scope: dashboard.scope,
      filterOptions: dashboard.filterOptions,
      filters: dashboard.filters,
      lastRun: dashboard.lastRun,
    })
  } catch (error) {
    console.error('earnings-calendar error:', error)
    return jsonResponse(
      request,
      { error: 'Failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
