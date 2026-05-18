// app/hex-stage/page.tsx
//
// Phase 4 改修 + 旧 HexMap 復元の統合ページ:
//   1. ページ上部: Phase 4 セクション (Server Component, await でロード)
//      - 6 タイムスケールタブ
//      - 6 ステージカード (件数 + 先週比)
//      - 期間タブ (本日/今週/今月)
//      - 6×6 ステージ遷移マトリクス
//      - 期間別 遷移件数 KPI
//      - 遷移銘柄一覧
//   2. ページ下部: 旧 HEX マップ (Client Component)
//      - 日足/週足/月足 × 6×6 グリッド
//      - 業種大分類/小分類フィルタ
//      - 銘柄テーブル (時価総額/各 perf/6軸ステージ/SMA角度)

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { TimescaleTabs, PeriodTabs } from '@/components/hex/TimescaleTabs'
import { SixStageCircle } from '@/components/hex/SixStageCircle'
import { TransitionMatrix } from '@/components/hex/TransitionMatrix'
import { PeriodCountTrend } from '@/components/hex/PeriodCountTrend'
import { TransitionDetailTable } from '@/components/hex/TransitionDetailTable'
import HexStageMapView from '@/components/hex/HexStageMapView'
import type { Timescale, Period } from '@/lib/queries/hex'

export const metadata: Metadata = {
  title: 'HEX ステージ — StockBoard',
  description: 'トレンドステージ分布 + 遷移分析 + B×A グリッドで市場全体を俯瞰',
}

export const revalidate = 300

const VALID_TS: Timescale[] = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b']
const VALID_PERIOD: Period[] = ['today', 'week', 'month']

export default async function HexStagePage({
  searchParams,
}: {
  searchParams: Promise<{ ts?: string; period?: string }>
}) {
  const sp = await searchParams
  const ts = (VALID_TS as string[]).includes(sp.ts ?? '') ? (sp.ts as Timescale) : 'daily_a'
  const period = (VALID_PERIOD as string[]).includes(sp.period ?? '') ? (sp.period as Period) : 'today'

  return (
    <div className="flex flex-col gap-3.5">
      <PageTitle
        title="HEX ステージ分析"
        subtitle="市場全体のステージ分布と銘柄の循環的な動きを観察します"
      />

      {/* ── Phase 4 セクション (ステージ遷移ビュー) ─── */}
      <TimescaleTabs current={ts} />

      <SixStageCircle timescale={ts} />

      <div className="flex items-center justify-between">
        <PeriodTabs current={period} />
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <TransitionMatrix timescale={ts} period={period} />
        <PeriodCountTrend timescale={ts} />
      </div>

      <TransitionDetailTable timescale={ts} period={period} />

      {/* ── 旧 HEX マップ (B×A グリッド + 銘柄テーブル) ─── */}
      <div className="mt-3 border-t border-[var(--color-border-soft)] pt-2" />
      <HexStageMapView />
    </div>
  )
}
