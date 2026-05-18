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
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">
          データ未取り込み — `npm run batch:credit-short` で取得してください
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[44px_1fr_72px_72px_56px] gap-2 px-1 pb-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span className="text-right">信用買残</span><span className="text-right">前週比</span><span className="text-right">空売比率</span>
          </div>
          {rows.map(r => {
            const longChangeTone = r.longChange == null ? '' : r.longChange > 0 ? 'text-[var(--color-price-up)]' : r.longChange < 0 ? 'text-[var(--color-price-down)]' : ''
            const shortHigh = (r.shortRatio ?? 0) > 20
            return (
              <div key={r.ticker} className="grid grid-cols-[44px_1fr_72px_72px_56px] gap-2 px-1 py-1.5 text-[12px]">
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name ?? r.ticker}</span>
                <span className="tabular-nums text-right">{fmtM(r.longMargin)}</span>
                <span className={`tabular-nums text-right ${longChangeTone}`}>{fmtM(r.longChange)}</span>
                <span className={`tabular-nums text-right ${shortHigh ? 'text-[var(--color-price-up)] font-medium' : ''}`}>{fmtPct(r.shortRatio)}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
