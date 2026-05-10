interface DataDensityIndicatorProps {
  count: number
  thresholds?: {
    medium: number
    high: number
  }
  showCount?: boolean
  className?: string
}

export function DataDensityIndicator({
  count,
  thresholds = { medium: 10, high: 50 },
  showCount = true,
  className = '',
}: DataDensityIndicatorProps) {
  const filled =
    count >= thresholds.high
      ? 3
      : count >= thresholds.medium
        ? 2
        : count >= 1
          ? 1
          : 0

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] ${className}`}
    >
      <span
        className="inline-flex items-center gap-0.5"
        aria-label={`データ密度: ${filled}/3`}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              i < filled
                ? 'bg-[var(--color-pattern-600)]'
                : 'bg-[var(--color-border-strong)]'
            }`}
          />
        ))}
      </span>
      {showCount && <span className="tabular-nums">n={count}</span>}
    </span>
  )
}
