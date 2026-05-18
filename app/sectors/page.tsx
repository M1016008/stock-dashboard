// app/sectors/page.tsx
// Phase 4 E: 業種別 (大分類) — 59 大分類ヒートマップ + 詳細パネル

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectorsHeatmap } from '@/components/sectors/SectorsHeatmap'
import { SectorTopList } from '@/components/sectors/SectorTopList'
import { SectorDetailPanel } from '@/components/sectors/SectorDetailPanel'
import { getSectorRows, getSubSectorsFor } from '@/lib/queries/sectors'

export const metadata: Metadata = {
  title: '業種別 (大分類) — StockBoard',
  description: '大分類ごとの市場全体の流れと業種細分類へのドリルダウン',
}

export const revalidate = 300

export default async function SectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>
}) {
  const sp = await searchParams
  const selected = sp.selected ?? null

  const [{ rows, source }, subRows] = await Promise.all([
    getSectorRows(),
    selected ? getSubSectorsFor(selected) : Promise.resolve([]),
  ])

  const sourceLabel = source === 'classification'
    ? `${rows.length} 大分類 (Yoshio 独自分類)`
    : `${rows.length} 業種 (J-Quants Sector17 フォールバック)`

  // Top 5 上昇 / Top 5 下落
  const sorted = [...rows].sort((a, b) => b.avg_change - a.avg_change)
  const top = sorted.slice(0, 5)
  const bottom = sorted.slice(-5).reverse()

  return (
    <div className="flex flex-col gap-3.5">
      <PageTitle
        title="業種別 (大分類)"
        subtitle={source === 'classification'
          ? '59 大分類で市場全体の流れを把握。クリックで業種細分類へドリルダウン'
          : 'Yoshio 独自分類 (Excel) 未取り込み。J-Quants Sector17 をフォールバック表示中'}
        badge={sourceLabel}
      />
      <SectorsHeatmap rows={rows} selected={selected} />
      <div className="grid grid-cols-2 gap-3.5">
        <SectorTopList rows={top} title="上昇上位" kind="up" />
        <SectorTopList rows={bottom} title="下落上位" kind="down" />
      </div>
      {selected && <SectorDetailPanel sectorName={selected} rows={subRows} />}
    </div>
  )
}
