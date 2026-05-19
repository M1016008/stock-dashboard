// components/layout/PageTitle.tsx
//
// Phase 4: ページタイトル + サブタイトル + 右側バッジ。

interface PageTitleProps {
  title: string
  subtitle?: string
  badge?: string
  rightSlot?: React.ReactNode
}

export function PageTitle({ title, subtitle, badge, rightSlot }: PageTitleProps) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-white p-6 sm:p-7">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <h1>{title}</h1>
        {subtitle && (
          <div className="mt-2 text-[15px] font-medium text-[var(--color-text-secondary)]">{subtitle}</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {rightSlot}
        {badge && (
          <span className="inline-flex items-center rounded-full border border-[var(--color-pattern-100)] bg-[var(--color-pattern-50)] px-3.5 py-2 text-[12px] font-bold text-[var(--color-pattern-700)]">
            {badge}
          </span>
        )}
      </div>
      </div>
      <div className="mt-6 h-1.5 w-28 rounded-full bg-[var(--color-brand-500)]" />
    </div>
  )
}
