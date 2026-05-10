import Link from 'next/link'
import { PatternBadge } from './PatternBadge'
import { DataDensityIndicator } from './DataDensityIndicator'

export interface PatternRankingItem {
  rank: number
  ticker: string
  name: string
  primaryValue: string | number
  primaryLabel?: string
  density?: number
  href?: string
}

interface PatternRankingProps {
  title: string
  items: PatternRankingItem[]
  emptyMessage?: string
  className?: string
}

export function PatternRanking({
  title,
  items,
  emptyMessage = '該当するパターンがありません',
  className = '',
}: PatternRankingProps) {
  return (
    <section
      className={`rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] ${className}`}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-[var(--spacing-card-x)] py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          <PatternBadge variant="subtle" />
        </div>
      </header>

      {items.length === 0 ? (
        <p className="px-[var(--spacing-card-x)] py-6 text-center text-xs text-[var(--color-text-tertiary)]">
          {emptyMessage}
        </p>
      ) : (
        <ol className="divide-y divide-[var(--color-border-soft)]">
          {items.map((item) => (
            <li key={item.ticker}>
              <Link
                href={item.href ?? `/stock/${item.ticker}`}
                className="flex items-center gap-3 px-[var(--spacing-card-x)] py-2.5 transition-colors hover:bg-[var(--color-surface-muted)]"
              >
                <span className="w-6 text-right text-xs font-medium tabular-nums text-[var(--color-text-tertiary)]">
                  {item.rank}
                </span>
                <span className="w-14 text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
                  {item.ticker}
                </span>
                <span className="flex-1 truncate text-sm text-[var(--color-text-primary)]">
                  {item.name}
                </span>
                {item.density !== undefined && (
                  <DataDensityIndicator count={item.density} showCount={false} />
                )}
                <span className="w-20 text-right text-sm font-semibold tabular-nums">
                  {item.primaryValue}
                </span>
                {item.primaryLabel && (
                  <span className="hidden w-24 text-right text-[10px] text-[var(--color-text-tertiary)] sm:inline">
                    {item.primaryLabel}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
