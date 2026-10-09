// components/ui/ViewTabs.tsx
// ページ内の表示切替 (同じデータの別ビュー / 同じ機能群の兄弟ページ)。
// リンクでもボタンでも同じ見た目にし、現在地は aria-current で示す。

import Link from 'next/link'

export type ViewTabItem = {
  key: string
  label: React.ReactNode
  href?: string
  onClick?: () => void
  count?: number | null
  icon?: React.ReactNode
}

export function ViewTabs({
  items,
  current,
  label,
  className = '',
}: {
  items: ViewTabItem[]
  current: string
  label: string
  className?: string
}) {
  return (
    <nav aria-label={label} className={`view-tabs ${className}`}>
      {items.map((item) => {
        const active = item.key === current
        const body = (
          <>
            {item.icon}
            {item.label}
            {item.count != null && <span className="view-tab__count">{item.count.toLocaleString('ja-JP')}</span>}
          </>
        )
        return item.href ? (
          <Link
            key={item.key}
            href={item.href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className="view-tab"
          >
            {body}
          </Link>
        ) : (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            aria-current={active ? 'page' : undefined}
            className="view-tab"
          >
            {body}
          </button>
        )
      })}
    </nav>
  )
}
