// components/dashboard/CreditShortPanel.tsx
// 信用残・空売りをセクター圧力と個別銘柄の両面から見る。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedCreditShortDashboard } from '@/lib/queries/dashboard-cache'

function fmtM(v: number | null | undefined) {
  if (v == null) return '---'
  return (v / 1_000_000).toFixed(1) + 'M'
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '---'
  return v.toFixed(1) + '%'
}

function fmtPrice(v: number | null | undefined) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function tone(v: number | null | undefined) {
  if (v == null) return ''
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : ''
}

export async function CreditShortPanel() {
  const data = await getCachedCreditShortDashboard()
  return (
    <Card>
      <CardHeader title="信用・空売り注目" hint={data.asOf ? `週次 ${data.asOf} 基準` : '週次更新'} />
      {data.stockRows.length === 0 && data.sectorRows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">
          データ未取り込み — `npm run batch:credit-short` で取得してください
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.35fr]">
          <div className="rounded-[8px] border border-[var(--color-border-soft)]">
            <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
              業種別ポジション圧力
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {data.sectorRows.map((row) => (
                <div key={row.sectorName} className="px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-bold">{row.sectorName}</div>
                      <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.tickerCount} 銘柄</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px] font-bold tabular-nums">{fmtPct(row.shortRatio)}</div>
                      <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">売残比率</div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                    <div className="rounded-[6px] bg-[var(--color-surface-subtle)] px-2 py-1.5">買残 {fmtM(row.longMargin)}</div>
                    <div className="rounded-[6px] bg-[var(--color-surface-subtle)] px-2 py-1.5">売残 {fmtM(row.shortMargin)}</div>
                    <div className={`rounded-[6px] bg-[var(--color-surface-subtle)] px-2 py-1.5 ${tone(row.longChange)}`}>買増減 {fmtM(row.longChange)}</div>
                    <div className={`rounded-[6px] bg-[var(--color-surface-subtle)] px-2 py-1.5 ${tone(row.shortChange)}`}>売増減 {fmtM(row.shortChange)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)]">
            <table className="w-full min-w-[850px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
                  <th className="px-3 py-2">銘柄</th>
                  <th className="px-3 py-2">業種</th>
                  <th className="px-3 py-2 text-right">株価</th>
                  <th className="px-3 py-2 text-right">買残</th>
                  <th className="px-3 py-2 text-right">売残</th>
                  <th className="px-3 py-2 text-right">売残比率</th>
                  <th className="px-3 py-2">Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {data.stockRows.map((row) => (
                  <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="px-3 py-2.5">
                      <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums hover:underline">{row.ticker}</Link>
                      <div className="mt-1 max-w-[180px] truncate text-[12px] font-semibold">{row.name ?? row.ticker}</div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">{row.sectorName ?? 'その他'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <div className="font-semibold">{fmtPrice(row.price)}</div>
                      <div className={`mt-1 text-[11px] ${tone(row.changePct)}`}>{row.changePct == null ? '---' : (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%'}</div>
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${tone(row.longChange)}`}>{fmtM(row.longMargin)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${tone(row.shortChange)}`}>{fmtM(row.shortMargin)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtPct(row.shortRatio)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <StageTag stage={row.daily_a_stage} size="xs" />
                        <StageTag stage={row.daily_b_stage} size="xs" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  )
}
