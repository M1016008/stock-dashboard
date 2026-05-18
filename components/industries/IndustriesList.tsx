// components/industries/IndustriesList.tsx
// Phase 4 F3: 業界一覧テーブル

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import type { IndustryRow } from '@/lib/queries/industries'

export function IndustriesList({ rows, source }: { rows: IndustryRow[]; source: string }) {
  return (
    <Card>
      <CardHeader title="業界一覧" hint={`${rows.length} 業界 (${source})`} />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">該当業界なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-tertiary)]">
                <th className="pb-2 pr-2 font-normal">業界名</th>
                <th className="pb-2 pr-2 font-normal">大分類</th>
                <th className="pb-2 pr-2 text-right font-normal">銘柄数</th>
                <th className="pb-2 pr-2 text-right font-normal">騰落率</th>
                <th className="pb-2 pr-2 font-normal">ステ分布</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map(r => {
                const tone = r.avg_change > 0 ? 'text-[var(--color-price-up)]' : r.avg_change < 0 ? 'text-[var(--color-price-down)]' : ''
                const params = new URLSearchParams({ selected: r.sub_industry })
                return (
                  <tr key={r.sub_industry + '_' + r.major_category} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="py-1.5 pr-2 font-medium">
                      <Link href={`/industries?${params.toString()}`} className="hover:underline">{r.sub_industry}</Link>
                    </td>
                    <td className="py-1.5 pr-2 text-[11px] text-[var(--color-text-tertiary)]">{r.major_category}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">{r.n_stocks}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${tone}`}>{(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2) + '%'}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1">
                        {r.stage1Count > 0 && <span className="inline-flex items-center gap-0.5"><StageTag stage={1} size="xs" /><span className="tabular-nums text-[10px] text-[var(--color-text-tertiary)]">{r.stage1Count}</span></span>}
                        {r.stage2Count > 0 && <span className="inline-flex items-center gap-0.5"><StageTag stage={2} size="xs" /><span className="tabular-nums text-[10px] text-[var(--color-text-tertiary)]">{r.stage2Count}</span></span>}
                        {r.stage4Count > 0 && <span className="inline-flex items-center gap-0.5"><StageTag stage={4} size="xs" /><span className="tabular-nums text-[10px] text-[var(--color-text-tertiary)]">{r.stage4Count}</span></span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
