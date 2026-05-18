// components/ui/Card.tsx
// Phase 4 共通カード: padding 16/20/24, border-soft, radius-card 12px。

import { cn } from '@/lib/util/cn'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg'
  inset?: boolean  // 内側パディング 0
}

export function Card({ className, size = 'md', inset, ...rest }: CardProps) {
  const pad = inset ? '' : size === 'sm' ? 'p-4' : size === 'lg' ? 'p-6' : 'p-5'
  return (
    <div
      {...rest}
      className={cn(
        'rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)]',
        pad,
        className,
      )}
    />
  )
}

export function CardHeader({ title, action, hint }: { title: string; action?: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium tracking-tight">{title}</h2>
        {hint && <span className="text-[10px] text-[var(--color-text-tertiary)]">{hint}</span>}
      </div>
      {action && <div className="text-[11px] text-[var(--color-text-tertiary)]">{action}</div>}
    </div>
  )
}
