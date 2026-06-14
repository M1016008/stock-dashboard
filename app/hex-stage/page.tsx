// app/hex-stage/page.tsx
// モック準拠 (v2) + 旧 HexMap 併存 + Suspense ストリーミング + キャッシュ無効化

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SixStageCircleMock } from '@/components/hex/SixStageCircleMock'
import { TransitionMatrixMock } from '@/components/hex/TransitionMatrixMock'
import { TransitionDetailTableMock } from '@/components/hex/TransitionDetailTableMock'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { HexDateSelector } from '@/components/hex/HexDateSelector'
import { TabRow } from '@/components/ui/TabRow'
import { getHexDateOptions, getLatestHexDate, resolveHexAsOfDate, type Timescale, type Period } from '@/lib/queries/hex'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'HEX ステージ — StockBoard',
  description: 'トレンドステージ分布 + 遷移分析 + B×A グリッドで市場全体を俯瞰',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const VALID_TS: Timescale[] = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b']
const VALID_PERIOD: Period[] = ['today', 'week', 'month', 'to_latest']

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
  { key: 'to_latest', label: '現在まで' },
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
  searchParams: Promise<{ ts?: string | string[]; period?: string | string[]; universe?: string | string[]; date?: string | string[] }>
}) {
  const sp = await searchParams
  const rawTs = Array.isArray(sp.ts) ? sp.ts[0] : sp.ts
  const rawPeriod = Array.isArray(sp.period) ? sp.period[0] : sp.period
  const rawDate = Array.isArray(sp.date) ? sp.date[0] : sp.date
  const ts = (VALID_TS as string[]).includes(rawTs ?? '') ? (rawTs as Timescale) : 'daily_a'
  const period = (VALID_PERIOD as string[]).includes(rawPeriod ?? '') ? (rawPeriod as Period) : 'today'
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const [latestDate, targetDate] = await Promise.all([
    getLatestHexDate(),
    resolveHexAsOfDate(rawDate ?? null),
  ])
  const selectedDate = targetDate && targetDate !== latestDate ? targetDate : null
  const initialDates = await getHexDateOptions(90, targetDate)

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>HEX ステージ分析</h1>
        <p>
          市場全体のステージ分布と銘柄の循環的な動きを観察します
          {universeMeta ? ` · ${universeMeta.shortLabel}に絞り込み中` : ''}
          {selectedDate ? ` · ${selectedDate}時点` : latestDate ? ` · 最新 ${latestDate}` : ''}
        </p>
      </div>

      <HexDateSelector dates={initialDates} selectedDate={selectedDate} latestDate={latestDate} targetDate={targetDate} />

      <div className="sb-section-bd" style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 0 }}>
        <TabRow basePath="/hex-stage" paramKey="ts" current={ts} tabs={TS_TABS} keepKeys={['period', UNIVERSE_FILTER_PARAM, 'date']} />
      </div>

      <div className="sb-section">
        <div className="sb-hd">
          <h2>6 ステージの循環</h2>
          <span>1 → 2 → 3 → 4 → 5 → 6 → 1 のサイクル</span>
        </div>
        <Suspense fallback={<Loading h={130} />}>
          <SixStageCircleMock timescale={ts} universe={universeFilter} asOfDate={targetDate} />
        </Suspense>
      </div>

      <div className="sb-section" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <h2 style={{ margin: '0 12px 0 0', fontSize: 14, fontWeight: 500 }}>ステージ変化サマリー</h2>
        <TabRow basePath="/hex-stage" paramKey="period" current={period} tabs={PERIOD_TABS} keepKeys={['ts', UNIVERSE_FILTER_PARAM, 'date']} />
      </div>

      <div className="sb-section">
        <Suspense fallback={<Loading h={300} />}>
          <TransitionMatrixMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
        </Suspense>
      </div>

      <div className="sb-section">
        <Suspense fallback={<Loading h={300} />}>
          <TransitionDetailTableMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
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
