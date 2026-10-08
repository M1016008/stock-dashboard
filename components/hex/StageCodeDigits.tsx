// components/hex/StageCodeDigits.tsx
// 6桁ステージコードの表示。相手側 (other) と異なる桁を枠付きで強調し、変化桁を一目で示す。

import { STAGE_BG_COLORS } from '@/lib/hex-stage'
import { STAGE_TRANSITION_ANY_CODE } from '@/lib/stage-transition-scanner'

const SIZE = {
  md: { box: 'h-6 w-5', text: 'text-[15px]' },
  sm: { box: 'h-5 w-4', text: 'text-[13px]' },
} as const

export function StageCodeDigits({
  code,
  other,
  size = 'md',
}: {
  code: string
  other: string
  size?: keyof typeof SIZE
}) {
  if (code === STAGE_TRANSITION_ANY_CODE) {
    return (
      <span className="inline-flex h-6 items-center rounded-[3px] border border-dashed border-[var(--color-brand-500)] bg-[var(--color-brand-50)] px-2 font-sans text-[11px] font-bold text-[var(--color-brand-800)]">
        Any
      </span>
    )
  }
  const { box, text } = SIZE[size]
  return (
    <span className={`inline-flex gap-0.5 font-mono tabular-nums ${text}`} aria-hidden>
      {code.split('').map((digit, index) => {
        const changed = digit !== other[index]
        return changed ? (
          <span
            key={index}
            className={`inline-flex ${box} items-center justify-center rounded-[3px] border-2 border-[var(--color-brand-700)] font-bold`}
            style={{ background: STAGE_BG_COLORS[Number(digit)] ?? undefined, color: `var(--color-stage-${digit}-text)` }}
          >
            {digit}
          </span>
        ) : (
          <span key={index} className={`inline-flex ${box} items-center justify-center text-[var(--color-text-tertiary)]`}>
            {digit}
          </span>
        )
      })}
    </span>
  )
}
