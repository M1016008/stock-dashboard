'use client'

// Inverse solver inputs (Phase 2.2): current direction, timing, the three equal direction
// choices, and the labelled advanced goal kinds. Pure presentation over SolverDraft.
import { SMA_LAB_SOLVER_MAX_BARS, type SmaLabFutureBar } from '@/lib/sma-dynamics-lab'
import type { SmaDirection, SolverDraft, SolverGoalKind } from '@/lib/sma-dynamics-scenario'
import {
  DIRECTION_ARROW,
  GOAL_KIND_CHOICES,
  REVERSAL_DEFINITION,
  SMA_DIRECTIONS,
  SOLVER_QUICK_TIMINGS,
  SOLVER_SCOPES,
  SOLVER_SCOPE_CHOICES,
  scopeHelp,
  describeTiming,
  directionWord,
  isSolverScope,
  scopeLabel,
  timingDate,
  unitLabel,
  type CurrentDirectionState,
} from '@/lib/sma-dynamics-solver-copy'
import type { SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import { MoreOptions } from './SmaGuidedControls'

const TONE: Record<SmaDirection, { on: string; mark: string }> = {
  up: { on: 'border-red-600 bg-red-50 text-red-900', mark: 'text-red-700' },
  flat: { on: 'border-slate-600 bg-slate-100 text-slate-900', mark: 'text-slate-700' },
  down: { on: 'border-blue-600 bg-blue-50 text-blue-900', mark: 'text-blue-700' },
}

/** Where the selected SMA points now: arrow + words, or an explicit "cannot tell". */
export function CurrentDirectionCard({ state }: { state: CurrentDirectionState }) {
  const known = state.state !== 'unavailable'
  return (
    <div
      className="flex min-w-0 items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2"
      data-sma-current-direction={state.state}
      role="group"
      aria-label="現在のSMAの向き"
    >
      <span aria-hidden="true" className={`mt-px grid size-6 shrink-0 place-items-center rounded-full border border-current bg-white text-[14px] font-bold leading-none ${known ? TONE[state.state as SmaDirection].mark : 'text-[var(--color-text-tertiary)]'}`}>
        {known ? DIRECTION_ARROW[state.state as SmaDirection] : '?'}
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] font-bold leading-5 text-[var(--color-text-primary)]" data-sma-current-direction-headline>{state.headline}</span>
        <span className="block text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{state.detail}</span>
      </span>
    </div>
  )
}

/** Step 2a. Which question about the same N bars: only T+N, at least once within N, or every bar through N. */
export function SolverScopePicker({
  timeframe,
  kind,
  n,
  onPick,
}: {
  timeframe: SmaLabTimeframeId
  kind: SolverGoalKind
  n: number
  onPick: (scope: (typeof SOLVER_SCOPES)[number]) => void
}) {
  const advanced = !isSolverScope(kind)
  const current = SOLVER_SCOPE_CHOICES.find((choice) => choice.id === kind)
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-sma-solver-scope>
      <div role="group" aria-label="調べる範囲" className="grid grid-cols-3 gap-1">
        {SOLVER_SCOPE_CHOICES.map((choice) => {
          const on = kind === choice.id
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={on}
              data-solver-scope-option={choice.id}
              onClick={() => onPick(choice.id)}
              className={`flex min-h-12 min-w-0 flex-col items-center justify-center rounded-[var(--radius-sm)] border px-1 py-1 text-center ${
                on ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              <span className="text-[12px] font-bold leading-tight">{scopeLabel(choice.id, timeframe, n)}</span>
              <span className={`text-[10px] font-medium leading-tight ${on ? 'text-white/80' : 'text-[var(--color-text-tertiary)]'}`}>{on && <span aria-hidden="true">✓ </span>}{choice.sub}</span>
            </button>
          )
        })}
      </div>
      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-solver-scope-help>
        {advanced ? '上級の調べ方を選択中です。上のどれかを押すと、通常の3つの範囲に戻ります。' : current && scopeHelp(current.id, timeframe, n)}
      </p>
    </div>
  )
}

/** Step 2b. The count N (1..20) in the selected timeframe's unit; dates come from the calendar-aware projection. */
export function SolverTimingPicker({
  timeframe,
  kind,
  value,
  maxK,
  futureBars,
  onPick,
}: {
  timeframe: SmaLabTimeframeId
  kind: SolverGoalKind
  /** Effective (clamped) bar count currently chosen. */
  value: number
  /** Largest bar count selectable (the solver supports 1..20 on every timeframe). */
  maxK: number
  futureBars: ReadonlyArray<SmaLabFutureBar> | undefined
  onPick: (k: number) => void
}) {
  const max = Math.min(maxK, SMA_LAB_SOLVER_MAX_BARS)
  const quick = SOLVER_QUICK_TIMINGS.filter((k) => k <= max)
  const others = Array.from({ length: max }, (_, i) => i + 1).filter((k) => !quick.includes(k))
  const span = kind === 'within' || kind === 'reversal' || kind === 'maintain'
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-sma-solver-timing>
      <div role="group" aria-label={span ? '何本を対象にするか' : 'いつの状態を調べるか'} className="grid grid-cols-5 gap-1">
        {quick.map((k) => {
          const on = k === value
          const date = timingDate(futureBars, k)
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              data-timing-k={k}
              onClick={() => onPick(k)}
              className={`flex min-h-11 min-w-0 flex-col items-center justify-center rounded-[var(--radius-sm)] border px-0.5 py-1 text-center ${
                on ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              <span className="whitespace-nowrap text-[11px] font-bold leading-tight sm:text-[12px]">{unitLabel(timeframe, k)}</span>
              <span className={`whitespace-nowrap font-mono text-[10px] font-medium leading-tight tabular-nums ${on ? 'text-white/80' : 'text-[var(--color-text-tertiary)]'}`}>{on && <span aria-hidden="true">✓</span>}{date ? `${span ? '〜' : ''}${date.short}` : ''}</span>
            </button>
          )
        })}
      </div>
      {others.length > 0 && (
        <MoreOptions label="ほかの本数 (1〜20)" note={quick.includes(value) ? undefined : `選択中: ${unitLabel(timeframe, value)}`} open={!quick.includes(value)}>
          <label className="flex items-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            ほかの本数
            <select
              className="h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-[12px] font-bold text-[var(--color-text-primary)] sm:h-8"
              value={quick.includes(value) ? '' : value}
              onChange={(event) => { if (event.target.value) onPick(Number(event.target.value)) }}
            >
              <option value="" disabled>選んでください</option>
              {others.map((k) => <option key={k} value={k}>{unitLabel(timeframe, k)}{timingDate(futureBars, k) ? ` (${timingDate(futureBars, k)!.short})` : ''}</option>)}
            </select>
          </label>
        </MoreOptions>
      )}
      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-timing-caption>
        {span ? '最後の対象足: ' : ''}{describeTiming(timeframe, value, futureBars)}
      </p>
    </div>
  )
}

