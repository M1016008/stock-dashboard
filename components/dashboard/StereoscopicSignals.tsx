// components/dashboard/StereoscopicSignals.tsx
// Phase 4 B6: 立体的類似シグナル (6 桁ステージコードが pattern_stats と一致、n>=20)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { getStereoscopicSignals } from '@/lib/queries/dashboard'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

export async function StereoscopicSignals() {
  const rows = await getStereoscopicSignals(6)
  return (
    <Card size="sm">
      <CardHeader
        title="立体的類似シグナル"
        hint="6 軸でパターン一致 (n≥20)"
      />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">該当銘柄なし</div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[58px_1fr_58px_92px] gap-3 px-2 pb-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span className="text-right">n</span><span className="text-right">60日中央値</span>
          </div>
          {rows.map(r => {
            const tone = r.p50_60d == null ? '' : r.p50_60d > 0 ? 'text-[var(--color-price-up)]' : r.p50_60d < 0 ? 'text-[var(--color-price-down)]' : ''
            return (
              <Link
                key={r.ticker}
                href={`/stock/${r.ticker}`}
                className="grid grid-cols-[58px_1fr_58px_92px] gap-3 rounded-[8px] px-2 py-2.5 text-[14px] font-medium hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name ?? r.ticker}</span>
                <span className="tabular-nums text-right text-[var(--color-text-tertiary)]">{r.patternCount.toLocaleString()}</span>
                <span className={`tabular-nums text-right ${tone}`}>{fmtPct(r.p50_60d)}</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
