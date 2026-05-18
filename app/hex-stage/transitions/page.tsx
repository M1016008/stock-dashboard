// app/hex-stage/page.tsx
// Phase 4 C: HEX ステージ分析 — TimescaleTabs × 6 + 6 ステージカード + 6×6 遷移マトリクス + 詳細テーブル

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { TimescaleTabs, PeriodTabs } from '@/components/hex/TimescaleTabs'
import { SixStageCircle } from '@/components/hex/SixStageCircle'
import { TransitionMatrix } from '@/components/hex/TransitionMatrix'
import { PeriodCountTrend } from '@/components/hex/PeriodCountTrend'
import { TransitionDetailTable } from '@/components/hex/TransitionDetailTable'
import type { Timescale, Period } from '@/lib/queries/hex'

export const metadata: Metadata = {
  title: 'HEX ステージ — StockBoard',
  description: '市場全体のステージ分布と銘柄の循環的な動きを観察',
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
        rightSlot={
          <a href="/hex-stage" className="text-[11px] text-[var(--color-pattern-700)] hover:underline">
            ← マップビューに戻る
          </a>
        }
      />

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
    </div>
  )
}
