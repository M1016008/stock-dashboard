// components/hex/TransitionDetailTable.tsx
// Phase 4 C7: 期間内に遷移した銘柄一覧。6 軸ステージタグ + from→to ステージ + 株価。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getTransitionDetail, type Timescale, type Period } from '@/lib/queries/hex'

const ALL_AXES: Array<{ key: keyof DetailRow & string; label: string }> = [
  { key: 'daily_a', label: '日A' },
  { key: 'daily_b', label: '日B' },
  { key: 'weekly_a', label: '週A' },
  { key: 'weekly_b', label: '週B' },
  { key: 'monthly_a', label: '月A' },
  { key: 'monthly_b', label: '月B' },
]

interface DetailRow {
  daily_a: number | null
  daily_b: number | null
  weekly_a: number | null
  weekly_b: number | null
  monthly_a: number | null
  monthly_b: number | null
}

function fmtVol(v: number | null) {
  if (v == null) return '---'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K'
  return v.toLocaleString()
}

export async function TransitionDetailTable({ timescale, period }: { timescale: Timescale; period: Period }) {
  const rows = await getTransitionDetail(timescale, period, 30)
  return (
    <Card>
      <CardHeader title="遷移銘柄一覧" hint={`${period} · ${rows.length} 件`} />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">該当銘柄なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
                <th className="pb-2 pr-2 font-normal">コード</th>
                <th className="pb-2 pr-2 font-normal">銘柄</th>
                <th className="pb-2 pr-2 font-normal">6 軸現在ステージ</th>
                <th className="pb-2 pr-2 font-normal">前→今</th>
                <th className="pb-2 pr-2 text-right font-normal">株価</th>
                <th className="pb-2 pr-2 text-right font-normal">前日比</th>
                <th className="pb-2 pr-2 text-right font-normal">出来高</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map(r => {
                const tone = r.changePct == null ? '' : r.changePct > 0 ? 'text-[var(--color-price-up)]' : r.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
                return (
                  <tr key={r.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="py-1.5 pr-2 tabular-nums">
                      <Link href={`/stock/${r.ticker}`} className="hover:underline">{r.ticker}</Link>
                    </td>
                    <td className="max-w-[160px] truncate py-1.5 pr-2">{r.name ?? r.ticker}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex gap-0.5">
                        {ALL_AXES.map(a => (
                          <StageTag
                            key={a.key}
                            stage={r[a.key] as number | null}
                            size="xs"
                            selected={a.key === timescale.replace(/_/, '_') as keyof DetailRow}
                          />
                        ))}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="inline-flex items-center gap-1">
                        <StageTag stage={r.from_stage} size="xs" />
                        <span className="text-[10px] text-[var(--color-text-tertiary)]">→</span>
                        <StageTag stage={r.to_stage} size="xs" />
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.price?.toLocaleString() ?? '---'}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${tone}`}>
                      {r.changePct == null ? '---' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2) + '%'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(r.volume)}</td>
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
