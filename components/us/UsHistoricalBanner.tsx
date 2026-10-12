// components/us/UsHistoricalBanner.tsx
//
// 米国株 Dashboard の過去日表示帯。日本株の DashboardHistoricalBanner と同じ並び
// (AS OF・指定日・最新データ日 → 休場日の補正 → 表示する/しない項目 → 注記) で、
// 中身だけを米国株のデータ事情に合わせる。
// - 業種分類と時価総額は当時の値がないため出さない (現在値を当時の値として見せない)
// - 銘柄名・取引所は現在の登録情報であることを明記する

import { History } from 'lucide-react'

const SHOWN = ['市場構造', '値動き', '売買候補', '物理ML候補'] as const
const HIDDEN = [
  { label: '業種分類', reason: '過去日の分類データがないため' },
  { label: '時価総額', reason: '当時の発行済株式数がないため' },
  { label: 'AIリサーチ・データ状況', reason: '現在の情報をもとにした内容' },
] as const

export function UsHistoricalBanner({
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
    { label: 'AS OF（表示している米国市場日）', value: `${resolvedDate} 終値`, strong: true },
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
          指定日 <span className="font-mono tabular-nums">{requestedDate}</span> は米国市場の取引データがないため（休場日・週末など）、直前の取引日 <span className="font-mono tabular-nums">{resolvedDate}</span> の終値で表示しています。
        </p>
      )}
      <div className="grid gap-x-8 gap-y-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2.5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">この日付で表示</div>
          <div className="mt-0.5 text-[12px] font-bold text-[var(--color-text-primary)]">{SHOWN.join(' · ')}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">表示しない（当時の値がない、または現在の情報のため。最新へ戻ると確認できます）</div>
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
        株価・6ステージ・PMS/PFS は {resolvedDate}（米国時間）の終値時点、ML候補はその日までの直近生成分です。銘柄名・取引所は現在の登録情報で、当時と異なる場合があります。
      </p>
    </section>
  )
}
