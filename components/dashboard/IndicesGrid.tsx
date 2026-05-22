// components/dashboard/IndicesGrid.tsx
// Phase 4 B3: 6 列の指数カード行。indices_daily 由来 (TOPIX/グロース250/プライム/スタンダード)
// + 騰落レシオ (自前計算) + 日経225 (J-Quants 指数四本値 API では未提供)

import { getCachedDashboardIndices } from '@/lib/queries/dashboard-cache'

function fmt(v: number | null, label: string): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const decimals = label === '騰落レシオ' ? 1 : 2
  return v.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export async function IndicesGrid() {
  const indices = await getCachedDashboardIndices()
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
      {indices.map(idx => {
        const hasValue = idx.value != null
        const tone =
          idx.changePct == null ? '' :
          idx.changePct > 0 ? 'sb-r' :
          idx.changePct < 0 ? 'sb-b' :
          'sb-t'
        return (
          <div
            key={idx.code}
            className="group rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-white px-4 py-3.5 shadow-none transition-colors hover:border-[var(--color-border-default)]"
          >
            <div className="text-[11px] font-bold text-[var(--color-text-secondary)]">{idx.label}</div>
            <div
              className="mt-2 text-[23px] font-bold leading-none tabular-nums sm:text-[26px] 2xl:text-[24px]"
            >
              {hasValue ? fmt(idx.value, idx.label) : '---'}
            </div>
            <div className={`mt-2 text-[11px] font-bold tabular-nums ${tone || 'text-[var(--color-text-tertiary)]'}`}>
              {idx.changePct == null
                ? <span className="sb-t">{idx.note ?? 'データ未接続'}</span>
                : (idx.changePct > 0 ? '+' : '') + idx.changePct.toFixed(2) + '%'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
