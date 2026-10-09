// components/ui/TabRow.tsx
// URL クエリ ?paramKey= で連動する表示切替。keepKeys は他のパラメータを保持する。
// 見た目は ViewTabs と共通 (.view-tabs / .view-tab)。

'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

interface Props<T extends string> {
  basePath: string
  paramKey: string
  current: T
  tabs: { key: T; label: string }[]
  keepKeys?: string[]
  label?: string
}

export function TabRow<T extends string>({ basePath, paramKey, current, tabs, keepKeys = [], label }: Props<T>) {
  const search = useSearchParams()
  return (
    <nav aria-label={label ?? paramKey} className="view-tabs">
      {tabs.map(t => {
        const params = new URLSearchParams()
        for (const k of keepKeys) {
          const v = search.get(k)
          if (v) params.set(k, v)
        }
        params.set(paramKey, t.key)
        const href = `${basePath}?${params.toString()}`
        const on = current === t.key
        return (
          <Link key={t.key} href={href} aria-current={on ? 'page' : undefined} className="view-tab">
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
