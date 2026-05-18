// components/ui/StageTag.tsx
// Phase 4 ステージタグ (6 色背景 + 内側テキスト)。HEX-app の STAGE_BG_COLORS に同期。
// outline 属性で「選択中」状態を強調できる。

import { cn } from '@/lib/util/cn'

interface StageTagProps {
  stage: number | null | undefined
  size?: 'xs' | 'sm' | 'md'
  selected?: boolean
  ghost?: boolean   // 値なし表示
  className?: string
}

export function StageTag({ stage, size = 'sm', selected, ghost, className }: StageTagProps) {
  const cls =
    size === 'xs' ? 'h-4 min-w-[18px] text-[9px] px-1' :
    size === 'md' ? 'h-6 min-w-[26px] text-[12px] px-1.5' :
    'h-5 min-w-[22px] text-[10px] px-1.5'
  if (stage == null || stage < 1 || stage > 6) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] text-[var(--color-text-tertiary)] tabular-nums',
          cls,
          className,
        )}
      >
        −
      </span>
    )
  }
  const bg = `var(--color-stage-${stage}-bg)`
  const text = `var(--color-stage-${stage}-text)`
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-[6px] tabular-nums',
        cls,
        ghost ? 'opacity-40' : '',
        selected ? 'outline outline-[1.5px] outline-[var(--color-brand-600)] outline-offset-[1px]' : '',
        className,
      )}
      style={{ backgroundColor: bg, color: text }}
    >
      {stage}
    </span>
  )
}
