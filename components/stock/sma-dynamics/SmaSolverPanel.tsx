'use client'

// Mode C: SMA inverse solver. Result order: goal, required price condition, how the SMA
// changes, representative path; the exact math (tick/constraint-aware boundaries,
// non-uniqueness, paths next to a failing comparison) sits in the details below.
import type { ReactNode } from 'react'
import { ChevronRight, Copy } from 'lucide-react'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import { SMA_LAB_PERIODS, type SmaLabAvailable, type SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import {
  DIRECTION_ARROW,
  goalKindTag,
  REVERSAL_DEFINITION,
  withinExplanation,
  describeRepresentativeHit,
  goalTitle,
  isSingleBarSameDirection,
  priceCondition,
  singleBarScopeNote,
  priceUnit,
  smaLineName,
  spanLabel,
  timingLabel,
  withinLabel,
  type DirectionComparisonRow,
  type WordingContext,
} from '@/lib/sma-dynamics-solver-copy'
import { smaLabTimeframe, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import type { SmaLabHighlightInput } from '@/lib/sma-dynamics-chart-model'
import {
  SMA_DELTA_BEGINNER,
  conditionStructureText,
  firstHitMarker,
  pathDependencyRule,
  readingNotes,
  relativeInstances,
  scopeGlossary,
  solverInsight,
  type FirstHitMarker,
} from '@/lib/sma-dynamics-insight'
import {
  DIRECTION_LABEL,
  describeSolverIssue,
  goalBars,
  goalTarget,
  PATH_ASSUMPTIONS,
  smaSteps,
  type BarRequirement,
  type Comparator,
  type ForwardBase,
  type GoalCheck,
  type PathAssumption,
  type RepresentativePath,
  type SmaDirection,
  type SolverAnalysis,
  type SolverDraft,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import { SegmentedControl } from './SmaDynamicsControls'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { Callout, ConclusionRows, DirectionGlyph, SmaDot } from './SmaSimulationParts'

export const SOLVER_STATUS_LABEL: Record<SolverAnalysis['status'], string> = {
  feasible: '成立可能',
  infeasible: '制約の下で解なし',
  precondition_failed: '前提不成立',
  unavailable: '計算できません',
}

const STATUS_TONE: Record<SolverAnalysis['status'], 'ok' | 'error' | 'warn' | 'neutral'> = {
  feasible: 'ok',
  infeasible: 'error',
  precondition_failed: 'warn',
  unavailable: 'neutral',
}

const OP_TEXT: Record<Comparator, string> = { '>': '>', '=': '=', '<': '<' }

export interface SolverViewModel {
  goal: SolverGoal
  analysis: SolverAnalysis
  paths: Record<PathAssumption, RepresentativePath>
  /** Goal check on the Mode B scenario (null when nothing is entered). */
  scenarioCheck: GoalCheck | null
  /** Names the checked path when it came from a hand-off (default: the user's typed scenario). */
  scenarioCheckLabel?: string
  freezeCheck: GoalCheck
  /** Up / flat / down side by side (single-bar direction goals only). */
  comparison: DirectionComparisonRow[] | null
}

/** Optional price constraints (goal kinds live next to the direction choice, labelled 上級). */
export function SolverAdvanced({
  draft,
  constraintErrors,
  onDraftChange,
}: {
  draft: SolverDraft
  constraintErrors: ReadonlyArray<'min' | 'max' | 'tick'>
  onDraftChange: (patch: Partial<SolverDraft>) => void
}) {
  const field = 'flex min-w-0 flex-col gap-1'
  const fieldLabel = 'text-[11px] font-bold text-[var(--color-text-tertiary)]'
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-sma-solver-advanced>
      <legend className="sr-only">価格の制約</legend>
      <details className="group" open={draft.minText !== '' || draft.maxText !== '' || draft.tickText !== '' || undefined}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-text-secondary)] sm:min-h-7 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} aria-hidden="true" className="transition-transform group-open:rotate-90" />
          価格の制約 (任意)
        </summary>
        <div className="mt-1 grid max-w-[420px] grid-cols-3 gap-1.5">
          {([['minText', '下限', 'min'], ['maxText', '上限', 'max'], ['tickText', '刻み', 'tick']] as const).map(([key, label, error]) => (
            <label key={key} className={field}>
              <span className={fieldLabel}>{label}</span>
              <input
                className={`h-11 w-full min-w-0 rounded-[var(--radius-sm)] border bg-white px-1.5 text-right font-mono text-[12px] tabular-nums sm:h-8 ${constraintErrors.includes(error) ? 'border-rose-400 bg-rose-50' : 'border-[var(--color-border-default)]'}`}
                inputMode="decimal"
                placeholder={key === 'tickText' ? '連続' : 'なし'}
                aria-invalid={constraintErrors.includes(error) || undefined}
                value={draft[key]}
                onChange={(event) => onDraftChange({ [key]: event.target.value } as Partial<SolverDraft>)}
              />
            </label>
          ))}
        </div>
        <p className="m-0 mt-1 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">
          価格は常に0より大きいものとします。刻みは入力した値だけを使い、取引所の呼値・株式分割などは仮定しません。
          {constraintErrors.length > 0 && <span className="text-rose-700"> 正の数値でない制約、または小数12桁を超える刻みは無視しています。</span>}
        </p>
      </details>
    </fieldset>
  )
}

