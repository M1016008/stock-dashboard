// app/api/capital-flow/route.ts
// 業種別 / 銘柄別の時価総額変化を集計する API。
//
// クエリ:
//   from, to:       'YYYY-MM-DD'。to が未指定なら最新スナップショット日、
//                    from が未指定なら period (day/week/month) から逆算。
//   period:         'day' | 'week' | 'month' （from / to が未指定の場合に使う）
//   groupBy:        'large' | 'sector33' | 'small' | 'ticker'
//                    銘柄を集計する単位。'ticker' を選ぶと個別銘柄ごとに返す。
//   filterField:    'large' | 'sector33' | 'small'（任意）
//   filterValue:    string（任意） 上記で指定した属性に一致する銘柄に絞る
//
// 例: /api/capital-flow?period=week&groupBy=large
//     → 業種大分類ごとに、最新日 vs 1週間前の時価総額変化を返す

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type GroupBy = 'large' | 'sector33' | 'small' | 'ticker'
type Period = 'day' | 'week' | 'month'

interface SnapshotRow {
  date: string
  ticker: string
  market_cap: number | null
  name: string
}

interface SectorRow {
  ticker: string
  sector_large: string | null
  sector_small: string | null
  sector33: string | null
}

interface GroupResult {
  label: string                   // 表示名
  countTickers: number            // この群に含まれるティッカー数（両日にデータがあるもの）
  mcapFrom: number                // 旧日付の合計時価総額（円）
  mcapTo: number                  // 新日付の合計時価総額（円）
  mcapDelta: number               // 増減額（円）
  mcapDeltaPct: number | null     // 増減率（%）。mcapFrom が 0 のときは null
  topContributors: ContributorRow[] // 寄与度トップ
  bottomContributors: ContributorRow[] // 寄与度ボトム
}

interface ContributorRow {
  ticker: string
  name: string
  mcapFrom: number
  mcapTo: number
  delta: number
  deltaPct: number | null
}

async function latestSnapshotDate(): Promise<string | null> {
  const r = await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM tv_daily_snapshots`,
  )
  return r?.d ?? null
}

/** 指定日以前の最も近い snapshot 日を返す。 */
async function nearestDateOnOrBefore(target: string): Promise<string | null> {
  const r = await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM tv_daily_snapshots WHERE date <= ?`,
    [target],
  )
  return r?.d ?? null
}

