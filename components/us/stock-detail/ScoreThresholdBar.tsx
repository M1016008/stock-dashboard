import { formatDelta } from './technical-view'

/**
 * 3スコア共通の0中心バー(±2.5で頭打ち。数値は実値のまま表示)。判定の境界(marks)に縦線を引き、境界を越えた側は濃く塗る。
 * 方向を持たない量(neutral=PES)は上昇/下落色ではなくスレートで描く。表示専用。
 */
export function ScoreThresholdBar({
  value,
  text,
  label,
  neutral = false,
  marks = [],
}: {
  value: number | null | undefined
  text: string
  label: string
  neutral?: boolean
  marks?: number[]
}) {
  const numeric = value != null && Number.isFinite(value) ? value : null
  const ratio = numeric != null ? Math.min(1, Math.abs(numeric) / 2.5) : 0
  const negative = numeric != null && numeric < 0
  const color = neutral ? 'var(--color-price-flat)' : negative ? 'var(--price-down)' : 'var(--price-up)'
  const crossed = numeric != null && marks.some((mark) => (mark > 0 ? numeric >= mark : numeric <= mark))
  const at = (point: number) => `${((Math.max(-2.5, Math.min(2.5, point)) + 2.5) / 5) * 100}%`
  return (
    <span className="grid min-w-0 grid-cols-[minmax(28px,1fr)_3.25rem] items-center gap-2" title={`${label} ${text}`}>
      <span
        className="relative block h-3 bg-[var(--color-surface-subtle)]"
        role="img"
        aria-label={`${label} ${text}(-2.5〜+2.5の目盛り${marks.length > 0 ? `、判定境界 ${marks.map(formatDelta).join('と')}` : ''})`}
      >
        {numeric != null && ratio > 0 && (
          <span
            className="absolute inset-y-0"
            style={{
              width: `${Math.max(2, ratio * 50)}%`,
              ...(negative ? { right: '50%' } : { left: '50%' }),
              background: color,
              opacity: crossed ? 1 : 0.5,
            }}
          />
        )}
        {marks.map((mark) => (
          <span key={mark} className="absolute inset-y-[-2px] w-px bg-[var(--color-text-secondary)]/70" style={{ left: at(mark) }} />
        ))}
        <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-strong)]" />
      </span>
      <strong
        className="text-right font-mono text-[13px] font-bold tabular-nums"
        style={{ color: numeric == null ? 'var(--color-text-tertiary)' : neutral ? 'var(--color-text-primary)' : color }}
      >{text}</strong>
    </span>
  )
}