/** Wording context shared by the conclusion and the chart caption. */
export function solverWording(args: { timeframe: SmaLabTimeframeId; market: SmaDynamicsMarket; analysis: SolverAnalysis; exact: PriceFormat }): WordingContext {
  return { timeframe: args.timeframe, current: args.analysis.anchorDirection?.direction ?? null, unit: priceUnit(args.market), exact: args.exact }
}

function pathExample(path: RepresentativePath, timeframe: SmaLabTimeframeId, exact: PriceFormat, unit: string): string {
  const closes = path.closes ?? []
  const shown = closes.slice(0, 5).map((close, i) => `${timingLabel(timeframe, i + 1)} ${exact(close)}${unit}`).join(' → ')
  return closes.length > 5 ? `${shown} → …` : shown
}

/** Bar the example path is read at: the judged bar, the last bar of a run, or the first hit of a within/reversal path. */
function focusBar(goal: SolverGoal, path: RepresentativePath): number | null {
  return goal.kind === 'direction' || goal.kind === 'level' ? goal.bar : goal.kind === 'maintain' ? goal.through : (path.check?.hitK ?? null)
}

/** Plain-language result in the fixed order: goal, price condition, SMA change, representative path. */
export function SolverConclusion({
  result,
  base,
  model,
  draft,
  fmt,
  exact,
  market,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  model: SolverViewModel
  draft: SolverDraft
  fmt: PriceFormat
  exact: PriceFormat
  market: SmaDynamicsMarket
}) {
  const { analysis, goal } = model
  const timeframe = result.timeframe
  const ctx = solverWording({ timeframe, market, analysis, exact })
  const name = smaLineName(goal.period, timeframe)
  const condition = priceCondition(analysis, ctx)
  const path = model.paths[draft.assumption]
  const meta = PATH_ASSUMPTIONS.find((item) => item.id === path.assumption)!
  const steps = path.status === 'found' && path.closes ? smaSteps(base, path.closes, goal.period) : null
  const focusK = focusBar(goal, path)
  const focus = steps && focusK ? steps[focusK - 1] : null
  const previous = focus && focusK ? (focusK > 1 ? steps![focusK - 2].sma : analysis.anchorSma) : null
  const current = ctx.current
  const target = goalTarget(goal)
  const feasible = analysis.status === 'feasible'
  const unit = ctx.unit

  const freezeLine = feasible
    ? model.freezeCheck.satisfied && model.freezeCheck.inDomain ? '株価が今のままでも、この条件を満たします。' : '株価が今のままでは、この条件を満たしません。'
    : null

  let change: ReactNode
  if (!feasible) {
    change = <span className="text-[var(--color-text-tertiary)]">条件を満たす価格がないため、SMAの変化は示せません。</span>
  } else {
    const now = current ? <>現在の{name}は <DirectionBadge direction={current} /></> : <>現在の{name}の向きは判定できません</>
    const sameAsNow = goal.kind === 'direction' && goal.bar === 1 && current ? (current === goal.direction ? '現在と同じ向きです。' : '現在から向きが変わります。') : null
    const after =
      goal.kind === 'direction' ? <>条件を満たした場合、{timingLabel(timeframe, goal.bar)}の{name}は <DirectionBadge direction={target} /> になります。{sameAsNow}{goal.bar > 1 && ' それまでの途中の足の向きは、この条件では決まりません。'}</>
      : isSingleBarSameDirection(goal) ? <>条件を満たした場合、{timingLabel(timeframe, 1)}の{name}は <DirectionBadge direction={target} /> になります。{singleBarScopeNote(timeframe)}</>
      : goal.kind === 'within' ? <>条件を満たした場合、{withinLabel(timeframe, goal.within)}のどこか1本以上で <DirectionBadge direction={target} /> になります。{current === target && ' 今がすでにその向きでも、T+0 は数えません。'} 到達後に外れても成立のままで、{timingLabel(timeframe, goal.within)}の時点や「ずっと」を保証するものではありません。</>
      : goal.kind === 'maintain' ? <>条件を満たした場合、{spanLabel(timeframe, goal.through)}のすべての足で <DirectionBadge direction={target} /> になります。</>
      : goal.kind === 'reversal' ? <>条件を満たした場合、{withinLabel(timeframe, goal.within)}のどこかで <DirectionBadge direction={target} /> へ実際に切り替わります (転換)。</>
      : <>条件を満たした場合、{timingLabel(timeframe, goal.bar)}の{name}は基準日の値より{{ up: '高く', flat: '同じに', down: '低く' }[target]}なります。</>
    change = (
      <>
        {now}。{after}
        {focus && focus.sma != null && previous != null && focusK != null && (
          <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]">
            {goal.kind === 'level' ? '基準日' : focusK > 1 ? timingLabel(timeframe, focusK - 1) : '現在'} {fmt(goal.kind === 'level' ? analysis.anchorSma : previous)} → {timingLabel(timeframe, focusK)} {fmt(focus.sma)} (この例の経路)
          </span>
        )}
      </>
    )
  }

  const items: Array<{ label: string; body: ReactNode }> = [
    {
      label: '目標',
      body: (
        <>
          <b data-solver-goal-title>{goalTitle(goal, ctx)}</b>
          <span className="ml-1.5 inline-flex items-center rounded-[3px] border border-[var(--color-border-default)] px-1 text-[10px] font-bold text-[var(--color-text-tertiary)]" data-solver-kind-tag={goal.kind}>{goalKindTag(goal)}</span>
        </>
      ),
    },
    {
      label: '必要な価格',
      body: (
        <>
          <span className={`mr-1 inline-flex items-center rounded-[3px] border px-1.5 text-[11px] font-bold ${
            { ok: 'border-emerald-300 bg-emerald-50 text-emerald-800', error: 'border-rose-300 bg-rose-50 text-rose-800', warn: 'border-amber-300 bg-amber-50 text-amber-800', neutral: 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]' }[STATUS_TONE[analysis.status]]
          }`} data-solver-status={analysis.status}>{SOLVER_STATUS_LABEL[analysis.status]}</span>
          <span data-solver-price-condition={condition.kind}>{condition.headline}</span>
          {condition.lines.length > 0 && (
            <ul className="m-0 mt-0.5 list-disc pl-4 text-[11px] leading-5 text-[var(--color-text-secondary)]">
              {condition.lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          {freezeLine && <span className="mt-0.5 block text-[11px] text-[var(--color-text-secondary)]" data-solver-freeze-line>{freezeLine}</span>}
        </>
      ),
    },
    { label: 'SMAの変化', body: change },
  ]
  if (feasible) {
    const hit = steps && path.check && focus
      ? describeRepresentativeHit({
          goal,
          check: path.check,
          ctx,
          futureBars: result.projection.bars,
          smaAtHit: focus.sma,
          closeAtHit: focus.incoming,
          fmt,
          retained: analysis.retained,
        })
      : null
    items.push({
      label: '代表的な経路',
      body: steps && path.closes ? (
        <>
          {hit && (
            <span className="mb-0.5 block" data-solver-hit={hit.hitK ?? 'none'}>
              <b>{hit.headline}</b>
              {hit.lines.map((line) => <span key={line} className="block text-[11px] font-normal leading-5 text-[var(--color-text-secondary)]">{line}</span>)}
            </span>
          )}
          <span className="font-mono text-[11px]">{pathExample(path, timeframe, exact, unit)}</span>
          {!hit && <span className="block text-[11px] text-[var(--color-text-tertiary)]">この株価推移は一例 (補助条件: {meta.label}) です。ほかにも条件を満たす動き方があります。</span>}
          {hit && <span className="block text-[11px] text-[var(--color-text-tertiary)]">補助条件: {meta.label}。この株価推移は一例です。</span>}
        </>
      ) : '選んだ補助条件では代表経路が見つかりませんでした。詳細で別の補助条件を選べます。',
    })
  }

  const hitMarker = solverFirstHit({ result, base, model, draft, fmt, exact, market })
  const insight = solverInsight({ analysis, ctx, check: path.check, hit: hitMarker, steps, futureBars: result.projection.bars, fmt, closes: path.closes, anchorClose: base.anchorClose })

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-sma-conclusion data-sma-conclusion-mode="solver">
      {/* Layer 1: one sentence computed from the actual result */}
      <p className="m-0 text-[13px] font-bold leading-6 text-[var(--color-text-primary)]" data-solver-insight>
        <span className={`mr-1.5 inline-flex items-center rounded-[3px] border px-1.5 align-middle text-[11px] font-bold ${
          { ok: 'border-emerald-300 bg-emerald-50 text-emerald-800', error: 'border-rose-300 bg-rose-50 text-rose-800', warn: 'border-amber-300 bg-amber-50 text-amber-800', neutral: 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]' }[STATUS_TONE[analysis.status]]
        }`} data-solver-status-badge={analysis.status}>{SOLVER_STATUS_LABEL[analysis.status]}</span>
        {insight.sentence}
      </p>
      {/* Layer 2: key figures (the chart above stays the primary evidence) */}
      <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 border-y border-[var(--color-border-soft)] py-2 sm:grid-cols-3" data-solver-figures>
        {insight.figures.map((figure) => (
          <div key={figure.id} className={`min-w-0 ${figure.id === 'boundary' ? 'col-span-2 sm:col-span-3' : ''}`} data-solver-figure={figure.id}>
            <dt className="m-0 text-[10px] font-bold text-[var(--color-text-tertiary)]">{figure.label}</dt>
            <dd className="m-0 break-words text-[12px] font-bold leading-5 text-[var(--color-text-primary)]">{figure.value}</dd>
          </div>
        ))}
      </dl>
      {hitMarker && !isSingleBarSameDirection(goal) && <p className="m-0 text-[11px] leading-5 text-[var(--color-text-tertiary)]" data-solver-hit-scope>これは選択中の代表経路での最初の{goal.kind === 'reversal' ? '転換' : '到達'}です。全経路で最も早い{goal.kind === 'reversal' ? '転換' : '到達'}ではありません。</p>}
      {/* Layer 3: conditions, formulas, requirement list, representative path */}
      <details className="group" data-solver-layer3>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-text-secondary)] sm:min-h-7 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} aria-hidden="true" className="transition-transform group-open:rotate-90" />
          条件・代表経路の読み方
        </summary>
        <div className="mt-1 flex min-w-0 flex-col gap-2">
          <ConclusionRows items={items} />
          {feasible && <p className="m-0 text-[11px] leading-5 text-[var(--color-text-tertiary)]" data-solver-uniqueness>{uniquenessText(analysis, timeframe)}</p>}
          {model.comparison && <DirectionComparison rows={model.comparison} timeframe={timeframe} goal={goal} name={name} />}
        </div>
      </details>
    </div>
  )
}

