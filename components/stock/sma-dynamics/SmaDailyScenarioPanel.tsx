'use client'

// One shared DAILY future-close scenario for every timeframe (lib/sma-dynamics-daily-scenario).
// Daily entries are market sessions (T+1 = the next session), not bars of the selected timeframe.
// The same path drives all 15 timeframes; the table shows what each one confirms (every session
// through the bar's last session entered) and what stays provisional. Nothing is filled in.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Eraser, MoveDownRight, MoveUpRight, Snowflake, TrendingDown, TrendingUp } from 'lucide-react'
import { smaLabColor } from '@/lib/sma-dynamics-lab'
import { SMA_LAB_TIMEFRAMES, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import {
  DAILY_SCENARIO_MAX_SESSIONS,
  formatInputNumber,
  parseNumericText,
  SCENARIO_UNITS,
  type DailyScenarioDraft,
} from '@/lib/sma-dynamics-scenario'
import {
  clearDaily,
  convertDailyUnit,
  DAILY_TARGET_DISTRIBUTIONS,
  dailyPresetFlat,
  dailyPresetRate,
  dailyPresetShock,
  dailyPresetTarget,
  describeDailyAdaptation,
  describeDailyBar,
  setDailyInput,
  setDailySessions,
  type DailyAdaptation,
  type DailyProjectedBar,
  type DailyScenarioEvaluation,
  type DailyScenarioProjection,
  type DailyTimeframeProjection,
} from '@/lib/sma-dynamics-daily-scenario'
import { SegmentedControl } from './SmaDynamicsControls'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { Callout } from './SmaSimulationParts'

const EXAMPLE_RATE_PCT = 0.5
const EXAMPLE_SHOCK_PCT = 10
const DEFAULT_TARGET_TEXT = '-10'

export function dailyScenarioStatusText(evaluation: DailyScenarioEvaluation): string {
  const total = evaluation.cells.length
  const list = (ks: number[]) => ks.slice(0, 6).map((k) => `T+${k}`).join(', ') + (ks.length > 6 ? ' ほか' : '')
  if (evaluation.state === 'empty' && evaluation.invalidK.length === 0) {
    return '未入力です。営業日ごとの終値を入力するか、例から始めてください。未入力の日は補完しません。'
  }
  const parts = [`入力 ${evaluation.filled}/${total}営業日`]
  if (evaluation.enteredThrough < evaluation.filled) parts.push(`T+${evaluation.enteredThrough + 1} が未入力のため、その先は仮定・入力完了として扱いません`)
  else if (evaluation.missingK.length > 0) parts.push(`未入力 ${list(evaluation.missingK)}`)
  if (evaluation.invalidK.length > 0) parts.push(`使用できない入力 ${list(evaluation.invalidK)} (数値でない・0以下)`)
  return parts.join(' ・ ')
}

/** Phase of the first bar that still has entered sessions, as one short cell text. */
function barSummaryText(tf: Extract<DailyTimeframeProjection, { status: 'available' }>): string {
  const provisional = tf.provisionalIndex == null ? null : tf.bars[tf.provisionalIndex]
  const parts: string[] = []
  if (tf.confirmedBars > 0) parts.push(`仮定・入力完了 ${tf.confirmedBars}本`)
  if (provisional) parts.push(`仮定・暫定 ${provisional.enteredSessions}/${provisional.requiredSessions}日`)
  return parts.length > 0 ? parts.join(' ・ ') : '入力待ち'
}

function barTitle(bars: ReadonlyArray<DailyProjectedBar>): string {
  return bars.slice(0, 6).map((bar) => `${bar.firstSession.slice(2)}〜${bar.lastSession.slice(2)}: ${describeDailyBar(bar)}`).join('\n')
}

export function DailyTimeframeTable({
  projection,
  period,
  selected,
  fmt,
  onSelect,
}: {
  projection: DailyScenarioProjection
  period: number
  selected: SmaLabTimeframeId
  fmt: PriceFormat
  onSelect?: (timeframe: SmaLabTimeframeId) => void
}) {
  return (
    <div className="min-w-0 overflow-x-auto" data-sma-daily-table>
      <table className="w-full min-w-[320px] border-collapse text-[12px]">
        <caption className="sr-only">同じ日次シナリオを15の時間足へ投影した結果 (SMA {period})</caption>
        <thead>
          <tr className="text-left text-[11px] text-[var(--color-text-tertiary)]">
            <th scope="col" className="py-1 pr-2 font-bold">時間足</th>
            <th scope="col" className="py-1 pr-2 font-bold">足の状態</th>
            <th scope="col" className="py-1 pr-2 text-right font-bold">SMA{period}</th>
            <th scope="col" className="py-1 text-right font-bold">履歴比</th>
          </tr>
        </thead>
        <tbody>
          {projection.timeframes.map((tf) => {
            const meta = SMA_LAB_TIMEFRAMES.find((item) => item.id === tf.timeframe)!
            const isSelected = tf.timeframe === selected
            if (tf.status !== 'available') {
              return (
                <tr key={tf.timeframe} className="border-t border-[var(--color-border-soft)]" data-timeframe={tf.timeframe} data-status="unavailable">
                  <th scope="row" className="py-1 pr-2 text-left font-bold">{meta.label}</th>
                  <td colSpan={3} className="py-1 text-[11px] text-[var(--color-text-tertiary)]">
                    {tf.reason === 'calendar_range' ? '対応カレンダーの範囲外のため計算しません' : 'この時間足の価格履歴が不足しています'}
                  </td>
                </tr>
              )
            }
            const summary = tf.periods.find((item) => item.period === period)
            const anchor = summary?.anchor ?? null
            const confirmed = summary?.latestConfirmed ?? null
            const provisional = summary?.provisional ?? null
            const hasEnteredFuture = tf.confirmedBars > 0 || tf.provisionalIndex != null
            const missingReason = hasEnteredFuture ? '履歴不足' : '入力待ち'
            return (
              <tr
                key={tf.timeframe}
                className={`border-t border-[var(--color-border-soft)] ${isSelected ? 'bg-[var(--color-surface-subtle)]' : ''}`}
                data-timeframe={tf.timeframe}
                data-selected={isSelected || undefined}
                data-confirmed-bars={tf.confirmedBars}
                data-value-kind={provisional != null ? 'provisional' : confirmed != null ? 'confirmed' : hasEnteredFuture ? 'history-insufficient' : 'input-wait'}
                title={barTitle(tf.bars)}
              >
                <th scope="row" className="py-0.5 pr-2 text-left font-bold">
                  {onSelect ? (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onSelect(tf.timeframe)}
                      className="min-h-11 min-w-11 rounded-[var(--radius-sm)] px-1 text-left font-bold text-[var(--color-brand-900)] underline-offset-2 hover:underline sm:min-h-7"
                    >
                      {meta.label}
                    </button>
                  ) : meta.label}
                </th>
                <td className="py-0.5 pr-2 text-[11px] text-[var(--color-text-secondary)]">{barSummaryText(tf)}</td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums">
                  {anchor != null && <span className="block text-[var(--color-text-tertiary)]" data-sma-value-kind="anchor">履歴 {fmt(anchor)}</span>}
                  {confirmed != null && <span className="block" data-sma-value-kind="confirmed">仮定・入力完了 {fmt(confirmed)}</span>}
                  {provisional != null && <span className="block text-amber-700" data-sma-value-kind="provisional">仮定・暫定 {fmt(provisional)}</span>}
                  {confirmed == null && provisional == null && <span className="text-[var(--color-text-tertiary)]" data-sma-value-kind={hasEnteredFuture ? 'history-insufficient' : 'input-wait'}>{missingReason}</span>}
                </td>
                <td className="py-0.5 text-right font-mono tabular-nums">
                  {anchor != null && <span className="block text-[var(--color-text-tertiary)]" data-sma-pct-kind="anchor">基準 0.00%</span>}
                  {confirmed != null && <span className="block" data-sma-pct-kind="confirmed">入力完了 {formatPct(summary?.latestConfirmedPct ?? null)}</span>}
                  {provisional != null && <span className="block text-amber-700" data-sma-pct-kind="provisional">暫定 {formatPct(summary?.provisionalPct ?? null)}</span>}
                  {confirmed == null && provisional == null && <span className="text-[var(--color-text-tertiary)]">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function DailyScenarioPanel({
  projection,
  draft,
  selected,
  periods,
  fmt,
  displayUnit,
  asOfDate,
  anchorClose,
  adaptation,
  applied,
  selectedName,
  onChange,
  onApply,
  onSelectTimeframe,
}: {
  projection: DailyScenarioProjection | null
  draft: DailyScenarioDraft
  selected: SmaLabTimeframeId
  periods: ReadonlyArray<number>
  fmt: PriceFormat
  displayUnit: number
  asOfDate: string
  anchorClose: number
  adaptation: DailyAdaptation | null
  applied: boolean
  selectedName: string
  onChange: (draft: DailyScenarioDraft) => void
  onApply: () => void
  onSelectTimeframe?: (timeframe: SmaLabTimeframeId) => void
}) {
  const id = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const [targetText, setTargetText] = useState(DEFAULT_TARGET_TEXT)
  const [periodChoice, setPeriodChoice] = useState<number | null>(null)
  const target = parseNumericText(targetText)
  const targetOk = typeof target === 'number' && target > -100
  const tablePeriod = periodChoice != null && periods.includes(periodChoice) ? periodChoice : periods[0] ?? 5
  const unitMeta = SCENARIO_UNITS.find((item) => item.id === draft.unit)!
  const selectedMeta = SMA_LAB_TIMEFRAMES.find((item) => item.id === selected)!

  const sessionOptions = useMemo(() => Array.from({ length: DAILY_SCENARIO_MAX_SESSIONS }, (_, i) => i + 1), [])
  const exampleButton = 'inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-8'
  const miniInput = 'h-11 w-24 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-right font-mono text-[16px] sm:h-8 sm:w-16 sm:text-[13px]'

  if (!projection) {
    return (
      <Callout tone="warn" data-sma-daily-unavailable>
        基準日 {asOfDate} の先の営業日が対応カレンダーの範囲外のため、日次シナリオは使えません。
      </Callout>
    )
  }
  const evaluation = projection.evaluation

  const nudge = (k: number, direction: 1 | -1, large: boolean) => {
    const cell = evaluation.cells[k - 1]
    const step = (draft.unit === 'pct' ? 0.1 : displayUnit) * (large ? 10 : 1)
    const current = draft.unit === 'pct' ? (cell.pctFromAnchor ?? 0) : (cell.close ?? anchorClose)
    const next = Math.round((current + direction * step) / step) * step
    onChange(setDailyInput(draft, k, formatInputNumber(next, draft.unit === 'pct' ? 4 : 6)))
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

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-sma-daily-scenario data-sma-daily-sessions={draft.sessions}>
      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-daily-premise>
        基準日 {asOfDate}（終値 {fmt(anchorClose)}）の<strong className="font-bold text-[var(--color-text-secondary)]">次の営業日から</strong>の終値を日次で入力します。
        同じ日次の経路が15の時間足すべてに反映され、時間足を切り替えても入力は残ります。
        足は最終営業日まで入力が揃うと仮定・入力完了となり、途中までは仮定・暫定SMAです。未入力の日は補完しません。
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          入力する営業日数
          <select
            value={draft.sessions}
            onChange={(event) => onChange(setDailySessions(draft, Number(event.target.value)))}
            className="h-11 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-[13px] font-bold text-[var(--color-text-primary)] sm:h-8"
            data-sma-daily-session-count
          >
            {sessionOptions.map((value) => <option key={value} value={value}>{value}営業日</option>)}
          </select>
        </label>
        <SegmentedControl
          label="入力単位"
          value={draft.unit}
          options={SCENARIO_UNITS.map((item) => ({ value: item.id, label: item.label, title: item.title }))}
          onChange={(unit) => onChange(convertDailyUnit(anchorClose, draft, unit))}
        />
      </div>

      <div role="group" aria-label="目標の動きを配分する" className="flex flex-wrap items-center gap-1.5" data-sma-daily-target>
        <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{draft.sessions}営業日で現値比</span>
        <span className="relative">
          <input
            aria-label="目標の変化 (現値比 %)"
            className={`${miniInput} pr-5`}
            inputMode="text"
            enterKeyHint="done"
            value={targetText}
            onChange={(event) => setTargetText(event.target.value)}
            data-sma-daily-target-input
          />
          <span aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-text-tertiary)]">%</span>
        </span>
        {DAILY_TARGET_DISTRIBUTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={exampleButton}
            disabled={!targetOk}
            title={item.title}
            onClick={() => targetOk && onChange(dailyPresetTarget(anchorClose, draft, target, item.id))}
            data-sma-daily-target-preset={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="入力の例" className="flex flex-wrap items-center gap-1.5" data-sma-daily-presets>
        <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">例から始める</span>
        <button type="button" className={exampleButton} onClick={() => onChange(dailyPresetFlat(anchorClose, draft))} title="全営業日を基準日の終値で埋める (価格固定と同じ経路)">
          <Snowflake size={13} aria-hidden="true" />横ばい
        </button>
        <button type="button" className={exampleButton} onClick={() => onChange(dailyPresetRate(anchorClose, draft, EXAMPLE_RATE_PCT))} title={`毎営業日 +${EXAMPLE_RATE_PCT}% ずつ上がる`}>
          <MoveUpRight size={13} aria-hidden="true" />緩やかに上昇
        </button>
        <button type="button" className={exampleButton} onClick={() => onChange(dailyPresetRate(anchorClose, draft, -EXAMPLE_RATE_PCT))} title={`毎営業日 −${EXAMPLE_RATE_PCT}% ずつ下がる`}>
          <MoveDownRight size={13} aria-hidden="true" />緩やかに下落
        </button>
        <button type="button" className={exampleButton} onClick={() => onChange(dailyPresetShock(anchorClose, draft, EXAMPLE_SHOCK_PCT, 1, 'hold'))} title={`翌営業日に一度に +${EXAMPLE_SHOCK_PCT}% 上がり、その水準が続く`}>
          <TrendingUp size={13} aria-hidden="true" />急騰ショック
        </button>
        <button type="button" className={exampleButton} onClick={() => onChange(dailyPresetShock(anchorClose, draft, -EXAMPLE_SHOCK_PCT, 1, 'hold'))} title={`翌営業日に一度に −${EXAMPLE_SHOCK_PCT}% 下がり、その水準が続く`}>
          <TrendingDown size={13} aria-hidden="true" />急落ショック
        </button>
        <button type="button" className={exampleButton} onClick={() => onChange(clearDaily(anchorClose, draft))} disabled={evaluation.state === 'empty' && evaluation.invalidK.length === 0}>
          <Eraser size={13} aria-hidden="true" />クリア
        </button>
      </div>

      <div ref={gridRef} className="grid min-w-0 grid-cols-2 gap-1.5 pr-0.5 sm:max-h-[232px] sm:grid-cols-[repeat(auto-fill,minmax(104px,1fr))] sm:overflow-y-auto" data-sma-daily-inputs>
        {evaluation.cells.map((cell) => {
          const rejected = cell.status === 'invalid' || cell.status === 'non_positive'
          const converted = rejected ? (cell.status === 'invalid' ? '数値でない' : '0以下') : draft.unit === 'pct' ? fmt(cell.close) : formatPct(cell.pctFromAnchor)
          return (
            <label key={cell.k} className="flex min-w-0 flex-col gap-0.5" data-k={cell.k} data-status={cell.status}>
              <span className="flex items-baseline justify-between gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                <span>T+{cell.k}</span>
                <span className="truncate font-mono text-[10px] font-medium text-[var(--color-text-tertiary)]">{cell.date.slice(5)}</span>
              </span>
              <span className="relative block">
                <input
                  id={`${id}-k${cell.k}`}
                  data-k={cell.k}
                  type="text"
                  inputMode={draft.unit === 'pct' ? 'text' : 'decimal'}
                  pattern={draft.unit === 'pct' ? undefined : '[0-9.,]*'}
                  enterKeyHint={cell.k < evaluation.cells.length ? 'next' : 'done'}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${cell.date} (T+${cell.k}営業日) の終値 (${unitMeta.label})`}
                  aria-invalid={rejected || undefined}
                  placeholder="未入力"
                  value={cell.raw}
                  onChange={(event) => onChange(setDailyInput(draft, cell.k, event.target.value))}
                  onKeyDown={(event) => onKeyDown(event, cell.k)}
                  className={`h-11 w-full min-w-0 rounded-[var(--radius-sm)] border bg-white py-0 pl-1.5 text-right font-mono text-[16px] tabular-nums placeholder:font-sans placeholder:text-[11px] placeholder:text-[var(--color-text-tertiary)] sm:h-8 sm:text-[13px] ${draft.unit === 'pct' ? 'pr-5' : 'pr-1.5'} ${
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

      <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]" data-sma-daily-status>
        {dailyScenarioStatusText(evaluation)}
        <span className="block">↑↓キーで {draft.unit === 'pct' ? '0.1%' : fmt(displayUnit)} ずつ、Shift で10倍。Enter で次の営業日へ。</span>
      </p>

      <div className="flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] pt-2.5" data-sma-daily-compare>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h4 className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">全時間足の比較 <span className="font-medium text-[var(--color-text-tertiary)]">同じ日次シナリオ</span></h4>
          {periods.length > 1 && (
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: smaLabColor(tablePeriod) }} />
              SMA
              <select
                value={tablePeriod}
                onChange={(event) => setPeriodChoice(Number(event.target.value))}
                className="h-11 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-[13px] font-bold text-[var(--color-text-primary)] sm:h-8"
                data-sma-daily-table-period
              >
                {periods.map((period) => <option key={period} value={period}>{period}</option>)}
              </select>
            </label>
          )}
        </div>
        <DailyTimeframeTable projection={projection} period={tablePeriod} selected={selected} fmt={fmt} onSelect={onSelectTimeframe} />
        <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
          履歴 = 基準日以前の最終確定足のSMA。仮定・入力完了 = 足の最終営業日まで入力済み。仮定・暫定 = 入力途中の参考SMAで、次の足には使いません。入力待ちと履歴不足は別表示です。将来値はすべて入力シナリオによる仮定で、履歴比はその履歴SMAからの変化です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] pt-2.5" data-sma-daily-apply>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={exampleButton}
            disabled={!adaptation || adaptation.confirmedK.length === 0 || applied}
            onClick={onApply}
            data-sma-daily-apply-button
          >
            選択中の{selectedMeta.name}の入力欄に反映
          </button>
          <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]" data-sma-daily-applied={applied || undefined}>
            {applied ? '反映済み' : '未反映'}
          </span>
        </div>
        <p className="m-0 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
          {adaptation
            ? `${describeDailyAdaptation(adaptation, selectedName)}。反映すると、この足の価格シナリオ・グラフ・SMA逆算の比較は仮定・入力完了となった足の終値だけを使います。`
            : 'この時間足は価格履歴が不足しているため反映できません。'}
        </p>
      </div>
    </div>
  )
}
