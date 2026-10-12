// components/us/UsSectorMap.tsx
//
// SEC broad sector の market map。選択中の指標で並べ、色は指標の方向と強さ (比率は 50% 基準)。
// タイルを選ぶと、同じページの SIC industry ランキングをそのセクターに絞る。

import Link from 'next/link'
import { MeterBar } from '@/components/dashboard/DashboardPrimitives'
import type { UsMarketGroup } from '@/lib/server/us-market-intelligence'
import {
  UNKNOWN_SECTOR_CODE,
  fmtCount,
  fmtPct,
  fmtRatio,
  fmtScore,
  secSectorShort,
  signedClass,
} from '@/components/us/UsMarketMomentumParts'
import {
  US_SECTOR_METRICS,
  US_SECTOR_SMALL_SAMPLE,
  fmtMetric,
  metricTint,
  usSectorsHref,
  type UsSectorMetric,
} from '@/components/us/UsSectorShared'

export function UsSectorMap({
  groups,
  metric,
  selected,
}: {
  groups: UsMarketGroup[]
  metric: UsSectorMetric
  selected: string | null
}) {
  const meta = US_SECTOR_METRICS[metric]
  return (
    <ol className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {groups.map((group, index) => {
        const value = meta.value(group)
        const tint = metricTint(metric, value)
        const small = group.count < US_SECTOR_SMALL_SAMPLE
        const unknown = group.key === UNKNOWN_SECTOR_CODE
        const isSelected = selected === group.key
        return (
          <li key={group.key} className="min-w-0">
            <Link
              href={usSectorsHref({ metric, sector: isSelected ? null : group.key }, '#us-industries')}
              prefetch={false}
              aria-current={isSelected ? 'true' : undefined}
              title={`${group.label}${isSelected ? '（選択を解除）' : ' の SIC industry を見る'}`}
              className={`relative flex h-full min-h-[132px] min-w-0 flex-col overflow-hidden rounded-[6px] border py-2 pl-3 pr-2.5 no-underline transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[0_2px_8px_rgba(16,32,52,0.10)] ${
                isSelected ? 'ring-2 ring-[var(--color-brand-700)] ring-offset-1' : ''
              } ${unknown ? 'border-dashed' : ''}`}
              style={{ backgroundColor: tint.bg, borderColor: tint.border }}
            >
              <span aria-hidden className="absolute left-0 top-0 h-full w-1" style={{ backgroundColor: tint.accent }} />
              <div className="flex min-w-0 items-start justify-between gap-1.5">
                <span className="line-clamp-2 text-[12px] font-bold leading-snug text-[var(--color-text-primary)]">
                  <span className="mr-1 font-mono text-[10px] font-semibold text-[var(--color-text-tertiary)]">{index + 1}</span>
                  {secSectorShort(group.key, group.label)}
                </span>
                <span className="shrink-0 font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{fmtCount(group.count)}</span>
              </div>
              {(small || unknown) && (
                <span className="mt-0.5 text-[9px] font-bold text-[#b45309]">
                  {unknown ? 'SEC 登録に SIC なし' : `少数サンプル（n<${US_SECTOR_SMALL_SAMPLE}）`}
                </span>
              )}
              <div className="mt-auto pt-1.5">
                <div className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">{meta.label}</div>
                <div className="font-mono text-[18px] font-bold leading-tight tabular-nums" style={{ color: tint.text }}>
                  {fmtMetric(metric, value)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] tabular-nums">
                  <span className={signedClass(group.avgChangePct)}>1D {fmtPct(group.avgChangePct)}</span>
                  <span className={signedClass(group.avgPms)}>PMS {fmtScore(group.avgPms)}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
                  <span className="shrink-0">PMS+ {fmtRatio(group.positivePmsPct)}</span>
                  <MeterBar value={group.positivePmsPct} tone={(group.positivePmsPct ?? 0) >= 50 ? 'up' : 'down'} midTick className="flex-1" />
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}