/** First hit of the selected representative path (within / reversal only). Shared by the chart marker and the result panel. */
export function solverFirstHit({ result, base, model, draft, fmt, exact, market }: {
  result: SmaLabAvailable
  base: ForwardBase
  model: SolverViewModel
  draft: SolverDraft
  fmt: PriceFormat
  exact: PriceFormat
  market: SmaDynamicsMarket
}): FirstHitMarker | null {
  const { analysis, goal } = model
  const path = model.paths[draft.assumption]
  if (analysis.status !== 'feasible' || path.status !== 'found' || !path.closes || !path.check) return null
  return firstHitMarker({
    goal,
    check: path.check,
    steps: smaSteps(base, path.closes, goal.period),
    closes: path.closes,
    ctx: solverWording({ timeframe: result.timeframe, market, analysis, exact }),
    futureBars: result.projection.bars,
    currentDirection: analysis.anchorDirection?.direction ?? null,
    retained: analysis.retained,
    fmt,
  })
}

const OUTCOME_TAG: Record<FirstHitMarker['outcome'], string> = { last_bar: '最終足', held: '以後維持', lost: 'のち外れる', reversed: 'のち反対向き' }

/** Chart highlight for a first hit: text tag + detail lines (identical to the panel's facts). */
export function hitHighlight(hit: FirstHitMarker): SmaLabHighlightInput {
  return {
    k: hit.k,
    price: hit.close,
    label: hit.label,
    lines: hit.lines,
    ariaLabel: hit.ariaLabel,
    tag: `初${hit.kind === 'reversal' ? '転換' : '到達'} T+${hit.k} ・ ${OUTCOME_TAG[hit.outcome]}`,
  }
}

