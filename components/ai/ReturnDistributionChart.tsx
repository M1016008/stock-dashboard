// components/ai/ReturnDistributionChart.tsx
// Phase 4 D5: 9 bin ヒストグラム + 25/50/75 ライン

import { Card, CardHeader } from '@/components/ui/Card'
import type { ReturnDistribution } from '@/lib/queries/transitions'

export function ReturnDistributionChart({ dist, horizonDays }: { dist: ReturnDistribution; horizonDays: number }) {
  const max = Math.max(...dist.bins.map(b => b.count), 1)
  return (
    <Card>
      <CardHeader title="リターン分布" hint={`${horizonDays}日後 · n=${dist.total.toLocaleString()}`} />
      {dist.total === 0 ? (
        <div className="py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">サンプルなし</div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-[120px]">
            {dist.bins.map((b, i) => {
              const h = (b.count / max) * 100
              const isPos = b.lower >= 0
              const isNeg = b.upper <= 0
              const color = isPos ? 'var(--color-price-up)' : isNeg ? 'var(--color-price-down)' : 'var(--color-text-tertiary)'
              return (
                <div key={i} className="flex flex-1 flex-col items-center justify-end">
                  <div
                    className="w-full rounded-t-[2px] opacity-80"
                    style={{ height: `${Math.max(2, h)}%`, backgroundColor: color }}
                    title={`${b.lower}〜${b.upper}%: ${b.count}`}
                  />
                </div>
              )
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
            <span>-30%</span><span>-20%</span><span>-10%</span><span>0</span><span>+10%</span><span>+20%</span><span>+30%</span>
          </div>
          <div className="mt-3 flex items-baseline justify-between gap-4 text-[11px] tabular-nums">
            <span className="text-[var(--color-text-tertiary)]">
              25% <span className="ml-1 font-medium text-[var(--color-text-primary)]">{dist.p25?.toFixed(2) ?? '---'}%</span>
            </span>
            <span className="text-[var(--color-text-tertiary)]">
              中央値 <span className="ml-1 font-medium text-[var(--color-text-primary)]">{dist.p50?.toFixed(2) ?? '---'}%</span>
            </span>
            <span className="text-[var(--color-text-tertiary)]">
              75% <span className="ml-1 font-medium text-[var(--color-text-primary)]">{dist.p75?.toFixed(2) ?? '---'}%</span>
            </span>
          </div>
        </>
      )}
    </Card>
  )
}
