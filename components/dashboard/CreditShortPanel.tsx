// components/dashboard/CreditShortPanel.tsx
// Phase 4 B10: 信用残・空売り注目

import { Card, CardHeader } from '@/components/ui/Card'
import { getCreditShortHighlights } from '@/lib/queries/dashboard'

function fmtM(v: number | null) {
  if (v == null) return '---'
  return (v / 1_000_000).toFixed(1) + 'M'
}
function fmtPct(v: number | null) {
  if (v == null) return '---'
  return v.toFixed(1) + '%'
}

export async function CreditShortPanel() {
  const rows = await getCreditShortHighlights(4)
  return (
    <Card>
      <CardHeader title="信用残・空売り注目" hint="週次更新" />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">
          データ未取り込み — `npm run batch:credit-short` で取得してください
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[58px_1fr_82px_82px_82px] gap-3 px-2 pb-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span className="text-right">買残</span><span className="text-right">売残</span><span className="text-right">売残比率</span>
          </div>
          {rows.map(r => {
            const shortChangeTone = r.shortChange == null ? '' : r.shortChange > 0 ? 'text-[var(--color-price-up)]' : r.shortChange < 0 ? 'text-[var(--color-price-down)]' : ''
            const shortRatio = r.shortRatio ?? (
              r.longMargin != null && r.shortMargin != null && r.longMargin + r.shortMargin > 0
                ? (r.shortMargin / (r.longMargin + r.shortMargin)) * 100
                : null
            )
            const shortHigh = (shortRatio ?? 0) > 20
            return (
              <div key={r.ticker} className="grid grid-cols-[58px_1fr_82px_82px_82px] gap-3 rounded-[8px] px-2 py-2.5 text-[14px] font-medium hover:bg-[var(--color-surface-subtle)]">
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name ?? r.ticker}</span>
                <span className="tabular-nums text-right">{fmtM(r.longMargin)}</span>
                <span className={`tabular-nums text-right ${shortChangeTone}`}>{fmtM(r.shortMargin)}</span>
                <span className={`tabular-nums text-right ${shortHigh ? 'text-[var(--color-price-up)] font-medium' : ''}`}>{fmtPct(shortRatio)}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
