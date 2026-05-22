// components/hex/PeriodCountTrend.tsx
// Phase 4 C6: 本日/今週/今月の遷移件数 KPI + 横バー

import { Card, CardHeader } from '@/components/ui/Card'
import { getPeriodCountTrend, type Timescale } from '@/lib/queries/hex'

export async function PeriodCountTrend({ timescale }: { timescale: Timescale }) {
  const rows = await getPeriodCountTrend(timescale)
  const max = Math.max(...rows.map(r => r.count), 1)
  return (
    <Card>
      <CardHeader title="期間別 遷移件数" hint={timescale} />
      <div className="flex flex-col gap-3">
        {rows.map(r => {
          const pct = (r.count / max) * 100
          return (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-12 text-[12px] text-[var(--color-text-secondary)]">{r.label}</span>
              <div className="relative h-5 flex-1 overflow-hidden rounded-[3px] bg-[var(--color-surface-muted)]">
                <div
                  className="h-full rounded-[3px] bg-[var(--color-brand-500)] opacity-80"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 text-right tabular-nums text-[13px] font-medium">{r.count.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
