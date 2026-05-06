// app/api/capital-flow/timeseries/route.ts
// 業種別の時価総額推移を日次で返す。Capital Flow の「推移」タブで利用。

import { NextRequest, NextResponse } from 'next/server'
import { execAll, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type GroupBy = 'large' | 'sector33' | 'small'

interface SnapshotRow {
  date: string
  ticker: string
  market_cap: number | null
}

interface SectorRow {
  ticker: string
  sector_large: string | null
  sector_small: string | null
  sector33: string | null
}

function pickKey(s: SectorRow | undefined, g: GroupBy): string {
  if (!s) return 'その他'
  if (g === 'large')    return s.sector_large ?? 'その他'
  if (g === 'sector33') return s.sector33     ?? 'その他'
  return s.sector_small ?? 'その他'
}

export async function GET(request: NextRequest) {
  try {
    await ensureReady()
    const sp = new URL(request.url).searchParams
    const groupBy = (sp.get('groupBy') ?? 'large') as GroupBy
    const days = Math.max(2, Math.min(365, Number(sp.get('days') ?? 30)))

    // 取込済み日付（最新から days 件）
    const dateRows = await execAll<{ date: string }>(
      `SELECT DISTINCT date FROM tv_daily_snapshots ORDER BY date DESC LIMIT ?`,
      [days],
    )
    const dates = dateRows.map((r) => r.date).reverse() // 古い → 新しい
    if (dates.length < 2) {
      return NextResponse.json({ dates: [], groups: [], notice: '日次データが2日分未満です' })
    }

    // 全 snapshot 一括取得
    const placeholders = dates.map(() => '?').join(',')
    const snaps = await execAll<SnapshotRow>(
      `SELECT date, ticker, market_cap FROM tv_daily_snapshots WHERE date IN (${placeholders})`,
      dates,
    )

    const sectorRows = await execAll<SectorRow>(
      `SELECT ticker, sector_large, sector_small, sector33 FROM sector_master`,
    )
    const sectorMap = new Map<string, SectorRow>()
    for (const r of sectorRows) sectorMap.set(r.ticker, r)

    // group → date → mcap 合計
    const agg = new Map<string, Map<string, number>>()
    for (const s of snaps) {
      if (s.market_cap == null) continue
      const key = pickKey(sectorMap.get(s.ticker), groupBy)
      let m = agg.get(key)
      if (!m) { m = new Map(); agg.set(key, m) }
      m.set(s.date, (m.get(s.date) ?? 0) + s.market_cap)
    }

    // group ごとの time series 配列 (date 順、欠損は前日値で補完しない＝そのまま 0)
    const groups = Array.from(agg.entries()).map(([key, m]) => {
      const series = dates.map((d) => m.get(d) ?? null)
      const first = series.find((v) => v != null) ?? 0
      const last  = [...series].reverse().find((v) => v != null) ?? 0
      const totalDelta = (last as number) - (first as number)
      const totalDeltaPct = (first as number) > 0 ? (totalDelta / (first as number)) * 100 : null
      // 起点を 100 とした正規化系列も計算
      const indexed = series.map((v) =>
        v == null || (first as number) === 0 ? null : (v / (first as number)) * 100,
      )
      return {
        label: key,
        series,
        indexed,
        latestMcap: last,
        firstMcap: first,
        totalDelta,
        totalDeltaPct,
      }
    })

    // 時価総額（最新日）が大きい順に並べ、上位 12 群だけ返す（折れ線が混雑しすぎないように）
    groups.sort((a, b) => (b.latestMcap as number) - (a.latestMcap as number))
    const top = groups.slice(0, 12)

    return NextResponse.json({
      dates,
      groups: top,
      groupBy,
    })
  } catch (e) {
    console.error('Capital flow timeseries error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
