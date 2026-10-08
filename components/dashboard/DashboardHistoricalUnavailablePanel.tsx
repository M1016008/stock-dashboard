// components/dashboard/DashboardHistoricalUnavailablePanel.tsx
//
// 過去日表示では当時の内容を再現できない項目を、1 枚の小さなパネルにまとめて説明する。
// 空のカードを並べず、「なぜ出ていないか」だけを伝える。

const ITEMS = [
  { label: '市場判断とシナリオ', reason: '現在の相場状況をもとにした内容です' },
  { label: '決算注意', reason: '最新の決算予定をもとにした内容です' },
  { label: '材料', reason: '最新のニュースをもとにした内容です' },
  { label: '次の分析', reason: '現在の候補をもとにした内容です' },
] as const

export function DashboardHistoricalUnavailablePanel() {
  return (
    <section
      aria-labelledby="historical-unavailable-heading"
      className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 id="historical-unavailable-heading" className="text-[12px] font-black text-[var(--color-brand-900)]">
          過去日では表示しない項目
        </h2>
        <p className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          当時の内容を再現できないため非表示です。最新へ戻ると確認できます。
        </p>
      </div>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ITEMS.map((item) => (
          <li key={item.label} className="rounded-[6px] border border-[var(--color-border-soft)] bg-white px-3 py-2">
            <div className="text-[12px] font-bold text-[var(--color-text-primary)]">{item.label}</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{item.reason}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
