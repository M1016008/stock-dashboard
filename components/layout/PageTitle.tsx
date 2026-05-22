// components/layout/PageTitle.tsx
//
// Kabutan 調: ページ先頭に置く、高密度な市況パネル型タイトル。

interface PageTitleProps {
  title: string
  subtitle?: string
  badge?: string
  rightSlot?: React.ReactNode
}

export function PageTitle({ title, subtitle, badge, rightSlot }: PageTitleProps) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
      <div className="relative border-t-[3px] border-t-[var(--color-brand-700)] bg-[linear-gradient(90deg,var(--color-brand-50),#fff_72%)] px-4 py-3 before:absolute before:left-0 before:top-[-3px] before:h-[3px] before:w-[124px] before:bg-[var(--color-market-red)]">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold leading-tight text-[var(--color-brand-900)] sm:text-[24px]">{title}</h1>
            {subtitle && (
              <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">{subtitle}</div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {rightSlot}
            {badge && (
              <span className="inline-flex h-7 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-bold text-[var(--color-brand-800)] shadow-[inset_3px_0_0_var(--color-market-red)]">
                {badge}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
