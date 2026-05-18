// components/ai/SectorBreakdown.tsx
// Phase 4 D6: 業種分布 (横バー、teal)

import { Card, CardHeader } from '@/components/ui/Card'
import type { SectorBreakdownRow } from '@/lib/queries/transitions'

export function SectorBreakdown({ rows }: { rows: SectorBreakdownRow[] }) {
  const max = Math.max(...rows.map(r => r.count), 1)
  return (
    <Card>
      <CardHeader title="業種分布" hint="Sector33" />
      {rows.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">データなし</div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(r => {
            const pct = (r.count / max) * 100
            return (
              <div key={r.sector_name} className="grid grid-cols-[1fr_60px] items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-[140px] truncate text-[12px]">{r.sector_name}</span>
                  <div className="relative h-3 flex-1 overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]">
                    <div className="h-full bg-[var(--color-pattern-600)] opacity-80" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="text-right tabular-nums text-[12px] text-[var(--color-text-secondary)]">{r.count.toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
