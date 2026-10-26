'use client'

// Guided entry of the lab: Step 1 (what to investigate), Step 2 (which SMA), Step 3 (when).
// Everything beyond the beginner defaults lives under 詳細設定 / もっと選ぶ.
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, CircleHelp, PencilLine, SlidersHorizontal, Snowflake, Target, type LucideIcon } from 'lucide-react'
import type { SmaLabAnalysisMode } from '@/lib/sma-dynamics-scenario'

/** User-facing names for the three analysis modes. The internal ids (freeze / scenario / solver) are unchanged. */
export const SMA_PURPOSES: ReadonlyArray<{ id: SmaLabAnalysisMode; label: string; hint: string; Icon: LucideIcon }> = [
  { id: 'freeze', label: '株価が変わらなかったら？', hint: '終値が変わらないときのSMAの動きを見る', Icon: Snowflake },
  { id: 'scenario', label: '株価を自由に動かしてみる', hint: '将来の終値を入力してSMAを再計算する', Icon: PencilLine },
  { id: 'solver', label: 'SMAの向きを調べる', hint: '移動平均線を上向き・横ばい・下向きにするための株価を調べます', Icon: Target },
]

export const SMA_TERMS: ReadonlyArray<{ id: string; label: string; body: string }> = [
  { id: 'sma', label: 'SMAとは', body: 'SMA (単純移動平均線) は、直近N本の終値の平均です。新しい足が1本加わるたびに、いちばん古い終値が1本外れて平均が動きます。' },
  { id: 'up', label: '向きとは', body: 'SMAの向きは、その足のSMAを1本前の足のSMAと比べて決めます。大きければ上向き、まったく同じなら横ばい、小さければ下向きです。3つは対等で、どれも同じ方法で調べられます。' },
  { id: 'freeze', label: '価格固定とは', body: '今後の終値が基準日の終値のまま動かないと仮定して、SMAを計算し直すことです。将来の株価を示すものではありません。' },
  { id: 'solver', label: '逆算とは', body: '先にSMAの目標を決め、そのために必要な終値の条件を求めることです。目標は「N本後の時点」「N本以内に一度でも」「N本ずっと」の3つの範囲から選べ、同じ向きでも意味が違います。条件を満たす値動きは1通りとは限りません。' },
]

export function PurposePicker({ value, disabled, onChange }: { value: SmaLabAnalysisMode; disabled: boolean; onChange: (mode: SmaLabAnalysisMode) => void }) {
  return (
    <div role="group" aria-label="調べること" className="grid min-w-0 gap-1.5 md:grid-cols-3" data-sma-dynamics-purposes>
      {SMA_PURPOSES.map(({ id, label, hint, Icon }) => {
        const active = id === value
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            data-mode={id}
            onClick={() => onChange(id)}
            className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)] border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45 md:min-h-[56px] ${
              active
                ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-primary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            <Icon size={16} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0">
              <span className="block text-[13px] font-bold leading-tight">{label}</span>
              <span className={`mt-0.5 block text-[11px] font-medium leading-4 ${active ? 'text-white/80' : 'text-[var(--color-text-tertiary)]'}`}>{hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function GuideStep({ n, title, hint, children }: { n: number | null; title: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5" data-sma-step={n ?? 'purpose'}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {n != null && <span aria-hidden="true" className="inline-grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-brand-900)] text-[11px] font-bold text-white">{n}</span>}
        <h3 id={id} className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">{title}</h3>
        {hint && <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

/** One-line definitions on demand; only the opened term is shown. */
export function TermHelp() {
  const [open, setOpen] = useState<string | null>(null)
  const baseId = useId()
  const current = SMA_TERMS.find((term) => term.id === open)
  return (
    <div className="flex min-w-0 flex-col gap-1" data-sma-term-help>
      <div role="group" aria-label="用語の説明" className="flex min-w-0 flex-wrap items-center gap-1">
        <CircleHelp size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        {SMA_TERMS.map((term) => {
          const on = term.id === open
          return (
            <button
              key={term.id}
              type="button"
              aria-expanded={on}
              aria-controls={`${baseId}-${term.id}`}
              onClick={() => setOpen(on ? null : term.id)}
              className={`inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border px-2 text-[11px] font-bold sm:min-h-7 ${
                on ? 'border-[var(--color-border-strong)] bg-white text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-brand-700)] underline decoration-dotted underline-offset-2 hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              {term.label}
            </button>
          )
        })}
      </div>
      {current && (
        <p id={`${baseId}-${current.id}`} className="m-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]" data-sma-term-body={current.id}>
          {current.body}
        </p>
      )}
    </div>
  )
}

/** 詳細設定: every timeframe, SMA period, display range and horizon stays reachable here. */
export function AdvancedSettings({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group min-w-0 border-t border-[var(--color-border-soft)] pt-1" data-sma-dynamics-advanced>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90" />
        <SlidersHorizontal size={13} aria-hidden="true" className="shrink-0" />
        詳細設定
        <span className="min-w-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{summary}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pb-1 pt-1.5">{children}</div>
    </details>
  )
}

/** Inline "もっと選ぶ" disclosure used inside a step. */
export function MoreOptions({ label = 'もっと選ぶ', note, open, children }: { label?: string; note?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group min-w-0" data-sma-more open={open || undefined}>
      <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] sm:min-h-7 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
        {label}
        {note && <span className="font-medium text-[var(--color-text-tertiary)]">({note})</span>}
      </summary>
      <div className="flex min-w-0 flex-col gap-1.5 pb-1 pt-0.5">{children}</div>
    </details>
  )
}

/** Collapsible detail block placed after the narrative result (tables, full conditions). */
export function DetailsSection({ title, meta, children, open, ...rest }: { title: string; meta?: ReactNode; children: ReactNode; open?: boolean; [key: `data-${string}`]: unknown }) {
  return (
    <details className="group border-t border-[var(--color-border-soft)]" open={open || undefined} {...rest}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-9 sm:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90" />
        {title}
        {meta && <span className="min-w-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{meta}</span>}
      </summary>
      <div className="min-w-0 px-3 pb-3 pt-1 sm:px-4">{children}</div>
    </details>
  )
}
