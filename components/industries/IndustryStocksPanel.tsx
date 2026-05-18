// components/industries/IndustryStocksPanel.tsx
// Phase 4 F4: 業界に属する銘柄一覧

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import type { IndustryStockRow } from '@/lib/queries/industries'

function fmtMarketCap(v: number | null) {
  if (v == null) return '---'
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '兆'
  if (v >= 1e8) return (v / 1e8).toFixed(0) + '億'
  return v.toLocaleString()
}

export function IndustryStocksPanel({
  industry,
  rows,
}: { industry: string; rows: IndustryStockRow[] }) {
  return (
    <Card>
      <CardHeader title={`選択中: ${industry} 業界`} hint={`${rows.length} 銘柄`} />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">該当銘柄なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
                <th className="pb-2 pr-2 font-normal">コード</th>
                <th className="pb-2 pr-2 font-normal">銘柄</th>
                <th className="pb-2 pr-2 font-normal">6 軸ステージ</th>
                <th className="pb-2 pr-2 text-right font-normal">株価</th>
                <th className="pb-2 pr-2 text-right font-normal">前日比</th>
                <th className="pb-2 pr-2 text-right font-normal">時価総額</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.slice(0, 30).map(r => {
                const tone = r.changePct == null ? '' : r.changePct > 0 ? 'text-[var(--color-price-up)]' : r.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
                return (
                  <tr key={r.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="py-1.5 pr-2 tabular-nums">
                      <Link href={`/stock/${r.ticker}`} className="hover:underline">{r.ticker}</Link>
                    </td>
                    <td className="max-w-[200px] truncate py-1.5 pr-2">{r.name ?? r.ticker}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex gap-0.5">
                        <StageTag stage={r.daily_a} size="xs" />
                        <StageTag stage={r.daily_b} size="xs" />
                        <StageTag stage={r.weekly_a} size="xs" />
                        <StageTag stage={r.weekly_b} size="xs" />
                        <StageTag stage={r.monthly_a} size="xs" />
                        <StageTag stage={r.monthly_b} size="xs" />
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.price?.toLocaleString() ?? '---'}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${tone}`}>
                      {r.changePct == null ? '---' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2) + '%'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtMarketCap(r.marketCap)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length > 30 && (
            <div className="mt-2 text-right text-[11px] text-[var(--color-text-tertiary)]">残り {rows.length - 30} 銘柄</div>
          )}
        </div>
      )}
    </Card>
  )
}
