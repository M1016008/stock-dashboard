// app/api/admin/sector-master/diagnostics/route.ts
// J-Quants業種マスタの網羅率と、各 sector33/sector_large/sector_small の銘柄数を返す。
// 管理画面でマスタ整備の問題を診断するための補助 API。

import { NextResponse } from 'next/server'
import { execAll, execGet, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

interface DiagSnapshotRow {
  ticker: string
  name: string | null
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

    const latest = await execGet<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM daily_snapshots`,
    )
    if (!latest?.d) {
      return NextResponse.json({ snapshotDate: null, totalTickers: 0, coverage: null })
    }

    const tickers = await execAll<DiagSnapshotRow>(
      `
      SELECT s.ticker, COALESCE(u.name, s.ticker) AS name
      FROM daily_snapshots s
      LEFT JOIN ticker_universe u ON u.ticker = s.ticker
      WHERE s.date = ?
      `,
      [latest.d],
    )
    const tickerNameMap = new Map<string, string>()
    for (const t of tickers) tickerNameMap.set(t.ticker, t.name ?? '')
    const allTickers = tickerNameMap

    const sectorRows = await execAll<DiagSectorRow>(
      `SELECT
         ticker,
         sector17_name AS sector_large,
         sector33_name AS sector_small,
         sector33_name AS sector33
       FROM ticker_universe
       WHERE active = 1
       UNION ALL
       SELECT
         ticker,
         sector_large,
         sector_small,
         sector33
       FROM sector_master`,
    )
    const sectorMap = new Map<string, DiagSectorRow>()
    for (const r of sectorRows) {
      const ticker = r.ticker.replace(/\.T$/, '')
      const existing = sectorMap.get(ticker)
      if (!existing) {
        sectorMap.set(ticker, { ...r, ticker })
        continue
      }
      sectorMap.set(ticker, {
        ...existing,
        sector_large: existing.sector_large?.trim() ? existing.sector_large : r.sector_large,
        sector_small: existing.sector_small?.trim() ? existing.sector_small : r.sector_small,
        sector33: existing.sector33?.trim() ? existing.sector33 : r.sector33,
      })
    }

    let withSectorMaster = 0
    let withSector33 = 0
    let withLarge = 0
    let withSmall = 0
    const sector33Counts = new Map<string, number>()
    const largeCounts = new Map<string, number>()
    const smallCounts = new Map<string, number>()
    const unmatched: { ticker: string; name: string }[] = []

    for (const [t, name] of allTickers) {
      const s = sectorMap.get(t)
      if (!s) {
        unmatched.push({ ticker: t, name })
        continue
      }
      withSectorMaster++
      const v33 = s.sector33?.trim()
      const vLarge = s.sector_large?.trim()
      const vSmall = s.sector_small?.trim()
      if (v33) {
        withSector33++
        sector33Counts.set(v33, (sector33Counts.get(v33) ?? 0) + 1)
      }
      if (vLarge) {
        withLarge++
        largeCounts.set(vLarge, (largeCounts.get(vLarge) ?? 0) + 1)
      }
      if (vSmall) {
        withSmall++
        smallCounts.set(vSmall, (smallCounts.get(vSmall) ?? 0) + 1)
      }
    }

    const sortByCount = (m: Map<string, number>) =>
      Array.from(m.entries())
        .map(([label, n]) => ({ label, n }))
        .sort((a, b) => b.n - a.n)

    return NextResponse.json({
      snapshotDate: latest.d,
      totalTickers: allTickers.size,
      withSectorMaster,
      withSector33,
      withLarge,
      withSmall,
      coveragePct: {
        master: allTickers.size > 0 ? (withSectorMaster / allTickers.size) * 100 : 0,
        sector33: allTickers.size > 0 ? (withSector33 / allTickers.size) * 100 : 0,
        large: allTickers.size > 0 ? (withLarge / allTickers.size) * 100 : 0,
        small: allTickers.size > 0 ? (withSmall / allTickers.size) * 100 : 0,
      },
      bySector33: sortByCount(sector33Counts),
      byLarge: sortByCount(largeCounts),
      bySmall: sortByCount(smallCounts),
      unmatchedSample: unmatched.slice(0, 50),
      unmatchedCount: unmatched.length,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
