// components/hex/SixStageCircle.tsx
// Phase 4 C3: 6 個の色付きカード横並び (件数 + 先週比)

import { getStageCircle, type Timescale } from '@/lib/queries/hex'
import { STAGE_LABELS } from '@/lib/hex-stage'

export async function SixStageCircle({ timescale }: { timescale: Timescale }) {
  const rows = await getStageCircle(timescale)
  const total = rows.reduce((a, r) => a + r.count, 0)
  if (total === 0) {
    return (
      <div className="rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-4 text-center text-[12px] text-[var(--color-text-tertiary)]">
        ステージ分布データなし
      </div>
    )
  }
  return (
    <div className="grid grid-cols-6 gap-2">
      {rows.map(r => {
        const pct = total > 0 ? (r.count / total) * 100 : 0
        const diffSign = r.diff > 0 ? '+' : r.diff < 0 ? '' : '±'
        return (
          <div
            key={r.stage}
            className="rounded-[10px] px-3 py-2.5"
            style={{
              backgroundColor: `var(--color-stage-${r.stage}-bg)`,
              color: `var(--color-stage-${r.stage}-text)`,
            }}
          >
            <div className="text-[11px] opacity-80">Stage {r.stage}</div>
            <div className="text-[13px] font-medium">{STAGE_LABELS[r.stage]}</div>
            <div className="mt-1 tabular-nums text-[22px] font-medium leading-none">{r.count.toLocaleString()}</div>
            <div className="mt-1 tabular-nums text-[10px] opacity-80">
              {pct.toFixed(1)}% · 先週比 {diffSign}{r.diff.toLocaleString()}
            </div>
          </div>
        )
      })}
    </div>
  )
}
