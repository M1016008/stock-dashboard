// components/dashboard/EarningsCalendarPanel.tsx
// 決算発表予定銘柄を、株価・平均出来高・6軸ステージ込みの一覧で表示する。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedEarningsCalendar } from '@/lib/queries/dashboard-cache'

function fmtVol(v: number | null) {
  if (v == null) return '---'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  return Math.round(v / 1_000).toLocaleString() + 'K'
}

function fmtPrice(v: number | null) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function tone(v: number | null) {
  if (v == null) return ''
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : ''
}

export async function EarningsCalendarPanel() {
  const rows = await getCachedEarningsCalendar()
  return (
    <Card>
      <CardHeader title="決算発表銘柄" hint="株価・平均出来高・6軸ステージ" />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">
          データ未取り込み — `npm run batch:earnings` で取得してください
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
                <th className="pb-3 pl-2 pr-3">発表</th>
                <th className="pb-3 pr-3">銘柄名</th>
                <th className="pb-3 pr-3 text-right">現在株価</th>
                <th className="pb-3 pr-3 text-right">前日比</th>
                <th className="pb-3 pr-3 text-right">10日平均</th>
                <th className="pb-3 pr-3 text-right">30日平均</th>
                <th className="pb-3 pr-3 text-right">60日平均</th>
                <th className="pb-3 pr-3">日足A/B</th>
                <th className="pb-3 pr-3">週足A/B</th>
                <th className="pb-3 pr-2">月足A/B</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row) => {
                const isToday = row.daysLeft === 0
                return (
                  <tr key={row.ticker + row.announce_date} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className={`py-3 pl-2 pr-3 tabular-nums ${isToday ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}`}>
                      <div>{isToday ? '本日' : `+${row.daysLeft}d`}</div>
                      <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.announce_date.slice(5)}</div>
                    </td>
                    <td className="py-3 pr-3">
                      <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums hover:underline">{row.ticker}</Link>
                      <div className="mt-1 max-w-[260px] truncate font-semibold">{row.name ?? row.ticker}</div>
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums font-semibold">{fmtPrice(row.price)}</td>
                    <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.changePct)}`}>
                      {row.changePct == null ? '---' : (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%'}
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume10)}</td>
                    <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume30)}</td>
                    <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume60)}</td>
                    <td className="py-3 pr-3">
                      <div className="flex items-center gap-1"><StageTag stage={row.daily_a_stage} size="xs" /><StageTag stage={row.daily_b_stage} size="xs" /></div>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="flex items-center gap-1"><StageTag stage={row.weekly_a_stage} size="xs" /><StageTag stage={row.weekly_b_stage} size="xs" /></div>
                    </td>
                    <td className="py-3 pr-2">
                      <div className="flex items-center gap-1"><StageTag stage={row.monthly_a_stage} size="xs" /><StageTag stage={row.monthly_b_stage} size="xs" /></div>
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
