// components/layout/PageTitle.tsx
//
// TradingView 調: 作業画面の上部に置く、薄い罫線だけのページタイトル。

interface PageTitleProps {
  title: string
  subtitle?: string
  badge?: string
  rightSlot?: React.ReactNode
}

export function PageTitle({ title, subtitle, badge, rightSlot }: PageTitleProps) {
  return (
    <div className="border-b border-[var(--color-border-soft)] pb-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-tight sm:text-[32px]">{title}</h1>
          {subtitle && (
            <div className="mt-1.5 text-[13px] font-semibold text-[var(--color-text-secondary)]">{subtitle}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rightSlot}
          {badge && (
            <span className="inline-flex h-7 items-center rounded-[6px] border border-[var(--color-pattern-100)] bg-[var(--color-pattern-50)] px-2.5 text-[11px] font-bold text-[var(--color-pattern-700)]">
              {badge}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
