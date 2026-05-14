import Link from 'next/link'

interface TickerLinkProps {
  ticker: string
  name?: string
  showName?: boolean
  variant?: 'default' | 'compact'
  className?: string
}

/**
 * 銘柄コードをクリックで /stock/[ticker] へ遷移するリンク。
 * Phase 4 以降のクロスリンク基盤、各画面で再利用。
 */
export function TickerLink({
  ticker,
  name,
  showName = false,
  variant = 'default',
  className = '',
}: TickerLinkProps) {
  const base =
    'inline-flex items-center gap-1.5 text-[var(--color-brand-700)] hover:text-[var(--color-brand-600)] hover:underline transition-colors'
  const sizes = {
    default: 'text-sm',
    compact: 'text-xs',
  }

  return (
    <Link href={`/stock/${ticker}`} className={`${base} ${sizes[variant]} ${className}`}>
      <span className="font-medium tabular-nums">{ticker}</span>
      {showName && name && (
        <span className="text-[var(--color-text-secondary)]">{name}</span>
      )}
    </Link>
  )
}
