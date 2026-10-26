'use client'

// Mode B: forward close scenario. Exact numeric entry per future bar of the selected
// timeframe; the same table shows every visible SMA so chart and numbers never drift.
// Direct entry was chosen over sliders (imprecise at 0.1-unit resolution) and chart
// dragging (not exact). ScenarioEditor (before the chart) is the one place that edits
// the inputs; ScenarioDetails (after the chart) shows the read-only calculation table.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Eraser, MoveDownRight, MoveUpRight, Rows3, Snowflake, TrendingDown, TrendingUp } from 'lucide-react'
import type { SmaLabAvailable, SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import { smaLabTimeframe } from '@/lib/sma-dynamics-timeframes'
import {
  clearScenario,
  convertScenarioUnit,
  evaluateScenario,
  fillMissingForward,
  formatInputNumber,
  parseNumericText,
  presetConstantRate,
  presetFreeze,
  presetLinearTo,
  presetShock,
  SCENARIO_UNITS,
  setScenarioInput,
  smaSteps,
  type ForwardBase,
  type ShockAftermath,
  type ScenarioDraft,
  type ScenarioEvaluation,
} from '@/lib/sma-dynamics-scenario'
import { SegmentedControl } from './SmaDynamicsControls'
import { barPeriodText, formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { ComparisonTable, DirectionGlyph, SmaDot } from './SmaSimulationParts'

export function scenarioStatusText(evaluation: ScenarioEvaluation, horizon: number): string {
  const list = (ks: number[]) => ks.slice(0, 6).map((k) => `T+${k}`).join(', ') + (ks.length > 6 ? ' ほか' : '')
  if (evaluation.state === 'empty' && evaluation.invalidK.length === 0) {
    return '未入力です。将来足ごとの終値を入力するか、一括入力を使ってください。未入力の足は補完しません。'
  }
  const parts = [`入力 ${evaluation.filled}/${horizon}本`]
  if (evaluation.missingK.length > 0) parts.push(`未入力 ${list(evaluation.missingK)}: 補完せず、その足を含む計算窓のSMAは表示しません`)
  if (evaluation.invalidK.length > 0) parts.push(`使用できない入力 ${list(evaluation.invalidK)} (数値でない・0以下)`)
  if (evaluation.state === 'complete' && evaluation.invalidK.length === 0) parts.push('入力のたびにチャートと表を再計算します')
  return parts.join(' ・ ')
}

/** Simple examples: each one is an existing preset, so the numbers match the detailed tools. */
const EXAMPLE_RATE_PCT = 0.5
const EXAMPLE_SHOCK_PCT = 10

export function ScenarioEditor({
  result,
  base,
  draft,
  evaluation,
  fmt,
  displayUnit,
  onChange,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  draft: ScenarioDraft
  evaluation: ScenarioEvaluation
  fmt: PriceFormat
  displayUnit: number
  onChange: (draft: ScenarioDraft) => void
}) {
  const id = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const tf = smaLabTimeframe(result.timeframe)
  const unitMeta = SCENARIO_UNITS.find((item) => item.id === draft.unit)!

  const nudge = (k: number, direction: 1 | -1, large: boolean) => {
    const cell = evaluation.cells[k - 1]
    const step = (draft.unit === 'pct' ? 0.1 : displayUnit) * (large ? 10 : 1)
    const current = draft.unit === 'pct' ? (cell.pctFromAnchor ?? 0) : (cell.close ?? base.anchorClose)
    const next = Math.round((current + direction * step) / step) * step
    onChange(setScenarioInput(draft, k, formatInputNumber(next, draft.unit === 'pct' ? 4 : 6)))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, k: number) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      nudge(k, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      gridRef.current?.querySelector<HTMLInputElement>(`input[data-k="${event.shiftKey ? k - 1 : k + 1}"]`)?.focus()
    }
  }

  const exampleButton = 'inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-8'

  return (
    <div className="flex min-w-0 flex-col gap-2" data-sma-scenario-panel data-sma-scenario-editor>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div role="group" aria-label="入力の例" className="flex flex-wrap items-center gap-1.5" data-sma-scenario-presets>
          <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">例から始める</span>
          <button type="button" className={exampleButton} onClick={() => onChange(presetFreeze(base, draft))} title="全足を基準日の終値で埋める (価格固定と同じ経路)">
            <Snowflake size={13} aria-hidden="true" />横ばい
          </button>
          <button type="button" className={exampleButton} onClick={() => onChange(presetConstantRate(base, draft, EXAMPLE_RATE_PCT))} title={`毎${tf.barNoun} +${EXAMPLE_RATE_PCT}% ずつ上がる`}>
            <MoveUpRight size={13} aria-hidden="true" />緩やかに上昇
          </button>
          <button type="button" className={exampleButton} onClick={() => onChange(presetConstantRate(base, draft, -EXAMPLE_RATE_PCT))} title={`毎${tf.barNoun} −${EXAMPLE_RATE_PCT}% ずつ下がる`}>
            <MoveDownRight size={13} aria-hidden="true" />緩やかに下落
          </button>
          <button type="button" className={exampleButton} onClick={() => onChange(presetShock(base, draft, EXAMPLE_SHOCK_PCT, 1, 'hold'))} title={`次の${tf.barNoun}で一度に +${EXAMPLE_SHOCK_PCT}% 上がり、その水準が続く`} data-sma-shock-example="up">
            <TrendingUp size={13} aria-hidden="true" />急騰ショック
          </button>
          <button type="button" className={exampleButton} onClick={() => onChange(presetShock(base, draft, -EXAMPLE_SHOCK_PCT, 1, 'hold'))} title={`次の${tf.barNoun}で一度に −${EXAMPLE_SHOCK_PCT}% 下がり、その水準が続く`} data-sma-shock-example="down">
            <TrendingDown size={13} aria-hidden="true" />急落ショック
          </button>
          <button type="button" className={exampleButton} onClick={() => onChange(clearScenario(base, draft))} disabled={evaluation.state === 'empty' && evaluation.invalidK.length === 0}>
            <Eraser size={13} aria-hidden="true" />クリア
          </button>
        </div>
        <SegmentedControl
          label="入力単位"
          value={draft.unit}
          options={SCENARIO_UNITS.map((item) => ({ value: item.id, label: item.label, title: item.title }))}
          onChange={(unit) => onChange(convertScenarioUnit(base, draft, unit))}
        />
      </div>

      <div ref={gridRef} className="grid max-h-[232px] min-w-0 grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5 overflow-y-auto pr-0.5" data-sma-scenario-inputs>
        {evaluation.cells.map((cell) => {
          const bar = result.projection.bars[cell.k - 1]
          const rejected = cell.status === 'invalid' || cell.status === 'non_positive'
          const converted = rejected ? (cell.status === 'invalid' ? '数値でない' : '0以下') : draft.unit === 'pct' ? fmt(cell.close) : formatPct(cell.pctFromAnchor)
          return (
            <label key={cell.k} className="flex min-w-0 flex-col gap-0.5" data-k={cell.k} data-status={cell.status}>
              <span className="flex items-baseline justify-between gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                <span>T+{cell.k}</span>
                <span className="truncate font-mono text-[10px] font-medium text-[var(--color-text-tertiary)]">{bar ? barPeriodText(bar).slice(5) : ''}</span>
              </span>
              <span className="relative block">
                <input
                  id={`${id}-k${cell.k}`}
                  data-k={cell.k}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`T+${cell.k} の終値 (${unitMeta.label})`}
                  aria-invalid={rejected || undefined}
                  placeholder="未入力"
                  value={cell.raw}
                  onChange={(event) => onChange(setScenarioInput(draft, cell.k, event.target.value))}
                  onKeyDown={(event) => onKeyDown(event, cell.k)}
                  className={`h-11 w-full min-w-0 rounded-[var(--radius-sm)] border bg-white py-0 pl-1.5 text-right font-mono text-[13px] tabular-nums placeholder:font-sans placeholder:text-[11px] placeholder:text-[var(--color-text-tertiary)] sm:h-8 ${draft.unit === 'pct' ? 'pr-5' : 'pr-1.5'} ${
                    rejected ? 'border-rose-400 bg-rose-50' : cell.status === 'missing' ? 'border-dashed border-[var(--color-border-strong)]' : 'border-[var(--color-border-default)]'
                  }`}
                />
                {draft.unit === 'pct' && <span aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-text-tertiary)]">%</span>}
              </span>
              <span className={`h-3.5 truncate text-right font-mono text-[10px] tabular-nums ${rejected ? 'text-rose-700' : 'text-[var(--color-text-tertiary)]'}`}>
                {cell.status === 'missing' ? '' : `${draft.unit === 'pct' ? '= ' : ''}${converted}`}
              </span>
            </label>
          )
        })}
      </div>

      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-scenario-status>
        {scenarioStatusText(evaluation, base.horizon)}
        <span className="block">↑↓キーで {draft.unit === 'pct' ? '0.1%' : fmt(displayUnit)} ずつ、Shift で10倍。Enter で次の足へ。</span>
      </p>
    </div>
  )
}

