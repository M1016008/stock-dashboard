// components/dashboard/StereoscopicSignals.tsx
// 6軸ステージ一致シグナルを、価格・出来高・複数期間中央値込みで表示する。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedStereoscopicSignals } from '@/lib/queries/dashboard-cache'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function fmtPrice(v: number | null) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function tone(v: number | null) {
  if (v == null) return 'text-[var(--color-text-tertiary)]'
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'
}

export async function StereoscopicSignals() {
  const rows = await getCachedStereoscopicSignals()
  return (
    <Card>
      <CardHeader
        title="立体的類似シグナル"
        hint="6軸ステージ一致 / N≧40 / 30日中央値順"
        action={<Link href="/ai/transitions" className="hover:text-[var(--color-text-secondary)]">分析へ ↗</Link>}
      />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">該当銘柄なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
                <th className="pb-3 pl-2 pr-3">銘柄</th>
                <th className="pb-3 pr-3">業種</th>
                <th className="pb-3 pr-3 text-right">株価</th>
                <th className="pb-3 pr-3 text-right">前日比</th>
                <th className="pb-3 pr-3 text-right">出来高比</th>
                <th className="pb-3 pr-3">Stage</th>
                <th className="pb-3 pr-3 text-right">N</th>
                <th className="pb-3 pr-3 text-right">30日</th>
                <th className="pb-3 pr-3 text-right">60日</th>
                <th className="pb-3 pr-2 text-right">90日</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row) => (
                <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="py-3 pl-2 pr-3">
                    <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums hover:underline">{row.ticker}</Link>
                    <div className="mt-1 max-w-[210px] truncate text-[12px] font-semibold">{row.name ?? row.ticker}</div>
                    <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">pattern {row.patternCode}</div>
                  </td>
                  <td className="py-3 pr-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">{row.sectorName ?? 'その他'}</td>
                  <td className="py-3 pr-3 text-right tabular-nums font-semibold">{fmtPrice(row.price)}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.changePct)}`}>{fmtPct(row.changePct)}</td>
                  <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{row.volumeRatio30 == null ? '---' : row.volumeRatio30.toFixed(1) + 'x'}</td>
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-1">
                      <StageTag stage={row.daily_a_stage} size="xs" />
                      <StageTag stage={row.daily_b_stage} size="xs" />
                      <StageTag stage={row.weekly_a_stage} size="xs" />
                      <StageTag stage={row.weekly_b_stage} size="xs" />
                      <StageTag stage={row.monthly_a_stage} size="xs" />
                      <StageTag stage={row.monthly_b_stage} size="xs" />
                    </div>
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{row.patternCount.toLocaleString()}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-bold ${tone(row.p50_30d)}`}>{fmtPct(row.p50_30d)}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.p50_60d)}`}>{fmtPct(row.p50_60d)}</td>
                  <td className={`py-3 pr-2 text-right tabular-nums font-semibold ${tone(row.p50_90d)}`}>{fmtPct(row.p50_90d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
