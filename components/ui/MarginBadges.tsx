type MarginBadgesProps = {
  marginType?: string | null
  creditRatio?: number | null
  shortRatio?: number | null
  compact?: boolean
}

function fmtRatio(value: number | null | undefined, suffix = 'x') {
  if (value == null || !Number.isFinite(value)) return null
  return `${value.toFixed(1)}${suffix}`
}

export function MarginBadges({ marginType, creditRatio, shortRatio, compact = false }: MarginBadgesProps) {
  const type = marginType?.trim() || null
  const credit = fmtRatio(creditRatio)
  const short = shortRatio == null || !Number.isFinite(shortRatio) ? null : `${shortRatio.toFixed(1)}%`
  if (!type && !credit && !short) {
    return <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">---</span>
  }
  const typeTone = type === '貸借'
    ? 'border-[rgba(37,99,235,0.22)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
    : 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
  return (
    <div className="flex flex-wrap gap-1">
      {type && (
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap ${typeTone}`}>
          {type}
        </span>
      )}
      {!compact && credit && (
        <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[11px] font-bold leading-tight text-[var(--color-text-secondary)] whitespace-nowrap">
          信用倍率 {credit}
        </span>
      )}
      {!compact && short && (
        <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-2 py-0.5 text-[11px] font-bold leading-tight text-[var(--color-text-tertiary)] whitespace-nowrap">
          売残比 {short}
        </span>
      )}
    </div>
  )
}
