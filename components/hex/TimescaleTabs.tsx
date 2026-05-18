// components/hex/TimescaleTabs.tsx
// Phase 4 C2: 6 タイムスケール切替タブ。URL クエリ ?ts= で連動。

'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

const TABS = [
  { key: 'daily_a',   label: '日足 A' },
  { key: 'daily_b',   label: '日足 B' },
  { key: 'weekly_a',  label: '週足 A' },
  { key: 'weekly_b',  label: '週足 B' },
  { key: 'monthly_a', label: '月足 A' },
  { key: 'monthly_b', label: '月足 B' },
] as const

export function TimescaleTabs({ current }: { current: string }) {
  const pathname = usePathname()
  const search = useSearchParams()
  return (
    <div className="flex gap-0.5 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-1">
      {TABS.map(t => {
        const params = new URLSearchParams(search.toString())
        params.set('ts', t.key)
        const active = current === t.key
        return (
          <Link
            key={t.key}
            href={`${pathname}?${params.toString()}`}
            className={`flex-1 rounded-[6px] px-3 py-1.5 text-center text-[12px] tracking-tight ${
              active
                ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] font-medium'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}

export function PeriodTabs({ current }: { current: string }) {
  const pathname = usePathname()
  const search = useSearchParams()
  const tabs = [
    { key: 'today', label: '本日' },
    { key: 'week', label: '今週' },
    { key: 'month', label: '今月' },
  ] as const
  return (
    <div className="inline-flex gap-0.5 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-0.5">
      {tabs.map(t => {
        const params = new URLSearchParams(search.toString())
        params.set('period', t.key)
        const active = current === t.key
        return (
          <Link
            key={t.key}
            href={`${pathname}?${params.toString()}`}
            className={`rounded-[4px] px-2.5 py-1 text-[11px] tracking-tight ${
              active
                ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] font-medium'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
