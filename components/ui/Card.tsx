// components/ui/Card.tsx
// Phase 5 共通カード: Robinhood 風の白い余白、薄い罫線、大きめタイポ。

import { cn } from '@/lib/util/cn'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg'
  inset?: boolean  // 内側パディング 0
}

export function Card({ className, size = 'md', inset, ...rest }: CardProps) {
  const pad = inset ? '' : size === 'sm' ? 'p-5' : size === 'lg' ? 'p-7' : 'p-6'
  return (
    <div
      {...rest}
      className={cn(
        'rounded-[8px] border border-[var(--color-border-soft)] bg-white shadow-none transition-[border-color,box-shadow] duration-200 hover:border-[var(--color-border-default)] hover:shadow-[var(--shadow-card)]',
        pad,
        className,
      )}
    />
  )
}

export function CardHeader({ title, action, hint }: { title: string; action?: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[17px] font-bold leading-tight">{title}</h2>
        {hint && <div className="mt-1.5 text-[12px] font-medium leading-none text-[var(--color-text-tertiary)]">{hint}</div>}
      </div>
      {action && <div className="shrink-0 text-[12px] font-semibold text-[var(--color-brand-700)]">{action}</div>}
    </div>
  )
}
