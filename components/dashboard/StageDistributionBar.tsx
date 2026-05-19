// components/dashboard/StageDistributionBar.tsx
// Phase 4 B4: 横長積み上げバー (高さ 22px、角丸 4px、ボーダー 0.5px)
//   日足 A の 6 ステージを比例幅で並べる + 下に小ラベル。

import { getStageDistribution } from '@/lib/queries/dashboard'

const LABELS: Record<number, string> = {
  1: '安定上昇', 2: '上昇変化①', 3: '下降変化①',
  4: '安定下降', 5: '下降変化②', 6: '上昇変化②',
}

export async function StageDistributionBar() {
  const rows = await getStageDistribution('daily_a_stage')
  const total = rows.reduce((a, r) => a + r.count, 0)
  if (total === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-white px-6 py-5 text-[13px] font-semibold text-[var(--color-text-tertiary)]">
        ステージ分布データなし
      </div>
    )
  }
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-white px-6 py-5">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-[17px] font-bold text-[var(--color-text-primary)]">日足 A ステージ分布</span>
        <span className="tabular-nums text-[13px] font-bold text-[var(--color-text-secondary)]">{total.toLocaleString()} 銘柄</span>
      </div>
      <div className="flex h-[42px] overflow-hidden rounded-[8px] border border-[var(--color-border-soft)]">
        {[1, 2, 3, 4, 5, 6].map(s => {
          const r = rows.find(x => x.stage === s)
          const count = r?.count ?? 0
          if (count === 0) return null
          const pct = (count / total) * 100
          return (
            <div
              key={s}
              title={`Stage ${s} ${LABELS[s]}: ${count} (${pct.toFixed(1)}%)`}
              className="flex items-center justify-center text-[13px] font-bold tabular-nums"
              style={{
                flexGrow: count,
                flexBasis: 0,
                backgroundColor: `var(--color-stage-${s}-bg)`,
                color: `var(--color-stage-${s}-text)`,
              }}
            >
              {pct >= 6 ? `${pct.toFixed(0)}%` : ''}
            </div>
          )
        })}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5 text-[12px] tabular-nums text-[var(--color-text-secondary)] md:grid-cols-6">
        {[1, 2, 3, 4, 5, 6].map(s => {
          const count = rows.find(x => x.stage === s)?.count ?? 0
          return (
            <div key={s} className="flex items-center gap-1.5 rounded-[8px] bg-[var(--color-surface-subtle)] px-2.5 py-2">
              <span className="font-semibold" style={{ color: `var(--color-stage-${s}-text)` }}>{s}</span>
              <span className="truncate">{LABELS[s]}</span>
              <span className="ml-auto font-medium">{count.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
