'use client'

import { useState } from 'react'
import { BarChart3, ChevronDown } from 'lucide-react'
import { CandlestickChart, type TvInterval } from '@/components/charts/CandlestickChart'

type Props = {
  ticker: string
  name: string | null
  announceDate: string
  /** テーブル行として描画する場合の列数。省略時はブロック要素として描画する (スマホのカード一覧用) */
  colSpan?: number
}

const TABS: Array<{ interval: TvInterval; label: string; hint: string }> = [
  { interval: 'D', label: '日足', hint: '短期の決算反応' },
  { interval: 'W', label: '週足', hint: '中期トレンド' },
  { interval: 'M', label: '月足', hint: '長期位置' },
]

export function EarningsStockChartDisclosure({ ticker, name, announceDate, colSpan }: Props) {
  const [open, setOpen] = useState(false)
  const [interval, setInterval] = useState<TvInterval>('W')
  const activeTab = TABS.find((tab) => tab.interval === interval) ?? TABS[1]

  const body = (
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-9 w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] font-semibold text-[var(--color-text-secondary)] hover:bg-white"
            aria-expanded={open}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <BarChart3 size={15} className="shrink-0 text-[var(--color-brand-700)]" />
              <span className="truncate">
                {ticker} {name ?? ''} の日足・週足・月足チャート
              </span>
              <span className="hidden shrink-0 rounded-[3px] bg-white px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)] sm:inline-flex">
                決算日 {announceDate}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-brand-800)]">
              {open ? '閉じる' : 'チャートを表示'}
              <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </span>
          </button>

          {open && (
            <div className="border-t border-[var(--color-border-soft)] bg-white p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-bold text-[var(--color-text-primary)]">
                    {activeTab.label}チャート
                  </div>
                  <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                    {activeTab.hint}を確認します。MAは必要に応じて切り替えできます。
                  </div>
                </div>
                <div className="view-tabs" role="group" aria-label="時間足">
                  {TABS.map((tab) => (
                    <button
                      key={tab.interval}
                      type="button"
                      onClick={() => setInterval(tab.interval)}
                      aria-pressed={interval === tab.interval}
                      data-active={interval === tab.interval}
                      className="view-tab"
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
              <CandlestickChart
                ticker={ticker}
                interval={interval}
                height={300}
                maLines={[5, 25, 75, 200]}
              />
            </div>
          )}
        </div>
  )

  if (colSpan == null) return body
  return (
    <tr className="bg-white">
      <td colSpan={colSpan} className="px-2 pb-3">
        {body}
      </td>
    </tr>
  )
}
