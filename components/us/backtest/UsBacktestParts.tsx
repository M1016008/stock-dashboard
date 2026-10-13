// components/us/backtest/UsBacktestParts.tsx
//
// Explorer 内で繰り返し使う小さな表示部品。
// - Missing: null (未取得) を「—」で示し、読み上げでは「未取得」と読む。0 とは混同させない
// - 上昇/下落は色に加えて符号と「上/下」の文字で示す

import { StageTag } from '@/components/ui/StageTag'
import { fmtPct } from '@/components/us/UsMarketMomentumParts'
import { MUTED_TEXT, signedToneClass, stageAriaLabel } from '@/components/us/backtest/usBacktestShared'

export function Missing({ label = '未取得' }: { label?: string }) {
  return (
    <span className={MUTED_TEXT} title={label}>
      <span aria-hidden>—</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

export function SignedPct({ value, className = '' }: { value: number | null; className?: string }) {
  if (value == null) return <Missing />
  return <span className={`font-mono tabular-nums ${signedToneClass(value)} ${className}`}>{fmtPct(value)}</span>
}

export function StageRow({ stages }: { stages: Array<number | null> }) {
  const label = stageAriaLabel(stages)
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap" role="img" aria-label={label} title={label}>
      {stages.map((stage, index) => <StageTag key={index} stage={stage} size="xs" />)}
    </span>
  )
}

export function SignalChips({ codes, max = 2 }: { codes: string[]; max?: number }) {
  if (codes.length === 0) return <span className={`text-[11px] ${MUTED_TEXT}`}>シグナルなし</span>
  const visible = codes.slice(0, max)
  const rest = codes.length - visible.length
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={codes.join(', ')}>
      {visible.map((code) => (
        <span
          key={code}
          className="max-w-full truncate rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]"
        >
          {code}
        </span>
      ))}
      {rest > 0 && (
        <span className={`text-[10px] ${MUTED_TEXT}`}>
          +{rest}<span className="sr-only">件のシグナル ({codes.slice(max).join(', ')})</span>
        </span>
      )}
    </span>
  )
}

/** +10/+20/+40% 到達フラグ。true=✓、false=–、null=未取得 (色だけに頼らない) */
export function HitFlags({ hits }: { hits: Array<[10 | 20 | 40, boolean | null]> }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px]">
      {hits.map(([target, hit]) => {
        const state = hit == null ? '未取得' : hit ? '到達' : '未到達'
        return (
          <span
            key={target}
            title={`+${target}% ${state}`}
            className={`inline-flex h-4 items-center rounded-[3px] border px-1 font-mono tabular-nums ${
              hit
                ? 'border-[var(--color-price-up)]/40 bg-[var(--color-price-up-bg)] text-[var(--color-price-up-mid)]'
                : 'border-[var(--color-border-soft)] text-[var(--color-text-tertiary)]'
            }`}
          >
            <span aria-hidden>{hit == null ? '?' : hit ? '✓' : '–'}{target}</span>
            <span className="sr-only">+{target}% {state}</span>
          </span>
        )
      })}
    </span>
  )
}
