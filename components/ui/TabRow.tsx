// components/ui/TabRow.tsx
// モック準拠の sb-tab (URL クエリ ?paramKey= で連動)。keepKeys は他のパラメータを保持する。

'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

interface Props<T extends string> {
  basePath: string
  paramKey: string
  current: T
  tabs: { key: T; label: string }[]
  keepKeys?: string[]
}

export function TabRow<T extends string>({ basePath, paramKey, current, tabs, keepKeys = [] }: Props<T>) {
  const search = useSearchParams()
  return (
    <>
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
          <Link key={t.key} href={href} className={`sb-tab${on ? ' sb-on' : ''}`}>
            {t.label}
          </Link>
        )
      })}
    </>
  )
}
