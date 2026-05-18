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
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-4 py-3 text-[12px] text-[var(--color-text-tertiary)]">
        ステージ分布データなし
      </div>
    )
  }
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] text-[var(--color-text-secondary)]">日足 A ステージ分布</span>
        <span className="tabular-nums text-[11px] text-[var(--color-text-tertiary)]">{total.toLocaleString()} 銘柄</span>
      </div>
      <div className="flex h-[22px] overflow-hidden rounded-[4px] border border-[var(--color-border-soft)]">
        {[1, 2, 3, 4, 5, 6].map(s => {
          const r = rows.find(x => x.stage === s)
          const count = r?.count ?? 0
          if (count === 0) return null
          const pct = (count / total) * 100
          return (
            <div
              key={s}
              title={`Stage ${s} ${LABELS[s]}: ${count} (${pct.toFixed(1)}%)`}
              className="flex items-center justify-center text-[10px] tabular-nums"
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
      <div className="mt-1.5 grid grid-cols-6 gap-1 text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
        {[1, 2, 3, 4, 5, 6].map(s => {
          const count = rows.find(x => x.stage === s)?.count ?? 0
          return (
            <div key={s} className="flex items-baseline gap-1">
              <span style={{ color: `var(--color-stage-${s}-text)` }}>{s}</span>
              <span>{LABELS[s]}</span>
              <span className="ml-auto">{count.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
