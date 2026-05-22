// components/sectors/SectorTopList.tsx — Top gainers/losers

import { Card, CardHeader } from '@/components/ui/Card'
import type { SectorRow } from '@/lib/queries/sectors'

export function SectorTopList({ rows, title, kind }: { rows: SectorRow[]; title: string; kind: 'up' | 'down' }) {
  return (
    <Card>
      <CardHeader title={title} hint="5 件" />
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
            <th className="pb-2 pr-2 font-normal">大分類</th>
            <th className="pb-2 pr-2 text-right font-normal">騰落率</th>
            <th className="pb-2 pr-2 text-right font-normal">銘柄数</th>
            <th className="pb-2 pr-2 text-right font-normal">{kind === 'up' ? 'ステ1+2' : 'ステ4+5'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map(r => {
            const tone = r.avg_change > 0 ? 'text-[var(--color-price-up)]' : r.avg_change < 0 ? 'text-[var(--color-price-down)]' : ''
            const stageCount = kind === 'up' ? r.stage_up_count : r.stage_down_count
            return (
              <tr key={r.sector_name} className="hover:bg-[var(--color-surface-subtle)]">
                <td className="max-w-[180px] truncate py-1.5 pr-2">{r.sector_name}</td>
                <td className={`py-1.5 pr-2 text-right tabular-nums ${tone}`}>{(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2) + '%'}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{r.n_stocks}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{stageCount}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
