'use client'

// Inverse solving for touch / cross: which close at which bar makes the close or an SMA touch or
// cross another SMA. The maths lives in lib/sma-dynamics-crossing; this file only chooses the
// goal and words the answer. The closes before the answered bar are an explicit assumption
// (price freeze or the user's complete scenario), stated next to every result.
import { useId, useMemo, useState } from 'react'
import type { SmaLabAvailable, SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import { smaLabTimeframe } from '@/lib/sma-dynamics-timeframes'
import {
  analyzeCrossingGoal,
  CROSSING_GOAL_KINDS,
  crossingExamplePath,
  holdPrior,
  isValidCrossingGoal,
  type CrossingAnalysis,
  type CrossingBar,
  type CrossingGoal,
  type CrossingGoalKind,
  type CrossingIssue,
  type CrossingSubject,
} from '@/lib/sma-dynamics-crossing'
import { parseConstraints, type ForwardBase } from '@/lib/sma-dynamics-scenario'
import { SegmentedControl } from './SmaDynamicsControls'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { Callout } from './SmaSimulationParts'

export type CrossingPriorSource = 'hold' | 'scenario'

export const CROSSING_PRIOR_LABEL: Record<CrossingPriorSource, string> = {
  hold: '価格固定 (途中の足は基準日の終値のまま)',
  scenario: '入力したシナリオ (途中の足はその終値)',
}

const ISSUE_TEXT: Record<CrossingIssue, string> = {
  sma_unavailable: '履歴が足りないか窓内に使えない終値があり、選んだSMAを計算できません。',
  prior_missing: '途中の足の終値が未入力のため、この足は計算できません。',
  already_on_target_side: 'すでに目標の側にいるため、その向きの交差は起こせません (逆向きに抜けた後ならあり得ます)。',
  side_unknown: '直前の位置関係を判定できません。',
  same_line: '同じ線どうしは比べられません。別のSMAを選んでください。',
  bar_out_of_range: '選んだ本数が将来投影の本数を超えています。投影本数を増やしてください。',
  bound_excludes_threshold: '価格条件 (上限・下限) の範囲では、必要な終値に届きません。',
  tick_excludes_equality: '呼値の刻みに合う価格では、ちょうど同値にできません。',
  no_admissible_price: '価格条件に当てはまる価格がありません。',
}

export function crossingIssueText(issue: CrossingIssue | null): string {
  return issue ? ISSUE_TEXT[issue] : ''
}

function subjectName(subject: CrossingSubject): string {
  return subject.kind === 'close' ? '終値' : `SMA${subject.period}`
}

export function crossingGoalTitle(goal: CrossingGoal, timing: (k: number) => string): string {
  const who = subjectName(goal.subject)
  const ref = `SMA${goal.reference}`
  if (goal.kind === 'touch') return `${timing(goal.bar)}に ${who} が ${ref} にちょうど触れる`
  if (goal.kind === 'relation') return `${timing(goal.bar)}の時点で ${who} が ${ref} より${goal.relation === 'above' ? '上' : '下'}にある`
  return `${goal.within}本以内に ${who} が ${ref} を${goal.direction === 'up' ? '下から上へ' : '上から下へ'}抜ける`
}

/** "98.00 より大きい終値" / "97.50 ちょうど" with the tick-aware nearest value. */
export function describeRequirement(bar: CrossingBar, fmt: PriceFormat, unit: string): string {
  if (bar.status === 'precondition_failed') return crossingIssueText(bar.issue)
  if (bar.status === 'unavailable') return crossingIssueText(bar.issue)
  if (bar.threshold == null || bar.op == null) return ''
  const threshold = fmt(bar.threshold)
  if (bar.status === 'infeasible') {
    return `境界は ${threshold}${unit}。${crossingIssueText(bar.issue)}${bar.neighbours ? ` 最も近い価格: ${bar.neighbours.below != null ? fmt(bar.neighbours.below) : '—'} / ${bar.neighbours.above != null ? fmt(bar.neighbours.above) : '—'}` : ''}`
  }
  if (bar.op === '=') return `${fmt(bar.bound?.value ?? bar.threshold)}${unit} ちょうど`
  const word = bar.op === '>' ? '超える' : '下回る'
  if (bar.bound?.attained) return `${fmt(bar.bound.value)}${unit} 以${bar.op === '>' ? '上' : '下'} (境界 ${threshold}${unit} を${word})`
  return `${threshold}${unit} を${word}終値 (ちょうどは含まない)`
}

export function SmaCrossingPanel({
  result,
  base,
  periods,
  scenarioCloses,
  fmt,
  unit,
  displayUnit,
  onCopyToScenario,
  initialPair = null,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  /** Selected periods; only those with a usable SMA at the as-of bar are offered. */
  periods: ReadonlyArray<SmaLabPeriod>
  /** The user's scenario closes when every future bar is entered, else null. */
  scenarioCloses: ReadonlyArray<number> | null
  fmt: PriceFormat
  unit: string
  displayUnit: number
  onCopyToScenario: (closes: number[]) => void
  /** [short, long] SMA periods to start from (a link's pair): the short SMA crossing the long one. */
  initialPair?: readonly [number, number] | null
}) {
  const id = useId()
  const tf = smaLabTimeframe(result.timeframe)
  const usable = useMemo(
    () => result.periods.filter((summary) => summary.status === 'ok').map((summary) => summary.period),
    [result.periods],
  )
  // The offered lines: the selection first, then every other usable period.
  const options = useMemo(() => [...new Set([...periods.filter((period) => usable.includes(period)), ...usable])], [periods, usable])
  const [kind, setKind] = useState<CrossingGoalKind>('cross')
  const [subjectValue, setSubjectValue] = useState<'close' | number>(initialPair ? initialPair[0] : 'close')
  const [reference, setReference] = useState<number | null>(initialPair ? initialPair[1] : null)
  const [direction, setDirection] = useState<'up' | 'down'>('up')
  const [bars, setBars] = useState(3)
  const [priorSource, setPriorSource] = useState<CrossingPriorSource>('hold')
  const [texts, setTexts] = useState({ minText: '', maxText: '', tickText: '' })

  const referencePeriod = reference != null && options.includes(reference) ? reference : (options.find((period) => period !== subjectValue) ?? null)
  const subject: CrossingSubject = subjectValue === 'close' || !options.includes(subjectValue) ? { kind: 'close' } : { kind: 'sma', period: subjectValue }
  const n = Math.min(Math.max(1, bars), base.horizon)
  const timing = (k: number) => (k === 1 ? `次の${tf.barNoun}` : `${k}本後`)

  const goal = useMemo((): CrossingGoal | null => {
    if (referencePeriod == null) return null
    if (kind === 'cross') return { kind, subject, reference: referencePeriod, within: n, direction }
    if (kind === 'touch') return { kind, subject, reference: referencePeriod, bar: n }
    return { kind, subject, reference: referencePeriod, bar: n, relation: direction === 'up' ? 'above' : 'below' }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subject.kind, subject.kind === 'sma' ? subject.period : 0, referencePeriod, n, direction])

  const parsed = parseConstraints(texts)
  const prior = useMemo(
    () => (priorSource === 'scenario' && scenarioCloses ? [...scenarioCloses] : holdPrior(base, base.horizon)),
    [priorSource, scenarioCloses, base],
  )
  const analysis = useMemo((): CrossingAnalysis | null => (
    goal && isValidCrossingGoal(goal, base.horizon) ? analyzeCrossingGoal(base, goal, prior, parsed.constraints) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [goal, base, prior, JSON.stringify(parsed.constraints)])

  const recommended = analysis?.recommended ?? null
  const example = analysis && recommended ? crossingExamplePath(base, recommended, prior, displayUnit, analysis.domain) : null
  const select = 'h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-[12px] font-bold text-[var(--color-text-primary)] sm:h-8'
  const input = 'h-11 w-20 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-right font-mono text-[12px] tabular-nums sm:h-8'
  const directionOptions = kind === 'relation'
    ? [{ value: 'up' as const, label: '上にいる', title: '選んだ線より上' }, { value: 'down' as const, label: '下にいる', title: '選んだ線より下' }]
    : [{ value: 'up' as const, label: '下から上へ', title: '下にいた状態から上へ抜ける' }, { value: 'down' as const, label: '上から下へ', title: '上にいた状態から下へ抜ける' }]

  if (options.length === 0 || referencePeriod == null) {
    return <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]" data-sma-crossing-empty>この時間軸では計算できるSMAがないため、接触・交差の逆算はできません。時間軸を短くするか、期間の短いSMAを選んでください。</p>
  }

  const barRows = analysis?.bars ?? []
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-sma-crossing-panel>
      <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">
        終値やSMAが別のSMAに触れる・抜けるために必要な終値の条件を、式から正確に求めます。途中の足の終値は下の前提で固定し、その上で「その足の終値がいくら必要か」を答えます。ローソク足の高値・安値は将来分が不明なため、終値だけで判定します。
      </p>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="接触・交差の条件">
        <SegmentedControl
          label="調べること"
          value={kind}
          options={CROSSING_GOAL_KINDS.map((item) => ({ value: item.id, label: item.label, title: item.title }))}
          onChange={setKind}
        />
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          動く側
          <select
            className={select}
            aria-label="動く側 (終値またはSMA)"
            value={subject.kind === 'close' ? 'close' : String(subject.period)}
            onChange={(event) => setSubjectValue(event.target.value === 'close' ? 'close' : Number(event.target.value))}
          >
            <option value="close">終値</option>
            {options.filter((period) => period !== referencePeriod).map((period) => <option key={period} value={period}>SMA{period}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          相手の線
          <select className={select} aria-label="相手のSMA" value={referencePeriod} onChange={(event) => setReference(Number(event.target.value))}>
            {options.filter((period) => subject.kind !== 'sma' || period !== subject.period).map((period) => <option key={period} value={period}>SMA{period}</option>)}
          </select>
        </label>
        {kind !== 'touch' && (
          <SegmentedControl label="向き" value={direction} options={directionOptions} onChange={setDirection} />
        )}
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          {kind === 'cross' ? '何本以内' : '何本後'}
          <select className={select} aria-label="本数 N" value={n} onChange={(event) => setBars(Number(event.target.value))}>
            {Array.from({ length: base.horizon }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}本</option>)}
          </select>
        </label>
        <SegmentedControl
          label="途中の足の前提"
          value={priorSource}
          options={[
            { value: 'hold' as const, label: '価格固定', title: CROSSING_PRIOR_LABEL.hold },
            { value: 'scenario' as const, label: scenarioCloses ? 'シナリオ' : 'シナリオ(未完成)', title: scenarioCloses ? CROSSING_PRIOR_LABEL.scenario : '価格シナリオの全ての足を入力すると選べます' },
          ]}
          onChange={(value) => { if (value === 'hold' || scenarioCloses) setPriorSource(value) }}
        />
      </div>
      {priorSource === 'scenario' && !scenarioCloses && (
        <Callout tone="warn" data-sma-crossing-prior-warning>シナリオの全ての足が入力されていないため、価格固定を使っています。</Callout>
      )}

      <details className="group min-w-0" data-sma-crossing-constraints>
        <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] sm:min-h-7 [&::-webkit-details-marker]:hidden">価格条件 (呼値・下限・上限)</summary>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-1 pt-1">
          {([['tickText', '呼値の刻み', '0.1'], ['minText', '下限', ''], ['maxText', '上限', '']] as const).map(([key, label, placeholder]) => (
            <label key={key} className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              {label}
              <input
                id={`${id}-${key}`}
                className={input}
                inputMode="decimal"
                placeholder={placeholder || '指定なし'}
                value={texts[key]}
                onChange={(event) => setTexts({ ...texts, [key]: event.target.value })}
                aria-invalid={parsed.errors.includes(key === 'tickText' ? 'tick' : key === 'minText' ? 'min' : 'max') ? true : undefined}
              />
            </label>
          ))}
          {parsed.errors.length > 0 && <span className="text-[11px] font-medium text-rose-700" role="status">0より大きい数値で入力してください ({parsed.errors.map((field) => ({ tick: '呼値', min: '下限', max: '上限' })[field]).join('・')})</span>}
        </div>
      </details>

      {goal && analysis ? (
        <section aria-label="接触・交差の結果" className="flex min-w-0 flex-col gap-2" data-sma-crossing-result data-status={analysis.status}>
          <h4 className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]" data-sma-crossing-title>{crossingGoalTitle(goal, timing)}</h4>
          <Conclusion analysis={analysis} fmt={fmt} unit={unit} timing={timing} />
          {barRows.length > 0 && (
            <div className="max-w-full overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border-soft)]">
              <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-sma-crossing-table>
                <caption className="sr-only">各足で必要な終値。途中の足は「{CROSSING_PRIOR_LABEL[priorSource === 'scenario' && scenarioCloses ? 'scenario' : 'hold']}」と仮定</caption>
                <thead>
                  <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
                    <th scope="col" className="py-1 pl-2 pr-2 text-left font-sans font-bold">足</th>
                    <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">日付</th>
                    <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">その足の終値の条件</th>
                    <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">現値比</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-soft)]">
                  {barRows.map((bar) => {
                    const future = result.projection.bars[bar.k - 1]
                    const best = recommended?.k === bar.k
                    return (
                      <tr key={bar.k} data-k={bar.k} data-status={bar.status} className={best ? 'bg-[var(--color-surface-subtle)] font-bold' : undefined}>
                        <th scope="row" className="whitespace-nowrap py-1 pl-2 pr-2 text-left">T+{bar.k}{best && <span className="ml-1 font-sans text-[10px] text-[var(--color-brand-700)]">最小の動き</span>}</th>
                        <td className="whitespace-nowrap px-1.5 py-1 text-[var(--color-text-tertiary)]">{future?.lastSession ?? ''}</td>
                        <td className="px-1.5 py-1 text-left font-sans">{describeRequirement(bar, fmt, unit)}</td>
                        <td className="px-1.5 py-1 text-right">{bar.status === 'feasible' || bar.status === 'infeasible' ? formatPct(bar.pctFromAnchor) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="m-0 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-crossing-premise>
            前提: 途中の足は{CROSSING_PRIOR_LABEL[priorSource === 'scenario' && scenarioCloses ? 'scenario' : 'hold']}。他の途中経路では必要な終値は変わります。これは数学的な条件で、将来の株価を示すものではありません。
          </p>
          {example && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] sm:min-h-8"
                onClick={() => onCopyToScenario(example)}
                data-sma-crossing-copy
              >
                T+{recommended!.k} の境界を通る例をシナリオにコピー
              </button>
              <span className="text-[10px] font-medium text-[var(--color-text-tertiary)]">その足まで前提の経路、以降はその終値のまま。境界が「超える」のときは表示単位 {fmt(displayUnit)} だけ越えた例です。</span>
            </div>
          )}
        </section>
      ) : (
        <Callout>条件を選ぶと結果を表示します。</Callout>
      )}
    </div>
  )
}

function statusWord(analysis: CrossingAnalysis): string {
  if (analysis.natural) return `価格固定のままでも T+${analysis.natural.k} に成立します`
  if (analysis.status === 'feasible') return `T+${analysis.recommended!.k} の終値で成立させられます`
  if (analysis.status === 'infeasible') return '価格条件の範囲では成立させられません'
  if (analysis.status === 'precondition_failed') return 'すでに目標の側にいるため成立しません'
  return '計算できません'
}

function Conclusion({ analysis, fmt, unit, timing }: { analysis: CrossingAnalysis; fmt: PriceFormat; unit: string; timing: (k: number) => string }) {
  const { recommended, natural } = analysis
  if (natural) {
    return (
      <Callout tone="ok" data-sma-crossing-conclusion="natural">
        <b>途中の足の前提だけで成立します。</b> {timing(natural.k)} (T+{natural.k}) に、終値を動かさなくても条件を満たします。
        {recommended && <> さらに、T+{recommended.k} では {describeRequirement(recommended, fmt, unit)} でも成立します。</>}
      </Callout>
    )
  }
  if (recommended) {
    return (
      <Callout tone="ok" data-sma-crossing-conclusion="feasible">
        <b>T+{recommended.k} の終値が {describeRequirement(recommended, fmt, unit)} なら成立します</b> (現値比 {formatPct(recommended.pctFromAnchor)})。
        {analysis.bars.filter((bar) => bar.status === 'feasible').length > 1 && ' 他の足でも成立させられます。下の表は足ごとの条件です。'}
      </Callout>
    )
  }
  return (
    <Callout data-sma-crossing-conclusion={analysis.status}>
      <b>{statusWord(analysis)}。</b> {crossingIssueText(analysis.issue)}
    </Callout>
  )
}
