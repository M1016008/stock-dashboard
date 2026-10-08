// components/dashboard/DashboardHistoricalBanner.tsx
//
// 過去日表示中であることを、ページ上部で一目で分かるようにする帯。
// 「指定日」「表示している市場日 (AS OF)」「最新データ日」を並べ、
// この日付で表示する項目 / 表示しない項目もここで一度に示す。
// 表示判定 (どの日付を使うか) は呼び出し側の getDashboardAsOfState の結果をそのまま使う。

import { History } from 'lucide-react'

const SHOWN = ['売買候補', '市場マップ', '今日の市場'] as const
const HIDDEN = [
  { label: 'シナリオ進捗', reason: '現在の相場状況をもとにした内容' },
  { label: '決算注意', reason: '最新の決算予定をもとにした内容' },
  { label: '材料', reason: '最新のニュースをもとにした内容' },
  { label: '次の分析', reason: '現在の候補をもとにした内容' },
] as const

export function DashboardHistoricalBanner({
  requestedDate,
  resolvedDate,
  adjusted,
  latestDate = null,
}: {
  requestedDate: string
  resolvedDate: string
  adjusted: boolean
  latestDate?: string | null
}) {
  const dates = [
    { label: 'AS OF（表示している市場日）', value: `${resolvedDate} 大引け`, strong: true },
    { label: '指定日', value: requestedDate, strong: false },
    { label: '最新データ日', value: latestDate ?? '---', strong: false },
  ]
  return (
    <section
      role="note"
      aria-label="過去日表示の基準"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-amber)] bg-white"
    >
      <div className="grid gap-x-8 gap-y-3 px-4 py-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
        <div className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-brand-900)]">
          <History size={16} aria-hidden="true" className="text-[#b45309]" />
          過去日を表示中
        </div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-3">
          {dates.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</dt>
              <dd className={`font-mono tabular-nums ${item.strong ? 'text-[16px] font-bold text-[var(--color-text-primary)]' : 'text-[13px] font-semibold text-[var(--color-text-secondary)]'}`}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {adjusted && (
        <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[12px] font-semibold text-[#92400e]">
          指定日 <span className="font-mono tabular-nums">{requestedDate}</span> は取引データがないため、直前の営業日 <span className="font-mono tabular-nums">{resolvedDate}</span> を表示しています。
        </p>
      )}
      <div className="grid gap-x-8 gap-y-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2.5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">この日付で表示</div>
          <div className="mt-0.5 text-[12px] font-bold text-[var(--color-text-primary)]">{SHOWN.join(' · ')}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">表示しない（当時の内容を再現できないため。最新へ戻ると確認できます）</div>
          <ul className="mt-0.5 flex flex-wrap gap-x-5 gap-y-0.5">
            {HIDDEN.map((item) => (
              <li key={item.label} className="text-[12px] font-semibold text-[var(--color-text-secondary)]">
                <span className="font-bold">{item.label}</span>
                <span className="ml-1.5 text-[10px] text-[var(--color-text-tertiary)]">{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
        株価・指標・シグナルの数値は {resolvedDate} 時点の値です。市場区分・業種などの分類は現在のマスタに基づくため、当時の区分と異なる場合があります。
      </p>
    </section>
  )
}
