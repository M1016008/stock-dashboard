// components/ai/SampleCases.tsx
// Phase 4 D7: サンプルケース (出現日 / 4 horizon)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import type { SampleCaseRow } from '@/lib/queries/transitions'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}
function toneClass(v: number | null) {
  if (v == null) return ''
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : ''
}

export function SampleCases({ rows, total }: { rows: SampleCaseRow[]; total: number }) {
  return (
    <Card>
      <CardHeader title="サンプルケース" hint={`直近 ${rows.length} 件 / 全 ${total.toLocaleString()} 件`} />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">該当なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
                <th className="pb-2 pr-2 font-normal">出現日</th>
                <th className="pb-2 pr-2 font-normal">コード</th>
                <th className="pb-2 pr-2 font-normal">銘柄</th>
                <th className="pb-2 pr-2 font-normal">業種</th>
                <th className="pb-2 pr-2 text-right font-normal">+30日</th>
                <th className="pb-2 pr-2 text-right font-normal">+60日</th>
                <th className="pb-2 pr-2 text-right font-normal">+90日</th>
                <th className="pb-2 pr-2 text-right font-normal">+180日</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map(r => (
                <tr key={r.ticker + r.date} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="py-1.5 pr-2 tabular-nums text-[var(--color-text-secondary)]">{r.date}</td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    <Link href={`/stock/${r.ticker}`} className="hover:underline">{r.ticker}</Link>
                  </td>
                  <td className="max-w-[160px] truncate py-1.5 pr-2">{r.name ?? r.ticker}</td>
                  <td className="max-w-[120px] truncate py-1.5 pr-2 text-[var(--color-text-tertiary)]">{r.sector ?? '---'}</td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${toneClass(r.r30)}`}>{fmtPct(r.r30)}</td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${toneClass(r.r60)}`}>{fmtPct(r.r60)}</td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${toneClass(r.r90)}`}>{fmtPct(r.r90)}</td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${toneClass(r.r180)}`}>{fmtPct(r.r180)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
