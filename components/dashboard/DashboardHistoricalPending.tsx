// components/dashboard/DashboardHistoricalPending.tsx
//
// 日付切替中に、古い Dashboard の内容へ重ねて新しい日付を出さないための「確認中」ビュー。
// 切替先の日付をはっきり示し、完成形と同じ骨組みのスケルトンだけを出す。

import { PageTitle } from '@/components/layout/PageTitle'
import {
  DASHBOARD_SECTION_META,
  DashboardMarketBriefSkeleton,
  DashboardSectionFallback,
  type DashboardSectionId,
} from '@/components/dashboard/DashboardSectionFallback'

/** app/page.tsx の既定順と揃える */
const LATEST_SECTIONS: DashboardSectionId[] = ['momentum', 'signals', 'trade-overview', 'events', 'research']
const HISTORICAL_SECTIONS: DashboardSectionId[] = ['momentum', 'signals']

function targetLabel(target: string | null) {
  return target ? `${target} 時点` : '最新'
}

export function DashboardHistoricalPendingHeader({ target }: { target: string | null }) {
  return (
    <PageTitle
      eyebrow="日本株"
      title="ダッシュボード"
      subtitle={`${targetLabel(target)}の大引け情報を確認しています`}
      badge="切り替え中"
      badgeTone="neutral"
    />
  )
}

export function DashboardHistoricalPendingBody({
  target,
  historical,
}: {
  target: string | null
  historical: boolean
}) {
  const sections = historical ? HISTORICAL_SECTIONS : LATEST_SECTIONS
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{targetLabel(target)}のダッシュボードを読み込んでいます</span>
      {historical && (
        <div
          className="h-[148px] rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-amber)] bg-white motion-safe:animate-pulse"
          aria-hidden="true"
        />
      )}
      <DashboardMarketBriefSkeleton historical={historical} caption={`${targetLabel(target)}を確認中`} />
      <div className="flex flex-col gap-10 pt-11">
        {sections.map((id, index) => (
          <section key={id} className="min-w-0">
            <div className="mb-4 flex items-center gap-3 border-b-2 border-[var(--color-border-default)] pb-1.5">
              <span className="font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{String(index + 1).padStart(2, '0')}</span>
              <span className="text-[16px] font-bold leading-tight text-[var(--color-brand-900)]">{DASHBOARD_SECTION_META[id].label}</span>
              <span className="hidden text-[11px] font-semibold text-[var(--color-text-tertiary)] md:inline">{DASHBOARD_SECTION_META[id].description}</span>
              <span className="ml-auto h-7" aria-hidden="true" />
            </div>
            <DashboardSectionFallback quiet section={id} caption={`${targetLabel(target)}の${DASHBOARD_SECTION_META[id].label}を確認中`} />
          </section>
        ))}
      </div>
    </div>
  )
}
