'use client'

// components/us/UsDashboardShell.tsx
//
// 米国株 Dashboard の外枠。考え方は日本株の DashboardHistoricalShell と同じで、
// 日付切替中は古い内容を隠し「どの日付を確認中か」だけを示す。
// 切替完了後は contentKey が変わるため、前の日付のデータが新しい日付のラベルの下に残らない。
// 見出し・セクション構成・日付の取得先だけを米国株のものにする。

import { createContext, useContext, useMemo, useState } from 'react'
import { PageTitle } from '@/components/layout/PageTitle'
import { DashboardDateSelectorControl } from '@/components/dashboard/DashboardDateSelector'
import type { DashboardPendingTarget } from '@/components/dashboard/DashboardHistoricalShell'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { UsDashboardPendingSections, UsMarketBriefSkeleton } from '@/components/us/UsDashboardSkeletons'

/** 米国株の営業日 (market_daily_snapshots US)。API 側で上限は丸められる */
const US_DATES_ENDPOINT = '/api/us/hex/available-dates?limit=10000'
const US_SESSION_LABEL = '米国終値'

type PendingContextValue = {
  setPending: (target: DashboardPendingTarget | null) => void
}

const UsPendingContext = createContext<PendingContextValue | null>(null)

function targetLabel(target: string | null) {
  return target ? `${target} 時点` : '最新'
}

export function UsDashboardShell({
  header,
  selector,
  contentKey,
  children,
}: {
  header: React.ReactNode
  selector: React.ReactNode
  contentKey: string
  children: React.ReactNode
}) {
  const [pending, setPending] = useState<DashboardPendingTarget | null>(null)
  const value = useMemo(() => ({ setPending }), [])
  const isPending = pending !== null

  return (
    <UsPendingContext.Provider value={value}>
      <div className="flex w-full min-w-0 flex-col gap-5">
        {pending && <UsPendingHeader target={pending.date} />}
        <div hidden={isPending}>{header}</div>
        {selector}
        {pending && <UsPendingBody target={pending.date} historical={pending.historical} />}
        <div key={contentKey} hidden={isPending} className="flex min-w-0 flex-col gap-5">
          {children}
        </div>
      </div>
    </UsPendingContext.Provider>
  )
}

type SelectorProps = Omit<
  React.ComponentProps<typeof DashboardDateSelectorControl>,
  'datesEndpoint' | 'sessionLabel' | 'onPendingChange'
>

/** 日付の入力・カレンダーは日本株と同じ部品。営業日は米国市場のものを使う */
export function UsDashboardDateSelector(props: SelectorProps) {
  const context = useContext(UsPendingContext)
  if (!context) throw new Error('UsDashboardDateSelector は UsDashboardShell の内側で使います')
  return (
    <DashboardDateSelectorControl
      {...props}
      datesEndpoint={US_DATES_ENDPOINT}
      sessionLabel={US_SESSION_LABEL}
      onPendingChange={context.setPending}
    />
  )
}

function UsPendingHeader({ target }: { target: string | null }) {
  return (
    <PageTitle
      eyebrow="米国株"
      title="米国株ダッシュボード"
      subtitle={`${targetLabel(target)}の米国終値を確認しています`}
      badge="切り替え中"
      badgeTone="neutral"
    >
      <UsAnalysisNav current="/us" />
    </PageTitle>
  )
}

function UsPendingBody({ target, historical }: { target: string | null; historical: boolean }) {
  const label = targetLabel(target)
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}の米国株ダッシュボードを読み込んでいます</span>
      {historical && (
        <div
          className="h-[148px] rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-amber)] bg-white motion-safe:animate-pulse"
          aria-hidden="true"
        />
      )}
      <UsMarketBriefSkeleton historical={historical} caption={`${label}を確認中`} />
      <UsDashboardPendingSections targetLabel={label} />
    </div>
  )
}
