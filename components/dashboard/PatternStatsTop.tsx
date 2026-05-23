// components/dashboard/PatternStatsTop.tsx
// N>=40の6軸パターン統計。短期営業日後中央値を並べる。

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

const HORIZON_COLUMNS: Array<{ label: string; key: 'p50_2d' | 'p50_3d' | 'p50_4d' | 'p50_5d' | 'p50_10d' | 'p50_15d' | 'p50_5d' }> = [
  { label: '2日', key: 'p50_2d' },
  { label: '3日', key: 'p50_3d' },
  { label: '4日', key: 'p50_4d' },
  { label: '5日', key: 'p50_5d' },
  { label: '1週', key: 'p50_5d' },
  { label: '2週', key: 'p50_10d' },
  { label: '3週', key: 'p50_15d' },
]

export async function PatternStatsTop() {
  const rows = await getCachedPatternStatsTopBottom()
  return (
    <Card>
      <CardHeader
        title="パターン統計"
        action={<Link href="/ai/transitions" className="hover:text-[var(--color-text-secondary)]">一覧へ ↗</Link>}
        hint="短期営業日後中央値、N≧40"
      />
      <div className="mb-4 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
        <p>
          パターン統計は、6桁のステージ構成ごとに過去の値動きを集計したものです。
          Nは過去にその構成が出た件数で、N≧40はサンプルが40件以上あるパターンだけを表示する条件です。
          2日・3日・4日・5日・1週・2週・3週は、その構成が出た後の各営業日数における騰落率の中央値です。
          上位パターンは過去統計上で上昇しやすかった形、下位パターンは下落しやすかった形です。
          現在の銘柄がどちらの構成に近いかを見ることで、監視候補や回避候補の優先順位づけに使えます。
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">データなし</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(['top', 'bottom'] as const).map((kind) => {
            const group = rows.filter((row) => row.kind === kind)
            return (
              <div key={kind} className="rounded-[8px] border border-[var(--color-border-soft)]">
                <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
                  {kind === 'top' ? '上位パターン' : '下位パターン'}
                </div>
                <div className="overflow-x-auto">
                  <div className="min-w-[640px] divide-y divide-[var(--color-border-soft)]">
                    <div className="grid grid-cols-[116px_56px_repeat(7,58px)] gap-2 px-3 py-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                      <span>Pattern</span>
                      <span className="text-right">N</span>
                      {HORIZON_COLUMNS.map((column) => (
                        <span key={column.label} className="text-right">{column.label}</span>
                      ))}
                    </div>
                    {group.map((row) => (
                      <Link
                        key={row.pattern_code + row.kind}
                        href={`/ai/transitions?code=${row.pattern_code}`}
                        className="grid grid-cols-[116px_56px_repeat(7,58px)] items-center gap-2 px-3 py-2.5 text-[13px] font-semibold hover:bg-[var(--color-surface-subtle)]"
                      >
                        <PatternCode code={row.pattern_code} />
                        <span className="text-right tabular-nums text-[var(--color-text-secondary)]">{row.count.toLocaleString()}</span>
                        {HORIZON_COLUMNS.map((column) => {
                          const value = row[column.key]
                          return (
                            <span key={column.label} className={`text-right tabular-nums ${tone(value)}`}>
                              {fmtPct(value)}
                            </span>
                          )
                        })}
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
