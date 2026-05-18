// components/sectors/SectorDetailPanel.tsx — Phase 4 E4: 選択した大分類の詳細

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import type { SubSectorRow } from '@/lib/queries/sectors'

export function SectorDetailPanel({
  sectorName,
  rows,
}: { sectorName: string; rows: SubSectorRow[] }) {
  const totalStocks = rows.reduce((a, r) => a + r.n_stocks, 0)
  return (
    <Card>
      <CardHeader
        title={`選択中: ${sectorName}`}
        hint={`${rows.length} 業種細分類 · ${totalStocks.toLocaleString()} 銘柄`}
      />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">業種細分類データなし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
                <th className="pb-2 pr-2 font-normal">業種細分類</th>
                <th className="pb-2 pr-2 text-right font-normal">銘柄数</th>
                <th className="pb-2 pr-2 text-right font-normal">騰落率</th>
                <th className="pb-2 pr-2 text-right font-normal">ステ1+2比率</th>
                <th className="pb-2 pr-2 font-normal">代表銘柄</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map(r => {
                const tone = r.avg_change > 0 ? 'text-[var(--color-price-up)]' : r.avg_change < 0 ? 'text-[var(--color-price-down)]' : ''
                const params = new URLSearchParams({ selected: r.sub_industry })
                const top3 = (r.topTickers ?? '').split(',').filter(Boolean).slice(0, 3)
                return (
                  <tr key={r.sub_industry} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="py-1.5 pr-2">
                      <Link href={`/industries?${params.toString()}`} className="hover:underline">{r.sub_industry}</Link>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{r.n_stocks}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${tone}`}>{(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2) + '%'}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{(r.upRatio * 100).toFixed(0)}%</td>
                    <td className="max-w-[180px] truncate py-1.5 pr-2 text-[var(--color-text-tertiary)]">
                      {top3.map(t => <Link key={t} href={`/stock/${t}`} className="mr-2 hover:underline">{t}</Link>)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
