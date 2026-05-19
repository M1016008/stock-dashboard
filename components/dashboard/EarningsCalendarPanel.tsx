// components/dashboard/EarningsCalendarPanel.tsx
// Phase 4 B12: 決算発表カレンダー (earnings_calendar テーブル経由のサーバーサイド版)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getEarningsCalendar } from '@/lib/queries/dashboard'

function fmtVol(v: number | null) {
  if (v == null) return '---'
  return (v / 1_000_000).toFixed(1) + 'M'
}

export async function EarningsCalendarPanel() {
  const rows = await getEarningsCalendar(14)
  return (
    <Card>
      <CardHeader title="決算発表カレンダー" hint="14 日先まで" />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">
          データ未取り込み — `npm run batch:earnings` で取得してください
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="text-left text-[12px] font-bold text-[var(--color-text-tertiary)]">
                <th className="pb-3 pl-2 pr-3 font-bold">残り</th>
                <th className="pb-3 pr-3 font-bold">発表日</th>
                <th className="pb-3 pr-3 font-bold">コード</th>
                <th className="pb-3 pr-3 font-bold">銘柄</th>
                <th className="pb-3 pr-3 font-bold">St</th>
                <th className="pb-3 pr-3 text-right font-bold">株価</th>
                <th className="pb-3 pr-3 text-right font-bold">前日比</th>
                <th className="pb-3 pr-2 text-right font-bold">平均出来高</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.slice(0, 12).map(r => {
                const isToday = r.daysLeft === 0
                const tone = r.changePct == null ? '' : r.changePct > 0 ? 'text-[var(--color-price-up)]' : r.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
                return (
                  <tr key={r.ticker + r.announce_date} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className={`py-2.5 pl-2 pr-3 tabular-nums ${isToday ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}`}>
                      {isToday ? '本日' : `+${r.daysLeft}d`}
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums text-[var(--color-text-secondary)]">{r.announce_date.slice(5)}</td>
                    <td className="py-2.5 pr-3 tabular-nums">
                      <Link href={`/stock/${r.ticker}`} className="hover:underline">{r.ticker}</Link>
                    </td>
                    <td className="max-w-[260px] truncate py-2.5 pr-3 font-semibold">{r.name ?? r.ticker}</td>
                    <td className="py-2.5 pr-3"><StageTag stage={r.daily_a_stage} size="xs" /></td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-medium">{r.price?.toLocaleString() ?? '---'}</td>
                    <td className={`py-2.5 pr-3 text-right tabular-nums font-medium ${tone}`}>
                      {r.changePct == null ? '---' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2) + '%'}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(r.avgVolume20)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length > 12 && (
            <div className="mt-3 text-right text-[12px] font-medium text-[var(--color-text-tertiary)]">残り {rows.length - 12} 銘柄</div>
          )}
        </div>
      )}
    </Card>
  )
}
