// components/ui/Card.tsx
// 共通カード: 繰り返しレコードや枠が意味を持つ分析ツールにだけ使う。
// 1px の罫線と 6px の角丸のみ。影・ホバー時の枠色変化は付けない。

import { cn } from '@/lib/util/cn'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg'
  inset?: boolean  // 内側パディング 0
}

export function Card({ className, size = 'md', inset, ...rest }: CardProps) {
  const pad = inset ? '' : size === 'sm' ? 'p-3' : size === 'lg' ? 'p-4 sm:p-5' : 'p-4'
  return (
    <div
      {...rest}
      className={cn(
        'min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white',
        pad,
        className,
      )}
    />
  )
}

export function CardHeader({ title, action, hint }: { title: string; action?: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] pb-2.5">
      <div className="min-w-0">
        <h2 className="text-[14px] font-bold leading-tight text-[var(--color-text-primary)]">{title}</h2>
        {hint && <div className="mt-1 text-[11px] leading-snug text-[var(--color-text-tertiary)]">{hint}</div>}
      </div>
      {action && <div className="shrink-0 text-[11px] font-bold text-[var(--color-brand-700)]">{action}</div>}
    </div>
  )
}
