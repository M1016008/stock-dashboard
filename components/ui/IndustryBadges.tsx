// components/ui/IndustryBadges.tsx
// J-Quants 17業種・33業種・市場区分を省スペースで表示する。

type IndustryBadgesProps = {
  sector17?: string | null
  sector33?: string | null
  marketSegment?: string | null
  compact?: boolean
  className?: string
}

export function IndustryBadges({
  sector17,
  sector33,
  marketSegment,
  compact,
  className,
}: IndustryBadgesProps) {
  const items = [
    marketSegment ? { label: marketSegment, tone: 'market' } : null,
    sector17 ? { label: `17: ${sector17}`, tone: 's17' } : null,
    sector33 ? { label: `33: ${sector33}`, tone: 's33' } : null,
  ].filter(Boolean) as Array<{ label: string; tone: string }>

  if (items.length === 0) {
    return <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">業種未分類</span>
  }

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1 ${className ?? ''}`}>
      {items.map((item) => (
        <span
          key={`${item.tone}-${item.label}`}
          className={[
            'inline-flex max-w-[180px] items-center truncate rounded-[4px] border px-1.5 py-0.5 font-bold leading-none',
            compact ? 'text-[9px]' : 'text-[10px]',
            item.tone === 'market'
              ? 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
              : item.tone === 's17'
                ? 'border-[var(--color-brand-100)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
                : 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]',
          ].join(' ')}
          title={item.label}
        >
          {item.label}
        </span>
      ))}
    </span>
  )
}