/** Step 3. Up / flat / down get identical size, order-independent styling, arrow, word and check mark. */
export function SolverDirectionPicker({ draft, onDraftChange }: { draft: SolverDraft; onDraftChange: (patch: Partial<SolverDraft>) => void }) {
  const level = draft.kind === 'level'
  const reversal = draft.kind === 'reversal'
  const options: Array<{ id: SmaDirection; text: string; sub?: string }> = reversal
    ? [{ id: 'up', text: '上向きへ転換', sub: '下向き側から上向きへ' }, { id: 'down', text: '下向きへ転換', sub: '上向き側から下向きへ' }]
    : SMA_DIRECTIONS.map((direction) => ({
        id: direction,
        text: level ? { up: '基準日より高い', flat: '基準日と同じ', down: '基準日より低い' }[direction] : directionWord(direction),
      }))
  const selected = reversal ? draft.to : draft.direction
  return (
    <div role="group" aria-label={level ? '基準日のSMAとの比較' : reversal ? '転換する向き' : 'SMAの向き'} className={`grid gap-1 ${reversal ? 'grid-cols-2' : 'grid-cols-3'}`} data-sma-solver-directions>
      {options.map((option) => {
        const on = option.id === selected
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            data-direction={option.id}
            onClick={() => onDraftChange(reversal ? { to: option.id as 'up' | 'down' } : { direction: option.id })}
            className={`flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] border-2 px-1 py-1 text-center ${
              on ? TONE[option.id].on : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            <span aria-hidden="true" className={`text-[18px] font-bold leading-none ${TONE[option.id].mark}`}>{DIRECTION_ARROW[option.id]}</span>
            <span className="text-[12px] font-bold leading-tight">{on && <span aria-hidden="true">✓ </span>}{option.text}</span>
            {option.sub && <span className="text-[10px] font-medium leading-tight text-[var(--color-text-tertiary)]">{option.sub}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Advanced research goals (reversal event, level versus the anchor SMA), apart from the three scopes. */
export function SolverKindPicker({ draft, onDraftChange }: { draft: SolverDraft; onDraftChange: (patch: Partial<SolverDraft>) => void }) {
  const current = GOAL_KIND_CHOICES.find((choice) => choice.id === draft.kind)
  return (
    <MoreOptions label="上級: 転換・水準を調べる" note={current ? `選択中: ${current.label}` : undefined} open={current != null}>
      <div role="group" aria-label="別の調べ方 (上級)" className="grid grid-cols-2 gap-1" data-sma-solver-kinds>
        {GOAL_KIND_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            aria-pressed={draft.kind === choice.id}
            data-goal-kind={choice.id}
            onClick={() => onDraftChange({ kind: choice.id })}
            className={`min-h-11 rounded-[var(--radius-sm)] border px-1.5 py-1 text-[11px] font-bold leading-tight sm:min-h-8 ${
              draft.kind === choice.id ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            {draft.kind === choice.id && <span aria-hidden="true">✓ </span>}{choice.label}
          </button>
        ))}
      </div>
      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-solver-kind-help>
        {current ? current.help : '「N本以内に一度でも」とは別に、符号反転の出来事や基準日SMAとの水準比較を調べます。'}
      </p>
      {(current?.id === 'reversal' || draft.kind === 'reversal') && (
        <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]" data-sma-reversal-definition>{REVERSAL_DEFINITION}</p>
      )}
    </MoreOptions>
  )
}
