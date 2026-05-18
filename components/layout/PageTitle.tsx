// components/layout/PageTitle.tsx
//
// Phase 4: ページタイトル + サブタイトル + 右側バッジ。
// h1 (22px / weight 400) のサンセンス、tracking-tight。

interface PageTitleProps {
  title: string
  subtitle?: string
  badge?: string
  rightSlot?: React.ReactNode
}

export function PageTitle({ title, subtitle, badge, rightSlot }: PageTitleProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 pb-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1>{title}</h1>
        {subtitle && (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">{subtitle}</span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        {rightSlot}
        {badge && (
          <span className="rounded-full bg-[var(--color-pattern-50)] px-2 py-0.5 text-[10px] tracking-tight text-[var(--color-pattern-700)]">
            {badge}
          </span>
        )}
      </div>
    </div>
  )
}
