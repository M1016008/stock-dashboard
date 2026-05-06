// app/api/capital-flow/diagnostics/route.ts
// 業種マスタの網羅率と、各 sector33/sector_large/sector_small の銘柄数を返す。
// ユーザがマスタ整備の問題を診断するための補助 API。

import { NextResponse } from 'next/server'
import { execAll, execGet, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

interface DiagSnapshotRow {
  ticker: string
}
interface DiagSectorRow {
  ticker: string
  sector_large: string | null
  sector_small: string | null
  sector33: string | null
}

export async function GET() {
  try {
    await ensureReady()

    // 最新スナップショット日
    const latest = await execGet<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM tv_daily_snapshots`,
    )
    if (!latest?.d) {
      return NextResponse.json({ snapshotDate: null, totalTickers: 0, coverage: null })
    }

    const tickers = await execAll<DiagSnapshotRow>(
      `SELECT DISTINCT ticker FROM tv_daily_snapshots WHERE date = ?`,
      [latest.d],
    )
    const allTickers = new Set(tickers.map((t) => t.ticker))

    const sectorRows = await execAll<DiagSectorRow>(
      `SELECT ticker, sector_large, sector_small, sector33 FROM sector_master`,
    )
    const sectorMap = new Map<string, DiagSectorRow>()
    for (const r of sectorRows) sectorMap.set(r.ticker, r)

    let withSectorMaster = 0
    let withSector33 = 0
    let withLarge = 0
    let withSmall = 0
    const sector33Counts = new Map<string, number>()
    const largeCounts = new Map<string, number>()
    const smallCounts = new Map<string, number>()
    const unmatchedTickers: string[] = []

    for (const t of allTickers) {
      const s = sectorMap.get(t)
      if (!s) {
        unmatchedTickers.push(t)
        continue
      }
      withSectorMaster++
      const v33    = s.sector33?.trim()
      const vLarge = s.sector_large?.trim()
      const vSmall = s.sector_small?.trim()
      if (v33)    { withSector33++; sector33Counts.set(v33,    (sector33Counts.get(v33) ?? 0) + 1) }
      if (vLarge) { withLarge++;    largeCounts.set(vLarge,    (largeCounts.get(vLarge) ?? 0) + 1) }
      if (vSmall) { withSmall++;    smallCounts.set(vSmall,    (smallCounts.get(vSmall) ?? 0) + 1) }
    }

    const sortByCount = (m: Map<string, number>) =>
      Array.from(m.entries()).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)

    return NextResponse.json({
      snapshotDate: latest.d,
      totalTickers: allTickers.size,
      withSectorMaster,
      withSector33,
      withLarge,
      withSmall,
      coveragePct: {
        master:   allTickers.size > 0 ? (withSectorMaster / allTickers.size) * 100 : 0,
        sector33: allTickers.size > 0 ? (withSector33     / allTickers.size) * 100 : 0,
        large:    allTickers.size > 0 ? (withLarge        / allTickers.size) * 100 : 0,
        small:    allTickers.size > 0 ? (withSmall        / allTickers.size) * 100 : 0,
      },
      bySector33: sortByCount(sector33Counts),
      byLarge:    sortByCount(largeCounts),
      bySmall:    sortByCount(smallCounts),
      unmatchedSample: unmatchedTickers.slice(0, 20),
      unmatchedCount: unmatchedTickers.length,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
