// components/ai/PatternHero.tsx
// Phase 4 D3: 大きなヒーローブロック (6 桁コード + 6 ステージタグ + 過去出現数)

import { StageTag } from '@/components/ui/StageTag'
import type { PatternMeta } from '@/lib/queries/transitions'

const AXIS_LABEL = ['日A', '日B', '週A', '週B', '月A', '月B']

export function PatternHero({ meta }: { meta: PatternMeta | null }) {
  if (!meta) {
    return (
      <div className="rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-5 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
        指定されたパターンの統計データなし
      </div>
    )
  }
  const stages = meta.pattern_code.split('').map(c => parseInt(c, 10))
  return (
    <div className="rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-5 py-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="text-[11px] text-[var(--color-text-tertiary)]">選択中パターン</div>
          <div className="mt-1 font-mono text-[26px] tabular-nums tracking-[0.08em]">
            {meta.pattern_code}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {stages.map((s, i) => (
              <div key={i} className="flex flex-col items-center gap-0.5">
                <StageTag stage={s} size="md" />
                <span className="text-[9px] text-[var(--color-text-tertiary)]">{AXIS_LABEL[i]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-[200px] text-right">
          <div className="text-[11px] text-[var(--color-text-tertiary)]">過去出現 (60日 horizon)</div>
          <div className="mt-1 tabular-nums text-[22px] font-medium">{meta.count_60d.toLocaleString()}</div>
          {meta.lastDate && (
            <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] tabular-nums">直近: {meta.lastDate}</div>
          )}
        </div>
      </div>
    </div>
  )
}