export function ScenarioDetails({
  result,
  base,
  draft,
  evaluation,
  periods,
  fmt,
  onChange,
}: {
  result: SmaLabAvailable
  base: ForwardBase
  draft: ScenarioDraft
  evaluation: ScenarioEvaluation
  periods: readonly SmaLabPeriod[]
  fmt: PriceFormat
  onChange: (draft: ScenarioDraft) => void
}) {
  const [rate, setRate] = useState('1')
  const [target, setTarget] = useState('5')
  const [shock, setShock] = useState('-10')
  const [shockBar, setShockBar] = useState('1')
  const [aftermath, setAftermath] = useState<ShockAftermath>('hold')
  const tf = smaLabTimeframe(result.timeframe)
  const horizon = base.horizon
  const shown = result.periods.filter((summary) => summary.status === 'ok' && periods.includes(summary.period)).map((summary) => summary.period)
  const steps = useMemo(
    () => new Map(shown.map((period) => [period, smaSteps(base, evaluation.closes, period)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, evaluation.closes, shown.join(',')],
  )
  const lastConfirmed = result.lastConfirmedIndex
  const unitMeta = SCENARIO_UNITS.find((item) => item.id === draft.unit)!
  const rateValue = parseNumericText(rate)
  const targetValue = parseNumericText(target)
  const shockValue = parseNumericText(shock)
  const shockBarValue = parseNumericText(shockBar)
  const shockBarOk = typeof shockBarValue === 'number' && Number.isInteger(shockBarValue) && shockBarValue >= 1 && shockBarValue <= horizon
  const scenarioComparisons = useMemo(() => [
    { id: 'freeze', label: '横ばい', title: '全足を基準日の終値で固定', evaluation: evaluateScenario(base, presetFreeze(base, draft)) },
    { id: 'rise', label: '上昇', title: `毎${tf.barNoun} +${EXAMPLE_RATE_PCT}%`, evaluation: evaluateScenario(base, presetConstantRate(base, draft, EXAMPLE_RATE_PCT)) },
    { id: 'fall', label: '下落', title: `毎${tf.barNoun} -${EXAMPLE_RATE_PCT}%`, evaluation: evaluateScenario(base, presetConstantRate(base, draft, -EXAMPLE_RATE_PCT)) },
    { id: 'shock-up', label: '急騰', title: `T+1で +${EXAMPLE_SHOCK_PCT}%、以後その水準`, evaluation: evaluateScenario(base, presetShock(base, draft, EXAMPLE_SHOCK_PCT, 1, 'hold')) },
    { id: 'shock-down', label: '急落', title: `T+1で -${EXAMPLE_SHOCK_PCT}%、以後その水準`, evaluation: evaluateScenario(base, presetShock(base, draft, -EXAMPLE_SHOCK_PCT, 1, 'hold')) },
    { id: 'scenario', label: '入力中', title: '現在入力している将来終値', evaluation },
  ], [base, draft, evaluation, tf.barNoun])

  const toolButton = 'inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-7'
  const miniInput = 'h-11 w-14 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-right font-mono text-[11px] tabular-nums sm:h-7'

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-sma-scenario-details>
      <div role="group" aria-label="細かい一括入力" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          毎本
          <input aria-label="毎本の変化率 (%)" className={miniInput} inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
          %
          <button type="button" className={toolButton} disabled={typeof rateValue !== 'number'} onClick={() => typeof rateValue === 'number' && onChange(presetConstantRate(base, draft, rateValue))}>適用</button>
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          T+{horizon}で
          <input aria-label={`T+${horizon} の現値比 (%) まで線形に変化`} className={miniInput} inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} />
          %まで線形
          <button type="button" className={toolButton} disabled={typeof targetValue !== 'number'} onClick={() => typeof targetValue === 'number' && onChange(presetLinearTo(base, draft, targetValue))}>適用</button>
        </span>
        <span className="inline-flex flex-wrap items-center gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]" role="group" aria-label="ショック (1回だけの急変)" data-sma-shock-tool>
          T+
          <input aria-label="ショックを起こす足 (T+k)" className={miniInput} inputMode="numeric" value={shockBar} onChange={(event) => setShockBar(event.target.value)} />
          で
          <input aria-label="ショックの大きさ (現値比 %)" className={miniInput} inputMode="decimal" value={shock} onChange={(event) => setShock(event.target.value)} />
          %
          <SegmentedControl
            label="ショック後"
            hideLabel
            value={aftermath}
            options={[{ value: 'hold' as const, label: 'そのまま', title: '新しい水準が続く' }, { value: 'revert' as const, label: '元へ戻る', title: '最後の足に向けて現値へ直線で戻る' }]}
            onChange={setAftermath}
          />
          <button type="button" className={toolButton} disabled={typeof shockValue !== 'number' || !shockBarOk || shockValue <= -100} onClick={() => typeof shockValue === 'number' && shockBarOk && onChange(presetShock(base, draft, shockValue, shockBarValue, aftermath))}>適用</button>
        </span>
        <button type="button" className={toolButton} onClick={() => onChange(fillMissingForward(base, draft))} disabled={evaluation.missingK.length === 0} title="未入力の足に直前の足の終値を入れる (明示操作のときだけ補完します)">
          <Rows3 size={12} aria-hidden="true" />未入力を直前の値で埋める
        </button>
      </div>

      <div className="max-h-[420px] max-w-full overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border-soft)]">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-sma-scenario-table>
          <caption className="sr-only">
            将来の{tf.name}ごとの仮定終値と、それを使って再計算したSMA。基準値は {result.asOf.date} の終値 {fmt(base.anchorClose)}。矢印は直前の足のSMAとの比較。
          </caption>
          <thead className="sticky top-0 z-[1] bg-white">
            <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
              <th scope="col" className="py-1 pl-2 pr-2 text-left font-sans font-bold">足</th>
              <th scope="col" className="px-1 py-1 text-left font-sans font-bold">期間</th>
              <th scope="col" className="px-1 py-1 text-right font-sans font-bold">終値</th>
              <th scope="col" className="px-1 py-1 text-right font-sans font-bold">現値比</th>
              {shown.map((period) => (
                <th key={period} scope="col" className="px-1.5 py-1 text-right font-bold">
                  <span className="inline-flex items-center gap-1"><SmaDot period={period} />SMA{period}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            <tr className="bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]" data-k="0">
              <th scope="row" style={{ background: 'transparent' }} className="whitespace-nowrap py-1 pl-2 pr-2 text-left font-sans font-bold">基準</th>
              <td className="whitespace-nowrap px-1 py-1">{result.asOf.date}</td>
              <td className="px-1 py-1 text-right">{fmt(base.anchorClose)}</td>
              <td className="px-1 py-1 text-right">0.00%</td>
              {shown.map((period) => (
                <td key={period} className="px-1.5 py-1 text-right" title="最終確定足のSMA">{fmt(lastConfirmed == null ? null : result.sma[period][lastConfirmed])}</td>
              ))}
            </tr>
            {evaluation.cells.map((cell) => {
              const bar = result.projection.bars[cell.k - 1]
              const rejected = cell.status === 'invalid' || cell.status === 'non_positive'
              return (
                <tr key={cell.k} data-k={cell.k} data-status={cell.status}>
                  <th scope="row" style={{ background: 'transparent' }} className="whitespace-nowrap py-1 pl-2 pr-2 text-left font-medium text-[var(--color-text-secondary)]">
                    T+{cell.k}
                    {bar?.completesForming && <span className="ml-1 font-sans text-[10px] text-amber-700">未確定足の確定</span>}
                  </th>
                  <td className="whitespace-nowrap px-1 py-1 text-[var(--color-text-tertiary)]">{bar ? barPeriodText(bar) : ''}</td>
                  <td className="px-1 py-1 text-right">{rejected ? <span className="font-sans text-[10px] text-rose-700">{cell.status === 'invalid' ? '数値でない' : '0以下'}</span> : cell.status === 'missing' ? <span className="font-sans text-[10px] text-[var(--color-text-tertiary)]">未入力</span> : fmt(cell.close)}</td>
                  <td className="px-1 py-1 text-right text-[var(--color-text-secondary)]">{cell.close == null ? '—' : formatPct(cell.pctFromAnchor)}</td>
                  {shown.map((period) => {
                    const step = steps.get(period)?.[cell.k - 1]
                    return (
                      <td key={period} className="whitespace-nowrap px-1.5 py-1 text-right text-[var(--color-text-primary)]" title={step?.sma == null ? '計算窓に未入力の足があるため計算しません' : undefined}>
                        {fmt(step?.sma ?? null)} <DirectionGlyph direction={step?.direction ?? null} displayFlat={step?.displayFlat} />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        T+k は次の確定{tf.barNoun}k本目の終値です。↑→↓ は直前の足のSMAとの比較 (→ は厳密に同値、≈ は表示上の横ばい)。入力単位は {unitMeta.label}。ローソク足は作らず、仮定終値は線で表示します。
      </p>

      <div className="max-w-full overflow-x-auto" data-sma-scenario-comparison>
        <div className="min-w-[980px]">
          <ComparisonTable
            result={result}
            periods={periods}
            fmt={fmt}
            caption="複数シナリオ比較 (同じ基準日・時間足・将来本数)"
            columns={scenarioComparisons.map((item) => ({
              id: item.id,
              label: item.label,
              title: item.title,
              sma: item.evaluation.sma,
              missingNote: item.id === 'scenario' ? '未入力の足を含むため計算しません' : undefined,
            }))}
          />
        </div>
      </div>
      <p className="m-0 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        横ばい・毎本±{EXAMPLE_RATE_PCT}%・T+1で±{EXAMPLE_SHOCK_PCT}%後に水準維持を、同じ条件で再計算しています。チャートは「入力中」と価格固定を表示します。
      </p>
    </div>
  )
}
