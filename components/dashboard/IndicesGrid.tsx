// components/dashboard/IndicesGrid.tsx
// Phase 4 B3: 6 列の指数カード行。データソース未接続のものは「---」表示。

import { getDashboardIndices } from '@/lib/queries/dashboard'

function fmt(v: number | null, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export async function IndicesGrid() {
  const indices = await getDashboardIndices()
  return (
    <div className="grid grid-cols-6 gap-2">
      {indices.map(idx => {
        const hasValue = idx.value != null
        const upDown =
          idx.changePct == null ? '' :
          idx.changePct > 0 ? 'text-[var(--color-price-up)]' :
          idx.changePct < 0 ? 'text-[var(--color-price-down)]' :
          'text-[var(--color-text-tertiary)]'
        return (
          <div
            key={idx.ticker}
            className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-3 py-2.5"
          >
            <div className="text-[11px] text-[var(--color-text-tertiary)]">{idx.label}</div>
            <div className="mt-0.5 tabular-nums text-[17px] font-medium leading-tight">
              {hasValue ? fmt(idx.value, idx.label === '騰落レシオ' ? 1 : 2) : '---'}
            </div>
            <div className={`tabular-nums text-[10px] ${upDown}`}>
              {idx.changePct == null ? <span className="text-[var(--color-text-tertiary)]">データ未接続</span> :
               (idx.changePct > 0 ? '+' : '') + idx.changePct.toFixed(2) + '%'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
