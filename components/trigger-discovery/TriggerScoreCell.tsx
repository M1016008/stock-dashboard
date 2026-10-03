import type { TriggerScoreBreakdown } from '@/lib/trigger-score'

interface Props {
  triggerScore: number
  scoreBreakdown: TriggerScoreBreakdown
}

export function TriggerScoreCell({ triggerScore, scoreBreakdown }: Props) {
  const detail = [
    ['近さ', scoreBreakdown.proximity, scoreBreakdown.maximums.proximity],
    ['接近', scoreBreakdown.approach, scoreBreakdown.maximums.approach],
    ['MA上向き', scoreBreakdown.maTrend, scoreBreakdown.maximums.maTrend],
    ['Stage構造', scoreBreakdown.stageStructure, scoreBreakdown.maximums.stageStructure],
    ['流動性', scoreBreakdown.liquidity, scoreBreakdown.maximums.liquidity],
  ] as const
  const ariaLabel = `Trigger Score ${Math.round(triggerScore)}点。${detail.map(([label, value, maximum]) => `${label} ${value.toFixed(1)}/${maximum}`).join('、')}`

  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={ariaLabel}
        className="inline-flex min-w-[50px] items-baseline justify-center rounded-[3px] border border-transparent bg-transparent px-1.5 py-0.5 text-center text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)] outline-none hover:border-[var(--color-border-soft)] hover:bg-[var(--color-surface-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      >
        {Math.round(triggerScore)}<span className="ml-0.5 text-[9px] font-normal text-[var(--color-text-tertiary)]">/100</span>
      </button>
      <div role="tooltip" className="pointer-events-none invisible absolute left-0 top-full z-40 mt-1 w-[250px] rounded-[4px] border border-[var(--color-border)] bg-white p-3 text-left opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="flex items-baseline justify-between border-b border-[var(--color-border-soft)] pb-2">
          <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">Trigger条件への適合度</span>
          <strong className="text-[18px] tabular-nums text-[var(--color-text-primary)]">{Math.round(triggerScore)}<span className="ml-0.5 text-[10px] font-normal text-[var(--color-text-tertiary)]">/ 100</span></strong>
        </div>
        <div className="mt-2 space-y-1.5">
          {detail.map(([label, value, maximum]) => (
            <div key={label} className="flex items-center justify-between gap-3 text-[10px]">
              <span className="text-[var(--color-text-secondary)]">{label}</span>
              <span className="tabular-nums text-[var(--color-text-primary)]">{value.toFixed(1)} / {maximum}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[9px] leading-4 text-[var(--color-text-tertiary)]">
          {Object.values(scoreBreakdown.explanations).join(' / ')}
        </p>
      </div>
    </div>
  )
}
