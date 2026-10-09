// components/ui/EmptyState.tsx
// 空・エラー・注意の表示。状態ごとに専用の文言を出し、次の操作を 1 つだけ示す。

import { Info, SearchX, TriangleAlert } from 'lucide-react'

export function EmptyState({
  title,
  description,
  action,
  icon,
  className = '',
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div className={`empty-state ${className}`}>
      {icon ?? <SearchX size={22} aria-hidden />}
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__desc">{description}</p>}
      {action}
    </div>
  )
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className = '',
  role,
}: {
  tone?: 'info' | 'warning' | 'error' | 'neutral'
  title?: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
  role?: 'alert' | 'status'
}) {
  const Icon = tone === 'error' || tone === 'warning' ? TriangleAlert : Info
  return (
    <div className={`notice ${className}`} data-tone={tone} role={role}>
      <Icon size={15} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <strong className="block">{title}</strong>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
