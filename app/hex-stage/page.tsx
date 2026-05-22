// app/hex-stage/page.tsx
// モック準拠 (v2) + 旧 HexMap 併存 + Suspense ストリーミング + キャッシュ無効化

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SixStageCircleMock } from '@/components/hex/SixStageCircleMock'
import { TransitionMatrixMock } from '@/components/hex/TransitionMatrixMock'
import { PeriodCountTrendMock } from '@/components/hex/PeriodCountTrendMock'
import { TransitionDetailTableMock } from '@/components/hex/TransitionDetailTableMock'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { TabRow } from '@/components/ui/TabRow'
import type { Timescale, Period } from '@/lib/queries/hex'

export const metadata: Metadata = {
  title: 'HEX ステージ — StockBoard',
  description: 'トレンドステージ分布 + 遷移分析 + B×A グリッドで市場全体を俯瞰',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const VALID_TS: Timescale[] = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b']
const VALID_PERIOD: Period[] = ['today', 'week', 'month']

const TS_TABS: { key: Timescale; label: string }[] = [
  { key: 'daily_a',   label: '日足 A' },
  { key: 'daily_b',   label: '日足 B' },
  { key: 'weekly_a',  label: '週足 A' },
  { key: 'weekly_b',  label: '週足 B' },
  { key: 'monthly_a', label: '月足 A' },
  { key: 'monthly_b', label: '月足 B' },
]
const PERIOD_TABS: { key: Period; label: string }[] = [
  { key: 'today', label: '本日' },
  { key: 'week',  label: '今週' },
  { key: 'month', label: '今月' },
]

function Loading({ h = 100 }: { h?: number }) {
  return (
    <div
      style={{
        height: h,
        background: 'var(--color-surface-subtle)',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 11,
      }}
    >
      読込中...
    </div>
  )
}

export default async function HexStagePage({
  searchParams,
}: {
  searchParams: Promise<{ ts?: string; period?: string }>
}) {
  const sp = await searchParams
  const ts = (VALID_TS as string[]).includes(sp.ts ?? '') ? (sp.ts as Timescale) : 'daily_a'
  const period = (VALID_PERIOD as string[]).includes(sp.period ?? '') ? (sp.period as Period) : 'today'

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>HEX ステージ分析</h1>
        <p>市場全体のステージ分布と銘柄の循環的な動きを観察します</p>
      </div>

      <div className="sb-section-bd" style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 0 }}>
        <TabRow basePath="/hex-stage" paramKey="ts" current={ts} tabs={TS_TABS} keepKeys={['period']} />
      </div>

      <div className="sb-section">
        <div className="sb-hd">
          <h2>6 ステージの循環</h2>
          <span>1 → 2 → 3 → 4 → 5 → 6 → 1 のサイクル</span>
        </div>
        <Suspense fallback={<Loading h={130} />}>
          <SixStageCircleMock timescale={ts} />
        </Suspense>
      </div>

      <div className="sb-section" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <h2 style={{ margin: '0 12px 0 0', fontSize: 14, fontWeight: 500 }}>ステージ変化サマリー</h2>
        <TabRow basePath="/hex-stage" paramKey="period" current={period} tabs={PERIOD_TABS} keepKeys={['ts']} />
      </div>

      <div className="sb-section grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <Suspense fallback={<Loading h={300} />}>
          <TransitionMatrixMock timescale={ts} period={period} />
        </Suspense>
        <Suspense fallback={<Loading h={300} />}>
          <PeriodCountTrendMock timescale={ts} />
        </Suspense>
      </div>

      <div className="sb-section">
        <Suspense fallback={<Loading h={300} />}>
          <TransitionDetailTableMock timescale={ts} period={period} />
        </Suspense>
      </div>

      <div style={{ borderTop: '0.5px solid var(--color-border-soft)' }}>
        <div className="sb-section" style={{ paddingTop: 14 }}>
          <HexStageMapView />
        </div>
      </div>
    </div>
  )
}
