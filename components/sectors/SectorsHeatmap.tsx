// components/sectors/SectorsHeatmap.tsx — Phase 4 E2

import Link from 'next/link'
import type { SectorRow } from '@/lib/queries/sectors'

function colorFor(pct: number): { bg: string; text: string } {
  const intensity = Math.min(0.30, Math.max(0.05, Math.abs(pct) / 3 * 0.30))
  if (pct > 0) return { bg: `rgba(220,38,38,${intensity})`, text: 'var(--color-price-up)' }
  if (pct < 0) return { bg: `rgba(37,99,235,${intensity})`, text: 'var(--color-price-down)' }
  return { bg: 'var(--color-surface-muted)', text: 'var(--color-text-secondary)' }
}

export function SectorsHeatmap({ rows, selected }: { rows: SectorRow[]; selected: string | null }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-4 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
        業種データなし
      </div>
    )
  }
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {rows.map(r => {
        const c = colorFor(r.avg_change ?? 0)
        const isSelected = selected === r.sector_name
        const params = new URLSearchParams({ selected: r.sector_name })
        return (
          <Link
            key={r.sector_name}
            href={`/sectors?${params.toString()}`}
            className={`flex flex-col justify-between rounded-[6px] px-2 py-1.5 transition-all hover:brightness-95 ${
              isSelected ? 'outline outline-[1.5px] outline-[var(--color-brand-600)] outline-offset-[1px]' : ''
            }`}
            style={{ backgroundColor: c.bg, minHeight: 52 }}
          >
            <span className="line-clamp-2 text-[10px] leading-tight text-[var(--color-text-secondary)]">{r.sector_name}</span>
            <div className="flex items-baseline justify-between gap-1">
              <span className="tabular-nums text-[10px] text-[var(--color-text-tertiary)]">{r.n_stocks}</span>
              <span className="tabular-nums text-[11px] font-medium" style={{ color: c.text }}>
                {(r.avg_change > 0 ? '+' : '') + (r.avg_change ?? 0).toFixed(2) + '%'}
              </span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
