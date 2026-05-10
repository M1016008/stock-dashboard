interface PatternBadgeProps {
  label?: string
  variant?: 'default' | 'subtle'
  className?: string
}

export function PatternBadge({
  label,
  variant = 'default',
  className = '',
}: PatternBadgeProps) {
  const base =
    'inline-flex items-center gap-1 rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums'
  const variants = {
    default: 'bg-[var(--color-pattern-50)] text-[var(--color-pattern-700)]',
    subtle:
      'border border-[var(--color-pattern-500)]/30 text-[var(--color-pattern-700)]',
  }
  return (
    <span className={`${base} ${variants[variant]} ${className}`}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <circle cx="4" cy="4" r="3" fill="currentColor" />
      </svg>
      <span>Pattern</span>
      {label && <span className="opacity-75">· {label}</span>}
    </span>
  )
}
