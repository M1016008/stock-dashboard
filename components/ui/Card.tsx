// components/ui/Card.tsx
// 共通カード: TradingView 風の白いパネル、薄い罫線、コンパクトな情報密度。

import { cn } from '@/lib/util/cn'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg'
  inset?: boolean  // 内側パディング 0
}

export function Card({ className, size = 'md', inset, ...rest }: CardProps) {
  const pad = inset ? '' : size === 'sm' ? 'p-4' : size === 'lg' ? 'p-5' : 'p-4 sm:p-5'
  return (
    <div
      {...rest}
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-white shadow-none transition-colors duration-150 hover:border-[var(--color-border-default)]',
        pad,
        className,
      )}
    />
  )
}

export function CardHeader({ title, action, hint }: { title: string; action?: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4 border-b border-[var(--color-border-soft)] pb-3">
      <div className="min-w-0">
        <h2 className="text-[14px] font-bold leading-tight">{title}</h2>
        {hint && <div className="mt-1 text-[11px] font-semibold leading-none text-[var(--color-text-tertiary)]">{hint}</div>}
      </div>
      {action && <div className="shrink-0 text-[11px] font-bold text-[var(--color-brand-700)]">{action}</div>}
    </div>
  )
}
