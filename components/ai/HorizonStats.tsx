// components/ai/HorizonStats.tsx
// Phase 4 D4: 4 列の horizon KPI カード (30/60/90/180 日)

import type { HorizonStatRow } from '@/lib/queries/transitions'

export function HorizonStats({ rows }: { rows: HorizonStatRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-4 py-4 text-center text-[12px] text-[var(--color-text-tertiary)]">
        Horizon 統計データなし
      </div>
    )
  }
  return (
    <div className="grid grid-cols-4 gap-2.5">
      {rows.map(r => {
        const tone = r.p50 == null ? '' : r.p50 > 0 ? 'text-[var(--color-price-up)]' : r.p50 < 0 ? 'text-[var(--color-price-down)]' : ''
        return (
          <div key={r.horizon_days} className="rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-4 py-3">
            <div className="text-[11px] text-[var(--color-text-tertiary)]">{r.horizon_days}日後</div>
            <div className={`tabular-nums text-[18px] font-medium leading-tight ${tone}`}>
              {r.p50 == null ? '---' : (r.p50 > 0 ? '+' : '') + r.p50.toFixed(2) + '%'}
            </div>
            <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)] tabular-nums">
              勝率 {(r.winRate * 100).toFixed(0)}% · n={r.count.toLocaleString()}
            </div>
          </div>
        )
      })}
    </div>
  )
}
