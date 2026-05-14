import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'

interface StageBadgeProps {
  stage: number | null
  showLabel?: boolean
  size?: 'sm' | 'md'
  className?: string
}

/**
 * ステージ 1-6 を視覚化する小さなバッジ。HEX 配色 (lib/hex-stage の定数) を利用。
 */
export function StageBadge({
  stage,
  showLabel = false,
  size = 'sm',
  className = '',
}: StageBadgeProps) {
  if (stage == null || stage < 1 || stage > 6) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-md bg-[var(--color-surface-muted)] text-[var(--color-text-tertiary)] ${size === 'sm' ? 'h-5 w-5 text-xs' : 'h-6 px-2 text-sm'} ${className}`}
      >
        —
      </span>
    )
  }

  const bg = STAGE_BG_COLORS[stage]
  const border = STAGE_BORDER_COLORS[stage]
  const label = STAGE_LABELS[stage]
  const sizeClass = size === 'sm' ? 'h-5 w-5 text-xs' : 'h-6 px-2 text-sm'

  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-medium tabular-nums ${sizeClass} ${className}`}
      style={{
        backgroundColor: bg,
        border: `1px solid ${border}`,
        color: border,
      }}
      title={label}
    >
      {stage}
      {showLabel && <span className="ml-1.5 text-xs opacity-90">{label}</span>}
    </span>
  )
}
