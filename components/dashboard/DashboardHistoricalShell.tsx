'use client'

// components/dashboard/DashboardHistoricalShell.tsx
//
// 日付切替中は古い Dashboard の内容を隠し、「どの日付を確認中か」だけを示す。
// 切替完了後は contentKey が変わるため、セクションの Suspense が新しく始まり、
// 前の日付のデータが新しい日付のラベルの下に残ることはない。

import { createContext, useContext, useMemo, useState } from 'react'
import {
  DashboardHistoricalPendingBody,
  DashboardHistoricalPendingHeader,
} from '@/components/dashboard/DashboardHistoricalPending'

export type DashboardPendingTarget = {
  /** 切替先の日付。null は「最新」 */
  date: string | null
  /** 切替先が過去日表示 (対応セクションのみ) になるか */
  historical: boolean
}

type PendingContextValue = {
  setPending: (target: DashboardPendingTarget | null) => void
}

const PendingContext = createContext<PendingContextValue | null>(null)

export function useDashboardHistoricalPending(): PendingContextValue {
  const value = useContext(PendingContext)
  if (!value) throw new Error('useDashboardHistoricalPending は DashboardHistoricalShell の内側で使います')
  return value
}

export function DashboardHistoricalShell({
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
    <PendingContext.Provider value={value}>
      <div className="flex w-full flex-col gap-5">
        {pending && <DashboardHistoricalPendingHeader target={pending.date} />}
        <div hidden={isPending}>{header}</div>
        {selector}
        {pending && <DashboardHistoricalPendingBody target={pending.date} historical={pending.historical} />}
        <div key={contentKey} hidden={isPending} className="flex flex-col gap-5">
          {children}
        </div>
      </div>
    </PendingContext.Provider>
  )
}
