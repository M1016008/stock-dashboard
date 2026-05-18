// components/dashboard/PatternStatsTop.tsx
// Phase 4 B11: パターン統計上位/下位 (上位 3 + 下位 2)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { getPatternStatsTopBottom } from '@/lib/queries/dashboard'

export async function PatternStatsTop() {
  const rows = await getPatternStatsTopBottom()
  return (
    <Card>
      <CardHeader
        title="パターン統計"
        action={<Link href="/ai/transitions" className="hover:text-[var(--color-text-secondary)]">一覧へ ↗</Link>}
        hint="60日中央値 (n≥20)"
      />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">データなし</div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[1fr_56px_80px] gap-2 px-1 pb-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>パターン</span><span className="text-right">n</span><span className="text-right">60日中央値</span>
          </div>
          {rows.map(r => {
            const tone = r.p50 > 0 ? 'text-[var(--color-price-up)]' : r.p50 < 0 ? 'text-[var(--color-price-down)]' : ''
            return (
              <Link
                key={r.pattern_code + r.kind}
                href={`/ai/transitions?code=${r.pattern_code}`}
                className="grid grid-cols-[1fr_56px_80px] items-center gap-2 px-1 py-1.5 text-[12px] hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="tabular-nums tracking-[0.05em]" style={{ fontWeight: 500 }}>{r.pattern_code}</span>
                <span className="tabular-nums text-right text-[var(--color-text-secondary)]">{r.count.toLocaleString()}</span>
                <span className={`tabular-nums text-right ${tone}`}>{(r.p50 >= 0 ? '+' : '') + r.p50.toFixed(2) + '%'}</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
