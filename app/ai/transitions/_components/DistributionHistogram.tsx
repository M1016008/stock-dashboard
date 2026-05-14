interface DistributionHistogramProps {
  horizon: number
  p05: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  p95: number | null
  count: number
}

/**
 * 5 分位 (p05/p25/p50/p75/p95) を縦長のレンジ図 (箱ひげ風) で表示。
 * 表示範囲固定 ±30%、これを 0% center として正規化。
 */
export function DistributionHistogram({
  horizon,
  p05,
  p25,
  p50,
  p75,
  p95,
  count,
}: DistributionHistogramProps) {
  if ([p05, p25, p50, p75, p95].some(v => v == null)) {
    return (
      <div className="rounded border border-[var(--color-border-soft)] p-2">
        <div className="mb-1 text-xs text-[var(--color-text-tertiary)]">
          {horizon}日 (n={count.toLocaleString()})
        </div>
        <div className="text-xs text-[var(--color-text-tertiary)]">データ不足</div>
      </div>
    )
  }

  const RANGE = 30
  const clamp = (v: number) => Math.max(-RANGE, Math.min(RANGE, v))
  const toPercent = (v: number) => ((clamp(v) + RANGE) / (2 * RANGE)) * 100
  const center = toPercent(0)

  return (
    <div className="rounded border border-[var(--color-border-soft)] p-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-[var(--color-text-secondary)]">{horizon}日</span>
        <span className="tabular-nums text-[var(--color-text-tertiary)]">
          n={count.toLocaleString()}
        </span>
      </div>
      <div className="relative h-16 rounded bg-[var(--color-surface-muted)]">
        {/* 0% 縦線 */}
        <div
          className="absolute top-0 bottom-0"
          style={{
            left: `${center}%`,
            width: 1,
            backgroundColor: 'var(--color-border-strong)',
          }}
        />
        {/* p25-p75 ボックス */}
        <div
          className="absolute top-3 bottom-3 rounded"
          style={{
            left: `${toPercent(p25!)}%`,
            width: `${Math.max(0.5, toPercent(p75!) - toPercent(p25!))}%`,
            backgroundColor: 'var(--color-pattern-100)',
            border: '1px solid var(--color-pattern-500)',
            opacity: 0.7,
          }}
        />
        {/* p05-p95 ひげ */}
        <div
          className="absolute top-1/2 -translate-y-1/2"
          style={{
            left: `${toPercent(p05!)}%`,
            width: `${toPercent(p95!) - toPercent(p05!)}%`,
            height: '1px',
            backgroundColor: 'var(--color-pattern-500)',
          }}
        />
        {/* p50 中央線 */}
        <div
          className="absolute top-2 bottom-2"
          style={{
            left: `${toPercent(p50!)}%`,
            width: '2px',
            backgroundColor: 'var(--color-pattern-700)',
          }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
        <span>-{RANGE}%</span>
        <span
          className={`font-medium ${
            p50! > 0
              ? 'text-[var(--color-price-up)]'
              : p50! < 0
                ? 'text-[var(--color-price-down)]'
                : ''
          }`}
        >
          中央 {p50! >= 0 ? '+' : ''}
          {p50!.toFixed(1)}%
        </span>
        <span>+{RANGE}%</span>
      </div>
    </div>
  )
}
