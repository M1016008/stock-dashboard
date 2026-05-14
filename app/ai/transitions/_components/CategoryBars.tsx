import type { PatternHorizonRow } from '@/lib/server/transitions'

export function CategoryBars({ horizons }: { horizons: PatternHorizonRow[] }) {
  return (
    <div className="space-y-2">
      {horizons.map(h => {
        const total = h.count
        if (total === 0) return null
        const segs = [
          { key: '+10%超',  count: h.very_up_count,   color: 'var(--color-price-up)',       opacity: 1 },
          { key: '+5〜+10%', count: h.up_count,        color: 'var(--color-price-up)',       opacity: 0.5 },
          { key: '±5%',     count: h.flat_count,      color: 'var(--color-text-tertiary)', opacity: 0.4 },
          { key: '-5〜-10%', count: h.down_count,      color: 'var(--color-price-down)',     opacity: 0.5 },
          { key: '-10%超',  count: h.very_down_count, color: 'var(--color-price-down)',     opacity: 1 },
        ]
        return (
          <div key={h.horizon_days}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span>{h.horizon_days}日</span>
              <span className="tabular-nums text-[var(--color-text-tertiary)]">
                n={h.count.toLocaleString()}
              </span>
            </div>
            <div className="flex h-4 overflow-hidden rounded border border-[var(--color-border-soft)]">
              {segs.map(s =>
                s.count > 0 ? (
                  <div
                    key={s.key}
                    style={{
                      width: `${(s.count / total) * 100}%`,
                      backgroundColor: s.color,
                      opacity: s.opacity,
                    }}
                    title={`${s.key}: ${s.count.toLocaleString()}件 (${((s.count / total) * 100).toFixed(1)}%)`}
                  />
                ) : null,
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
