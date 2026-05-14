import Link from 'next/link'

interface PatternBadgeProps {
  label?: string
  variant?: 'default' | 'subtle'
  code?: string           // 6 桁コード指定時はクリッカブル化 → /ai/transitions?code=...
  className?: string
}

export function PatternBadge({
  label,
  variant = 'default',
  code,
  className = '',
}: PatternBadgeProps) {
  const base =
    'inline-flex items-center gap-1 rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors'
  const variants = {
    default: 'bg-[var(--color-pattern-50)] text-[var(--color-pattern-700)]',
    subtle:
      'border border-[var(--color-pattern-500)]/30 text-[var(--color-pattern-700)]',
  }
  const interactive = code
    ? 'hover:bg-[var(--color-pattern-100)] cursor-pointer'
    : ''

  const content = (
    <>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <circle cx="4" cy="4" r="3" fill="currentColor" />
      </svg>
      <span>{code ? code : 'Pattern'}</span>
      {label && <span className="opacity-75">· {label}</span>}
    </>
  )

  if (code) {
    return (
      <Link
        href={`/ai/transitions?code=${code}`}
        className={`${base} ${variants[variant]} ${interactive} ${className}`}
      >
        {content}
      </Link>
    )
  }

  return (
    <span className={`${base} ${variants[variant]} ${className}`}>
      {content}
    </span>
  )
}
