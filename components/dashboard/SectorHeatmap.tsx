// components/dashboard/SectorHeatmap.tsx
// Phase 4 B8: 33 業種ヒートマップ (J-Quants Sector33 ベース)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { getSector33Heatmap } from '@/lib/queries/dashboard'

function colorFor(pct: number): { bg: string; text: string } {
  // -3% ~ +3% を 0.05 ~ 0.30 opacity に
  const intensity = Math.min(0.30, Math.max(0.04, Math.abs(pct) / 3 * 0.30))
  if (pct > 0) {
    return { bg: `rgba(220,38,38,${intensity})`, text: 'var(--color-price-up)' }
  }
  if (pct < 0) {
    return { bg: `rgba(37,99,235,${intensity})`, text: 'var(--color-price-down)' }
  }
  return { bg: 'var(--color-surface-muted)', text: 'var(--color-text-secondary)' }
}

export async function SectorHeatmap() {
  const rows = await getSector33Heatmap()
  return (
    <Card>
      <CardHeader
        title="33 業種ヒートマップ"
        action={<Link href="/sectors" className="hover:text-[var(--color-text-secondary)]">大分類で見る ↗</Link>}
        hint={`${rows.length} 業種`}
      />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">
          業種データなし — `batch:listed-info` を実行してください
        </div>
      ) : (
        <div className="grid grid-cols-6 gap-1">
          {rows.map(r => {
            const c = colorFor(r.avg_change ?? 0)
            return (
              <div
                key={(r.sector_code ?? '_') + r.sector_name}
                className="flex h-[44px] flex-col justify-between rounded-[4px] px-1.5 py-1"
                style={{ backgroundColor: c.bg }}
              >
                <span className="line-clamp-2 text-[9px] leading-tight text-[var(--color-text-secondary)]">
                  {r.sector_name}
                </span>
                <span className="tabular-nums text-[11px] font-medium" style={{ color: c.text }}>
                  {(r.avg_change > 0 ? '+' : '') + (r.avg_change ?? 0).toFixed(2) + '%'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
