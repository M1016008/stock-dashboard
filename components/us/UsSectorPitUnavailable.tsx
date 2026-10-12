// components/us/UsSectorPitUnavailable.tsx
//
// 過去日が指定されたときの /us/sectors。SEC SIC は現在の登録値しかないため、
// 現在の分類を当時の銘柄へ当てはめた集計は出さず (fail-closed)、理由と代わりの導線だけを示す。

import Link from 'next/link'
import { ChevronRight, ShieldAlert } from 'lucide-react'

export function UsSectorPitUnavailable({
  requestedDate,
  resolvedDate,
  latestDate,
}: {
  requestedDate: string | null
  resolvedDate: string
  latestDate: string | null
}) {
  const dates = [
    { label: '指定日', value: requestedDate ?? '—' },
    { label: '該当する米国市場日', value: resolvedDate },
    { label: '分類を使える最新データ日', value: latestDate ?? '—' },
  ]
  return (
    <section
      role="note"
      aria-labelledby="us-sector-pit-title"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-amber)] bg-white"
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        <h2 id="us-sector-pit-title" className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-brand-900)]">
          <ShieldAlert size={16} aria-hidden className="text-[#b45309]" />
          {resolvedDate} のセクター・SIC industry 集計は表示しません
        </h2>
        <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          このページの分類は <strong className="font-semibold text-[var(--color-text-primary)]">SEC SIC current classification</strong>（SEC EDGAR に登録された現在の SIC）で、過去時点の分類（historical PIT）を持っていません。
          現在の分類を過去日の銘柄に当てはめると、その後の SIC 変更・上場・上場廃止が混ざり、当時のセクター強弱として誤読されるため、集計そのものを行いません。
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2.5 sm:grid-cols-3">
        {dates.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</dt>
            <dd className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{item.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-[var(--color-border-soft)] px-4 py-2.5">
        <Link href="/us/sectors" prefetch={false} className="btn" data-variant="primary" data-size="sm">
          最新日のセクターを見る
          <ChevronRight size={13} aria-hidden />
        </Link>
        <Link href={`/us/market-momentum?date=${encodeURIComponent(resolvedDate)}`} prefetch={false} className="btn" data-size="sm">
          {resolvedDate} の市場モメンタム（分類なし）
        </Link>
      </div>
    </section>
  )
}