/** Arrow + word, so direction never depends on colour. */
export function DirectionBadge({ direction }: { direction: SmaDirection }) {
  const tone = { up: 'text-red-700', flat: 'text-slate-700', down: 'text-blue-700' }[direction]
  return (
    <span className={`inline-flex items-baseline gap-0.5 whitespace-nowrap font-bold ${tone}`} data-direction={direction}>
      <span aria-hidden="true">{DIRECTION_ARROW[direction]}</span>{DIRECTION_LABEL[direction]}
    </span>
  )
}

/** Up / flat / down side by side for the same SMA and bar. Relative (path-dependent) cases carry no fixed number. */
function DirectionComparison({ rows, timeframe, goal, name }: { rows: DirectionComparisonRow[]; timeframe: SmaLabTimeframeId; goal: SolverGoal; name: string }) {
  return (
    <table className="w-full border-collapse text-[11px]" data-solver-direction-comparison>
      <caption className="mb-1 text-left text-[11px] font-bold text-[var(--color-text-secondary)]">
        {goal.kind === 'direction' ? timingLabel(timeframe, goal.bar) : ''}の{name}: 向きごとの必要な価格
      </caption>
      <thead className="sr-only"><tr><th scope="col">向き</th><th scope="col">必要な価格条件</th></tr></thead>
      <tbody className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {rows.map((row) => {
          const selected = goal.kind === 'direction' && goal.direction === row.direction
          return (
            <tr key={row.direction} data-compare-direction={row.direction} aria-current={selected || undefined} className={selected ? 'bg-[var(--color-surface-subtle)]' : undefined}>
              <th scope="row" style={{ background: 'transparent' }} className="whitespace-nowrap py-1 pr-2 text-left font-medium"><DirectionBadge direction={row.direction} />{selected && <span className="ml-1 text-[10px] text-[var(--color-text-tertiary)]">選択中</span>}</th>
              <td className={`py-1 ${row.status === 'feasible' ? 'text-[var(--color-text-primary)]' : 'text-rose-700'}`}>{row.text}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function outgoingText(result: SmaLabAvailable, index: number): string {
  const bar = result.bars[index]
  return bar ? `${bar.lastSession} の確定終値` : '確定終値'
}

function boundText(op: Comparator, requirement: { value: number; bound: { value: number; attained: boolean } | null }, exact: PriceFormat, tick: boolean): string {
  const bound = requirement.bound
  if (!bound) return '制約内に該当する価格なし'
  if (op === '=') return `ちょうど ${exact(bound.value)}`
  if (!bound.attained) return `${exact(bound.value)} ${op === '>' ? 'を超える' : '未満の'}値 (境界値は含まない・連続価格)`
  if (bound.value !== requirement.value && !tick) return `${op === '>' ? '最小' : '最大'} ${exact(bound.value)} (制約の端)`
  return `${tick ? '刻みを考慮した' : ''}${op === '>' ? '最小' : '最大'} ${exact(bound.value)}`
}

function RequirementLine({ requirement, result, exact, tick }: { requirement: BarRequirement; result: SmaLabAvailable; exact: PriceFormat; tick: boolean }) {
  if (requirement.kind === 'threshold') {
    return (
      <li className="flex flex-wrap items-baseline gap-x-2" data-requirement-k={requirement.k}>
        <span className="font-mono text-[12px] font-bold text-[var(--color-text-primary)]">
          T+{requirement.k} の終値 {OP_TEXT[requirement.op]} {exact(requirement.value)}
        </span>
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">({timingLabel(result.timeframe, requirement.k)})</span>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">
          {exact(requirement.value)} = T+{requirement.k} で計算窓から抜ける {outgoingText(result, requirement.outgoingIndex)}
          {requirement.op !== '=' && ' ・ ちょうどこの値なら厳密に横ばい'}
        </span>
        <span className={`text-[11px] font-bold ${requirement.feasible ? 'text-[var(--color-text-secondary)]' : 'text-rose-700'}`}>
          → {boundText(requirement.op, requirement, exact, tick)}
        </span>
      </li>
    )
  }
  if (requirement.kind === 'relative') {
    return (
      <li className="flex flex-wrap items-baseline gap-x-2" data-requirement-k={requirement.k}>
        <span className="font-mono text-[12px] font-bold text-[var(--color-text-primary)]">
          T+{requirement.k} の終値 {OP_TEXT[requirement.op]} T+{requirement.otherK} の終値
        </span>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">
          T+{requirement.k} で抜けるのは将来の T+{requirement.otherK} の仮定終値なので、絶対的な価格水準はありません
        </span>
      </li>
    )
  }
  return null
}

export function uniquenessText(analysis: SolverAnalysis, timeframe: SmaLabTimeframeId): string {
  return conditionStructureText(analysis, timeframe)
}

function checkText(check: GoalCheck, goal: SolverGoal): string {
  if (!check.complete) return '入力不足'
  if (!check.inDomain) return '制約外'
  if (check.satisfied) return goal.kind === 'reversal' && check.hitK ? `成立 (T+${check.hitK} で転換)` : goal.kind === 'within' && check.hitK ? `成立 (T+${check.hitK} で初めて到達)` : '成立'
  return '未達'
}

export function SolverDetails({
  result,
  base,
  model,
  draft,
  fmt,
  exact,
  market,
  onDraftChange,
  onCopyToScenario,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  model: SolverViewModel
  draft: SolverDraft
  fmt: PriceFormat
  exact: PriceFormat
  market: SmaDynamicsMarket
  onDraftChange: (patch: Partial<SolverDraft>) => void
  onCopyToScenario: (closes: number[]) => void
}) {
  const { analysis, goal } = model
  const tick = analysis.domain.grid != null
  const listed = analysis.requirements.filter((item) => item.kind === 'threshold' || item.kind === 'relative')
  const anchor = analysis.anchorDirection
  const path = model.paths[draft.assumption]
  const showPaths = analysis.status === 'feasible'
  const ctx = solverWording({ timeframe: result.timeframe, market, analysis, exact })
  const relativeConditions = relativeInstances(analysis, ctx, path.status === 'found' ? path.closes : null)
  const glossary = scopeGlossary(goal, result.timeframe)

  return (
    <>
      <h3 className="m-0 text-[13px] font-bold text-[var(--color-text-primary)]" data-solver-goal>{goalTitle(goal, ctx)}</h3>
      <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{goalKindTag(goal)} ・ 対象の足: {Array.from(new Set(goal.kind === 'within' || goal.kind === 'reversal' || goal.kind === 'maintain' ? [1, goalBars(goal)] : [goalBars(goal)])).map((k) => `T+${k} = ${timingLabel(result.timeframe, k)}`).join(' 〜 ')}</p>
      <p className="m-0 font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]">
        最終確定足のSMA{goal.period} <b className="text-[var(--color-text-primary)]">{fmt(analysis.anchorSma)}</b>
        {anchor && (
          <span className="font-sans"> ・ 現在の向き <DirectionGlyph direction={anchor.direction} displayFlat={anchor.displayFlat} /> {DIRECTION_LABEL[anchor.direction]} (前の足比 {anchor.delta > 0 ? '+' : ''}{exact(anchor.delta)})</span>
        )}
      </p>

      {analysis.issue && (
        <Callout tone={STATUS_TONE[analysis.status] === 'ok' ? 'neutral' : STATUS_TONE[analysis.status]} data-solver-issue={analysis.issue}>
          {describeSolverIssue(analysis.issue, smaLabTimeframe(result.timeframe).barNoun)}
          {analysis.status === 'infeasible' && ' これは制約下で数学的に解が存在しないという判定で、探索の打ち切りではありません。'}
        </Callout>
      )}
      {goal.kind === 'within' && (
        <Callout tone="neutral" data-solver-within-note>
          {withinExplanation(result.timeframe, goal.within)}{analysis.currentlyTarget && anchor && ` 現在すでに${DIRECTION_LABEL[anchor.direction]}ですが、T+0 は数えないため T+1 以降の足で改めて判定します。`}
        </Callout>
      )}
      {goal.kind === 'reversal' && (
        <Callout tone="neutral" data-solver-reversal-note>
          {REVERSAL_DEFINITION}
          {analysis.retained?.state === 'known' && ` 現在の直近の向き: ${analysis.retained.direction ? DIRECTION_LABEL[analysis.retained.direction] : '横ばいのみ (向きの履歴なし)'}。`}
        </Callout>
      )}
      {analysis.startsWithTurn && anchor && (
        <Callout tone="warn">現在は{DIRECTION_LABEL[anchor.direction]}のため、「維持」ではなく T+1 で向きを変えてから続ける条件になります。</Callout>
      )}

      {analysis.status !== 'unavailable' && (
        <section aria-label="必要な価格条件" className="flex flex-col gap-1" data-solver-conditions>
          <h4 className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">
            必要な価格条件 {analysis.combinator === 'any' ? <span className="font-medium text-[var(--color-text-tertiary)]">(いずれか1本で成立)</span> : analysis.combinator === 'sequence' ? <span className="font-medium text-[var(--color-text-tertiary)]">(①反対向き → ②目標の向き の順に必要)</span> : listed.length > 1 ? <span className="font-medium text-[var(--color-text-tertiary)]">(すべて必要)</span> : null}
          </h4>
          {analysis.sum ? (
            <ul className="m-0 list-none p-0">
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px] font-bold text-[var(--color-text-primary)]">
                  T+{analysis.sum.fromK}{analysis.sum.count > 1 ? `〜T+${analysis.sum.toK}` : ''} の終値{analysis.sum.count > 1 ? 'の平均' : ''} {OP_TEXT[analysis.sum.op]} {exact(analysis.sum.mean)}
                </span>
                <span className="text-[11px] text-[var(--color-text-tertiary)]">
                  = 窓から抜ける確定終値 {analysis.sum.count}本の平均{analysis.sum.count > 1 && ` (合計 ${OP_TEXT[analysis.sum.op]} ${exact(analysis.sum.sum)})`}
                </span>
                <span className={`text-[11px] font-bold ${analysis.sum.feasible ? 'text-[var(--color-text-secondary)]' : 'text-rose-700'}`}>
                  → {analysis.sum.meanBound ? boundText(analysis.sum.op, { value: analysis.sum.mean, bound: analysis.sum.meanBound }, exact, tick) : '制約内に該当する価格なし'}
                </span>
              </li>
            </ul>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {analysis.combinator === 'sequence' && (
                <>
                  <li className="text-[11px] font-bold text-[var(--color-text-secondary)]">① 先に出る {DIRECTION_LABEL[goal.kind === 'reversal' ? (goal.to === 'up' ? 'down' : 'up') : 'down']} の足 (いずれか1本)</li>
                  {analysis.oppositeRequirements.slice(0, Math.min(goalBars(goal) - 1, 6)).filter((item) => item.kind === 'threshold' || item.kind === 'relative').map((item) => <RequirementLine key={`o${item.k}`} requirement={item} result={result} exact={exact} tick={tick} />)}
                  <li className="mt-1 text-[11px] font-bold text-[var(--color-text-secondary)]">② そのあと {DIRECTION_LABEL[goal.kind === 'reversal' ? goal.to : 'up']} になる足 (いずれか1本)</li>
                </>
              )}
              {listed.slice(0, 12).map((item) => <RequirementLine key={item.k} requirement={item} result={result} exact={exact} tick={tick} />)}
              {listed.length > 12 && <li className="text-[11px] text-[var(--color-text-tertiary)]">ほか {listed.length - 12}本 (下の表を参照)</li>}
            </ul>
          )}
          {analysis.combinator === 'any' && (
            <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]" data-solver-boundary-note>
              足ごとの必要価格は、それぞれ別の日の条件です。価格の高低を比べて「どの日が楽か・起こりやすいか」は判断できません。
            </p>
          )}
          <p className="m-0 text-[11px] leading-5 text-[var(--color-text-secondary)]" data-solver-uniqueness>
            {uniquenessText(analysis, result.timeframe)} 条件を満たす価格経路は一般に無数にあり、下の経路は補助条件を置いた一例です。
          </p>
          {goal.kind !== 'level' && (
            <div className="flex flex-col gap-1" data-solver-path-dependency>
              <p className="m-0 text-[11px] leading-5 text-[var(--color-text-secondary)]" data-sma-delta-beginner>{SMA_DELTA_BEGINNER}</p>
              <p className="m-0 text-[11px] leading-5 text-[var(--color-text-secondary)]" data-sma-delta-formula>{pathDependencyRule(goal.period, result.timeframe)}</p>
              {relativeConditions.length > 0 && (
                <ul className="m-0 list-disc pl-4 text-[11px] leading-5 text-[var(--color-text-secondary)]" data-solver-relative-list>
                  {relativeConditions.slice(0, 6).map((item) => <li key={`${item.k}-${item.op}-${item.otherK}`}>{item.text}</li>)}
                  {relativeConditions.length > 6 && <li>ほか {relativeConditions.length - 6}本</li>}
                </ul>
              )}
            </div>
          )}
          <dl className="m-0 flex flex-col gap-0.5 text-[11px] leading-5" data-solver-scope-glossary>
            {glossary.map((item) => (
              <div key={item.id} aria-current={item.active || undefined} className={item.active ? 'font-medium text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}>
                <dt className="inline font-bold">{item.active ? '▶ ' : ''}{item.term}: </dt>
                <dd className="m-0 inline">{item.definition}</dd>
              </div>
            ))}
          </dl>
          <ul className="m-0 list-disc pl-4 text-[11px] leading-5 text-[var(--color-text-tertiary)]" data-solver-reading-notes>
            {readingNotes(analysis).map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>
      )}

      {analysis.status !== 'unavailable' && (
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]" data-solver-checks>
          <span>株価が今のまま (基準終値のまま)なら: <b className={model.freezeCheck.satisfied && model.freezeCheck.inDomain ? 'text-emerald-800' : 'text-[var(--color-text-primary)]'}>{checkText(model.freezeCheck, goal)}</b></span>
          {model.scenarioCheck && <span data-solver-scenario-check>{model.scenarioCheckLabel ?? '入力した価格シナリオ'}なら:<b className={model.scenarioCheck.satisfied && model.scenarioCheck.inDomain ? 'text-emerald-800' : 'text-[var(--color-text-primary)]'}>{checkText(model.scenarioCheck, goal)}</b></span>}
        </p>
      )}

      {showPaths && (
        <section aria-label="代表経路" className="flex min-w-0 flex-col gap-1.5 border-t border-[var(--color-border-soft)] pt-2" data-solver-paths>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">代表経路</h4>
            <SegmentedControl
              label="補助条件"
              hideLabel
              value={draft.assumption}
              options={PATH_ASSUMPTIONS.map((item) => ({
                value: item.id,
                label: `${item.label}${model.paths[item.id].status === 'found' ? '' : ' —'}`,
                title: `${item.description}${model.paths[item.id].status === 'found' ? '' : ' (この補助条件では見つかりません)'}`,
              }))}
              onChange={(assumption) => onDraftChange({ assumption })}
            />
          </div>
          <PathDetails result={result} base={base} model={model} path={path} fmt={fmt} exact={exact} onCopyToScenario={onCopyToScenario} />
        </section>
      )}
    </>
  )
}

function parameterText(path: RepresentativePath, fmt: PriceFormat, exact: PriceFormat, anchorClose: number): string {
  if (path.parameter == null) {
    return path.start != null && path.start !== anchorClose ? `変更しない足は ${exact(path.start)} (基準終値が制約外のため移動)` : `変更しない足は基準日の終値 ${fmt(anchorClose)}`
  }
  if (path.assumption === 'constant') return `p = ${exact(path.parameter)}`
  if (path.assumption === 'linear') return `s = ${path.parameter >= 0 ? '+' : '-'}${exact(Math.abs(path.parameter))} / 本`
  return `r = ${formatPct(path.parameter * 100)} / 本`
}

function PathDetails({
  result,
  base,
  model,
  path,
  fmt,
  exact,
  onCopyToScenario,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  model: SolverViewModel
  path: RepresentativePath
  fmt: PriceFormat
  exact: PriceFormat
  onCopyToScenario: (closes: number[]) => void
}) {
  const goal = model.goal
  const meta = PATH_ASSUMPTIONS.find((item) => item.id === path.assumption)!
  const rounding = path.grid ? `各足は ${exact(path.grid.step)} 刻みに丸めて判定` : ''
  if (path.status !== 'found' || !path.closes) {
    return (
      <Callout tone="warn" data-path-status="not_found">
        補助条件「{meta.label}」({meta.description}) では、制約を満たす経路が見つかりませんでした
        {path.search && ` (探索範囲 ${path.assumption === 'geometric' ? `${formatPct(path.search.from * 100)}〜${formatPct(path.search.to * 100)}` : `${exact(path.search.from)}〜${exact(path.search.to)}`})`}
        。問題自体は成立可能です (上の条件を参照)。他の補助条件を選んでください。
      </Callout>
    )
  }
  const steps = smaSteps(base, path.closes, goal.period)
  const failSteps = path.failing ? smaSteps(base, path.failing.closes, goal.period) : null
  const decisive = new Set(model.analysis.requirements.filter((item) => item.kind !== 'free').map((item) => item.k))
  const focusK = goal.kind === 'maintain' ? null : focusBar(goal, path)
  const focus = focusK ? steps[focusK - 1] : null
  const hitRow = (goal.kind === 'within' || goal.kind === 'reversal') ? path.check?.hitK ?? null : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-path-status="found" data-path-assumption={path.assumption}>
      <p className="m-0 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        <b className="text-[var(--color-text-primary)]">補助条件: {meta.label}</b> — {meta.description}。{parameterText(path, fmt, exact, base.anchorClose)}{rounding && ` ・ ${rounding}`}。
        {path.freezeSatisfies && ' 価格固定のままでも条件を満たします。'}
      </p>
      {focus && focus.delta != null && focus.levelChange != null && (
        <p className="m-0 font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]" data-solver-slope-level>
          <span className="font-sans font-bold">この経路の T+{focus.k}:</span> 向き (T+{focus.k - 1 === 0 ? '0' : focus.k - 1} 比) <DirectionGlyph direction={focus.direction} displayFlat={focus.displayFlat} /> {focus.delta > 0 ? '+' : ''}{exact(focus.delta)}
          <span className="font-sans"> ・ </span>
          水準 (基準日SMA比) {focus.levelChange > 0 ? '+' : ''}{exact(focus.levelChange)}
          <span className="font-sans text-[var(--color-text-tertiary)]"> — 向きと水準は別の条件です</span>
        </p>
      )}
      <div className="max-h-[320px] max-w-full overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border-soft)]">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-solver-path-table>
          <caption className="sr-only">代表経路と、同じ補助条件で条件を満たさない比較経路</caption>
          <thead className="sticky top-0 z-[1] bg-white">
            <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
              <th scope="col" className="py-1 pl-2 pr-2 text-left font-sans font-bold">足</th>
              <th scope="col" className="px-1 py-1 text-right font-sans font-bold">経路の終値</th>
              <th scope="col" className="px-1 py-1 text-right font-sans font-bold">抜ける終値</th>
              <th scope="col" className="px-1 py-1 text-right font-bold"><span className="inline-flex items-center gap-1"><SmaDot period={goal.period} />SMA{goal.period}</span></th>
              <th scope="col" className="px-1 py-1 text-center font-sans font-bold">向き</th>
              {failSteps && <th scope="col" className="border-l border-[var(--color-border-soft)] px-1 py-1 text-right font-sans font-bold">不成立の例</th>}
              {failSteps && <th scope="col" className="px-1 py-1 text-center font-sans font-bold">向き</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {steps.map((step, i) => {
              const fail = failSteps?.[i]
              const changed = fail && fail.incoming !== step.incoming
              return (
                <tr key={step.k} data-k={step.k} data-hit={hitRow === step.k || undefined} className={hitRow === step.k ? 'bg-amber-100' : decisive.has(step.k) && goal.kind !== 'within' && goal.kind !== 'reversal' ? 'bg-amber-50/60' : undefined}>
                  <th scope="row" style={{ background: 'transparent' }} className="whitespace-nowrap py-0.5 pl-2 pr-2 text-left font-medium text-[var(--color-text-secondary)]">
                    T+{step.k}{hitRow === step.k ? <span className="ml-1 font-sans text-[10px] font-bold text-amber-900">この例の最初の到達</span> : decisive.has(step.k) && goal.kind !== 'within' && goal.kind !== 'reversal' && <span className="ml-1 font-sans text-[10px] text-amber-800">条件</span>}
                  </th>
                  <td className="px-1 py-0.5 text-right font-bold text-[var(--color-text-primary)]">{exact(step.incoming)}</td>
                  <td className="px-1 py-0.5 text-right text-[var(--color-text-tertiary)]" title={step.outgoingSource?.kind === 'future' ? `T+${step.outgoingSource.k} の仮定終値` : step.outgoingSource ? outgoingText(result, step.outgoingSource.index) : undefined}>
                    {exact(step.outgoing)}{step.outgoingSource?.kind === 'future' && <span className="font-sans text-[10px]"> (T+{step.outgoingSource.k})</span>}
                  </td>
                  <td className="px-1 py-0.5 text-right">{fmt(step.sma)}</td>
                  <td className="px-1 py-0.5 text-center"><DirectionGlyph direction={step.direction} displayFlat={step.displayFlat} /></td>
                  {fail && (
                    <td className={`border-l border-[var(--color-border-soft)] px-1 py-0.5 text-right ${changed ? 'font-bold text-rose-800' : 'text-[var(--color-text-tertiary)]'}`}>{exact(fail.incoming)}</td>
                  )}
                  {fail && <td className="px-1 py-0.5 text-center"><DirectionGlyph direction={fail.direction} displayFlat={fail.displayFlat} /></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">
          {path.failing
            ? `不成立の例: 同じ補助条件で境界の反対側にある最も近い経路 (${checkText(path.failing.check, goal)})。太字が異なる足です。`
            : '同じ補助条件で条件を満たさない経路は、探索範囲内にありませんでした。'}
        </p>
        <button type="button" className="btn max-sm:min-h-11! max-sm:min-w-11!" data-size="sm" onClick={() => onCopyToScenario(path.closes!)} title="この経路を価格シナリオの入力にコピーして編集する">
          <Copy size={12} aria-hidden="true" />価格シナリオにコピー
        </button>
      </div>
    </div>
  )
}

/** SMA options for the solver: selected SMAs first, then the rest. */
export function solverPeriodOptions(result: SmaLabAvailable, selected: readonly SmaLabPeriod[]): Array<{ period: SmaLabPeriod; available: boolean }> {
  const order = [...selected, ...SMA_LAB_PERIODS.filter((period) => !selected.includes(period))]
  return order.map((period) => ({ period, available: result.periods.find((item) => item.period === period)?.status === 'ok' }))
}
