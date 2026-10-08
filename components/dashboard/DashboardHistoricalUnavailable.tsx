// components/dashboard/DashboardHistoricalUnavailable.tsx
//
// 指定日を表示できないとき (範囲外・形式不正・データ未取り込み) の状態。
// 最新データを代わりに出すことはせず、表示できる期間だけを示す。

import { CalendarX2 } from 'lucide-react'
import type { DashboardAsOfState } from '@/lib/queries/dashboard-as-of'

function describe(state: DashboardAsOfState): { title: string; body: string } {
  const requested = (state.requestedDate ?? '').slice(0, 32)
  switch (state.availability) {
    case 'before_coverage':
      return {
        title: `${requested} のデータはありません`,
        body: '指定した日付は、表示できる期間より前です。最新のデータは代わりに表示していません。',
      }
    case 'invalid':
      return {
        title: '日付として読み取れませんでした',
        body: `「${requested}」は有効な日付ではありません。YYYY-MM-DD の形式で指定してください。`,
      }
    default:
      return {
        title: '表示できるデータがありません',
        body: 'データが取り込まれると、ここに表示されます。',
      }
  }
}

export function DashboardHistoricalUnavailable({ state }: { state: DashboardAsOfState }) {
  const { title, body } = describe(state)
  const hasCoverage = state.earliestDate !== null && state.latestDate !== null

  return (
    <section
      role="alert"
      className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-[8px] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-red)] bg-white p-4 shadow-[var(--shadow-card)]"
    >
      <div className="flex min-w-[240px] flex-1 items-start gap-3">
        <CalendarX2 size={22} className="mt-0.5 shrink-0 text-[var(--color-market-red-dark)]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="break-words text-[15px] font-bold text-[var(--color-brand-900)]">{title}</h2>
          <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{body}</p>
        </div>
      </div>
      {hasCoverage && (
        <dl className="grid grid-cols-2 gap-2">
          {[
            { label: '表示できる最初の日', value: state.earliestDate },
            { label: '表示できる最新の日', value: state.latestDate },
          ].map((item) => (
            <div key={item.label} className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
              <dt className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{item.label}</dt>
              <dd className="mt-0.5 text-[14px] font-bold tabular-nums text-[var(--color-text-primary)]">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
