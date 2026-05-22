// components/dashboard/PatternStatsTop.tsx
// N>=40の6軸パターン統計。10/20/30営業日後中央値を並べる。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedPatternStatsTopBottom } from '@/lib/queries/dashboard-cache'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function tone(v: number | null) {
  if (v == null) return 'text-[var(--color-text-tertiary)]'
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'
}

function PatternCode({ code }: { code: string }) {
  const stages = code.split('').map(Number)
  return (
    <div className="flex items-center gap-1">
      {stages.map((stage, i) => <StageTag key={`${code}-${i}`} stage={stage} size="xs" />)}
    </div>
  )
}

export async function PatternStatsTop() {
  const rows = await getCachedPatternStatsTopBottom()
  return (
    <Card>
      <CardHeader
        title="パターン統計"
        action={<Link href="/ai/transitions" className="hover:text-[var(--color-text-secondary)]">一覧へ ↗</Link>}
        hint="10 / 20 / 30営業日後中央値、N≧40"
      />
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">データなし</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {(['top', 'bottom'] as const).map((kind) => {
            const group = rows.filter((row) => row.kind === kind)
            return (
              <div key={kind} className="rounded-[8px] border border-[var(--color-border-soft)]">
                <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
                  {kind === 'top' ? '上位パターン' : '下位パターン'}
                </div>
                <div className="overflow-x-auto">
                  <div className="min-w-[446px] divide-y divide-[var(--color-border-soft)]">
                  <div className="grid grid-cols-[116px_64px_70px_70px_70px] gap-2 px-3 py-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                    <span>Pattern</span><span className="text-right">N</span><span className="text-right">10日</span><span className="text-right">20日</span><span className="text-right">30日</span>
                  </div>
                  {group.map((row) => (
                    <Link
                      key={row.pattern_code + row.kind}
                      href={`/ai/transitions?code=${row.pattern_code}`}
                      className="grid grid-cols-[116px_64px_70px_70px_70px] items-center gap-2 px-3 py-2.5 text-[13px] font-semibold hover:bg-[var(--color-surface-subtle)]"
                    >
                      <PatternCode code={row.pattern_code} />
                      <span className="text-right tabular-nums text-[var(--color-text-secondary)]">{row.count.toLocaleString()}</span>
                      <span className={`text-right tabular-nums ${tone(row.p50_10d)}`}>{fmtPct(row.p50_10d)}</span>
                      <span className={`text-right tabular-nums ${tone(row.p50_20d)}`}>{fmtPct(row.p50_20d)}</span>
                      <span className={`text-right tabular-nums ${tone(row.p50_30d)}`}>{fmtPct(row.p50_30d)}</span>
                    </Link>
                  ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