function shiftDate(yyyymmdd: string, deltaDays: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

async function loadSnapshotsForDate(date: string): Promise<Map<string, SnapshotRow>> {
  const rows = await execAll<SnapshotRow>(
    `SELECT date, ticker, name, market_cap FROM tv_daily_snapshots WHERE date = ?`,
    [date],
  )
  const m = new Map<string, SnapshotRow>()
  for (const r of rows) m.set(r.ticker, r)
  return m
}

async function loadSectorMap(): Promise<Map<string, SectorRow>> {
  const rows = await execAll<SectorRow>(
    `SELECT ticker, sector_large, sector_small, sector33 FROM sector_master`,
  )
  const m = new Map<string, SectorRow>()
  for (const r of rows) m.set(r.ticker, r)
  return m
}

function pickGroupKey(s: SectorRow | undefined, groupBy: GroupBy, snap: SnapshotRow): string | null {
  if (groupBy === 'ticker') return snap.ticker
  if (!s) return null
  let v: string | null
  if (groupBy === 'large')    v = s.sector_large
  else if (groupBy === 'sector33') v = s.sector33
  else if (groupBy === 'small')    v = s.sector_small
  else v = null
  if (v == null) return null
  const trimmed = String(v).trim()
  return trimmed.length > 0 ? trimmed : null
}

function pickFilterValue(s: SectorRow | undefined, field: 'large' | 'sector33' | 'small'): string | null {
  if (!s) return null
  if (field === 'large')    return s.sector_large
  if (field === 'sector33') return s.sector33
  return s.sector_small
}

export async function GET(request: NextRequest) {
  try {
    await ensureReady()
    const sp = new URL(request.url).searchParams
    const groupBy = (sp.get('groupBy') ?? 'large') as GroupBy
    const period  = (sp.get('period') ?? 'week') as Period

    // to: クエリ指定 or 最新スナップショット
    const toQuery = sp.get('to')
    let toDate = toQuery && /^\d{4}-\d{2}-\d{2}$/.test(toQuery)
      ? await nearestDateOnOrBefore(toQuery)
      : await latestSnapshotDate()
    if (!toDate) {
      return NextResponse.json({
        groups: [], totalMcapFrom: 0, totalMcapTo: 0, totalDelta: 0,
        fromDate: null, toDate: null, notice: 'CSV取込が無いため算出できません',
      })
    }

    // from: クエリ指定 or period から逆算（営業日不問・実在する snapshot に丸める）
    const fromQuery = sp.get('from')
    let fromDate: string | null
    if (fromQuery && /^\d{4}-\d{2}-\d{2}$/.test(fromQuery)) {
      fromDate = await nearestDateOnOrBefore(fromQuery)
    } else {
      const offset = period === 'day' ? -1 : period === 'week' ? -7 : -30
      const target = shiftDate(toDate, offset)
      fromDate = await nearestDateOnOrBefore(target)
    }
    if (!fromDate || fromDate === toDate) {
      // 比較対象日付が見つからない or 同日 → 全件 0 として返す
      return NextResponse.json({
        groups: [],
        totalMcapFrom: 0,
        totalMcapTo: 0,
        totalDelta: 0,
        fromDate,
        toDate,
        notice: '比較対象日付（過去 snapshot）が見つかりません',
      })
    }

    const [snapFrom, snapTo, sectorMap] = await Promise.all([
      loadSnapshotsForDate(fromDate),
      loadSnapshotsForDate(toDate),
      loadSectorMap(),
    ])

    // フィルタ（業種で絞り込んで個別銘柄レベルで見る用途）
    const filterField = sp.get('filterField') as 'large' | 'sector33' | 'small' | null
    const filterValue = sp.get('filterValue')
    const filterActive = filterField && filterValue

    type GroupAgg = {
      label: string
      countTickers: number
      mcapFrom: number
      mcapTo: number
      contributors: ContributorRow[]
    }
    const aggs = new Map<string, GroupAgg>()

    // to 側にある銘柄を中心にループ。両日に居る銘柄だけ集計。
    for (const [ticker, snap] of snapTo) {
      const sec = sectorMap.get(ticker)
      if (filterActive) {
        const v = pickFilterValue(sec, filterField as 'large' | 'sector33' | 'small')
        if (v !== filterValue) continue
      }
      const fromSnap = snapFrom.get(ticker)
      const mcapFrom = fromSnap?.market_cap ?? null
      const mcapTo   = snap.market_cap ?? null
      if (mcapFrom == null || mcapTo == null) continue

      const key = pickGroupKey(sec, groupBy, snap)
      if (!key) continue // 業種マスタ未登録 / 空文字は集計対象外
      let g = aggs.get(key)
      if (!g) {
        g = {
          label: groupBy === 'ticker' ? snap.name || snap.ticker : key,
          countTickers: 0,
          mcapFrom: 0,
          mcapTo: 0,
          contributors: [],
        }
        aggs.set(key, g)
      }
      g.countTickers++
      g.mcapFrom += mcapFrom
      g.mcapTo += mcapTo
      const delta = mcapTo - mcapFrom
      g.contributors.push({
        ticker,
        name: snap.name,
        mcapFrom,
        mcapTo,
        delta,
        deltaPct: mcapFrom > 0 ? (delta / mcapFrom) * 100 : null,
      })
    }

    // 集計を仕上げて配列化
    const groups: GroupResult[] = []
    let totalMcapFrom = 0
    let totalMcapTo = 0
    for (const g of aggs.values()) {
      totalMcapFrom += g.mcapFrom
      totalMcapTo   += g.mcapTo
      const delta = g.mcapTo - g.mcapFrom
      const deltaPct = g.mcapFrom > 0 ? (delta / g.mcapFrom) * 100 : null
      const sortedDesc = [...g.contributors].sort((a, b) => b.delta - a.delta)
      const sortedAsc  = [...g.contributors].sort((a, b) => a.delta - b.delta)
      groups.push({
        label: g.label,
        countTickers: g.countTickers,
        mcapFrom: g.mcapFrom,
        mcapTo: g.mcapTo,
        mcapDelta: delta,
        mcapDeltaPct: deltaPct,
        topContributors: sortedDesc.slice(0, 5),
        bottomContributors: sortedAsc.slice(0, 5),
      })
    }

    // 増減額の絶対値で降順ソート
    groups.sort((a, b) => Math.abs(b.mcapDelta) - Math.abs(a.mcapDelta))

    return NextResponse.json({
      fromDate,
      toDate,
      period,
      groupBy,
      filterField,
      filterValue,
      totalMcapFrom,
      totalMcapTo,
      totalDelta: totalMcapTo - totalMcapFrom,
      totalDeltaPct: totalMcapFrom > 0 ? ((totalMcapTo - totalMcapFrom) / totalMcapFrom) * 100 : null,
      groups,
    })
  } catch (error) {
    console.error('Capital flow API error:', error)
    return NextResponse.json(
      { error: 'Capital flow failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
