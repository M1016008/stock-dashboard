'use client'

// Phase 3B: scenario evidence picker (normal templates + collapsed developer fixtures),
// origin badge, Scenario Analysis header, assumed-close table and provenance details. Presentational and fetch-free; validation and the SMA adapter live in
// lib/sma-dynamics-scenario-evidence. Origin is always stated in text plus an icon and
// a border pattern, never by colour alone.
import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, FlaskConical, History, Layers3, Network, PencilLine, ScanLine, ScanSearch, Snowflake, Target, Wrench, X, type LucideIcon } from 'lucide-react'
import { smaLabTimeframe } from '@/lib/sma-dynamics-timeframes'
import {
  describePriceBasis,
  describeQuantitativeClaim,
  displayableClaim,
  HANDOFF_NOT_SOLVER_NOTE,
  handoffComparisonLabel,
  handoffScopeText,
  handoffSolverLead,
  isStandardScenarioEntry,
  isUsableScenarioEntry,
  isViewAlignable,
  originVersionText,
  pathEndChangePct,
  SCENARIO_CLEAR_LABEL,
  SCENARIO_DIRECTION_LABEL,
  SCENARIO_DIRECTIONS,
  SCENARIO_DRAFT_KEPT_NOTE,
  SCENARIO_ISSUE_TEXT,
  SCENARIO_ORIGIN_COPY,
  SCENARIO_TEMPLATE_LIST_NOTE,
  SCENARIO_TEMPLATE_NOTE,
  scenarioDirectionCounts,
  scenarioSelectionHeadline,
  scenarioShapeText,
  SOLVER_REPRESENTATIVE_PATH_LABEL,
  type HandoffPathOrigin,
  type HandoffPathState,
  type ScenarioDirectionCount,
  type ScenarioDirection,
  type ScenarioEvidenceEntry,
  type ScenarioEvidenceEnvelope,
  type ScenarioHandoffRecord,
  type ScenarioOrigin,
  type ScenarioOriginKind,
  type ScenarioSelectionCause,
} from '@/lib/sma-dynamics-scenario-evidence'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { Callout } from './SmaSimulationParts'

export const SMA_SCENARIO_EVIDENCE_TITLE = 'この株価の動きを仮定すると、移動平均線はどうなる？'
export const SMA_SCENARIO_EVIDENCE_INTRO = 'シナリオを1つ選ぶと、その終値でSMAを再計算してチャートに重ねます。由来は各シナリオに表示します。'
export const SMA_SCENARIO_EVIDENCE_PREMISE = '破線は、選んだシナリオの将来の終値 (選択した足の確定終値) で実際のローリング窓を再計算したSMAです。シナリオは仮定であり、将来の株価を示すものではありません。'

/** Icon and border pattern per origin family: rule-made (dashed), data-derived (dotted), model (double), user/calculation (solid). */
const ORIGIN_STYLE: Record<ScenarioOriginKind, { Icon: LucideIcon; border: string; family: string }> = {
  deterministic_template: { Icon: Layers3, border: 'border-dashed', family: 'rule' },
  explanatory_synthetic: { Icon: FlaskConical, border: 'border-dashed', family: 'rule' },
  historical_analog: { Icon: History, border: 'border-dotted', family: 'data' },
  model_classification: { Icon: ScanLine, border: 'border-double border-[3px]', family: 'model' },
  model_path_distribution: { Icon: Network, border: 'border-double border-[3px]', family: 'model' },
  user_input: { Icon: PencilLine, border: 'border-solid', family: 'user' },
  price_freeze: { Icon: Snowflake, border: 'border-solid', family: 'user' },
  inverse_solver_result: { Icon: Target, border: 'border-solid', family: 'user' },
}

const DIRECTION_ICON: Record<ScenarioDirection, LucideIcon> = { up: ArrowUpRight, range: ArrowRight, down: ArrowDownRight }

export function ScenarioOriginBadge({ origin }: { origin: Pick<ScenarioOrigin, 'kind'> }) {
  const copy = SCENARIO_ORIGIN_COPY[origin.kind]
  const { Icon, border, family } = ORIGIN_STYLE[origin.kind]
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] border ${border} border-[var(--color-border-strong)] bg-white px-1.5 py-px text-[10px] font-bold leading-4 text-[var(--color-text-secondary)]`}
      title={`由来: ${copy.label}`}
      data-scenario-origin={origin.kind}
      data-scenario-origin-family={family}
    >
      <Icon size={11} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 break-words"><span className="sr-only">由来: </span>{copy.tag}</span>
    </span>
  )
}

function entryStatus(entry: ScenarioEvidenceEntry, fmtBars: (bars: number) => string): { text: string; state: 'projectable' | 'no_path' | 'alignable' | 'rejected' } {
  const { validation } = entry
  if (validation.status === 'projectable') {
    // The end change is a property of the assumed path, so it is worded as such (not as an outcome).
    return { text: `${fmtBars(validation.envelope.forecastHorizonBars)} ・ 仮定の終点 T+${validation.envelope.forecastHorizonBars} 基準日比 ${formatPct(pathEndChangePct(validation))}`, state: 'projectable' }
  }
  if (validation.status === 'no_path') return { text: validation.reason === 'classification_only' ? '経路なし (方向スコアのみ)' : '経路なし', state: 'no_path' }
  if (isViewAlignable(validation) && validation.envelope) {
    return { text: `${smaLabTimeframe(validation.envelope.forecastTimeframe).name}で作成 ・ 時間軸を合わせると表示できます`, state: 'alignable' }
  }
  return { text: `表示できません: ${SCENARIO_ISSUE_TEXT[validation.issues[0]?.code ?? 'malformed']}`, state: 'rejected' }
}

function envelopeOf(entry: ScenarioEvidenceEntry): ScenarioEvidenceEnvelope | null {
  return entry.validation.envelope
}

const DEVELOPER_GROUPS = [
  { state: 'projectable', label: '経路があり表示できる (テンプレート以外の由来)' },
  { state: 'alignable', label: '時間軸・本数を合わせると表示できる' },
  { state: 'no_path', label: '経路がない (SMAは計算しない)' },
  { state: 'rejected', label: '表示できない (検証で不合格)' },
] as const

const GROUP_LIST = 'm-0 grid min-w-0 list-none gap-1 p-0 sm:grid-cols-2 xl:grid-cols-3'
/** One column at phone width; label/value columns from sm upward. Values wrap anywhere (ids, provenance). */
const FACT_GRID = 'm-0 grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-y-1'
const FACT_VALUE = 'm-0 mb-1 min-w-0 break-words [overflow-wrap:anywhere] sm:mb-0'

/** Direction button count: the plain total when all are usable, otherwise usable / total / blocked. */
export function directionCountText(count: ScenarioDirectionCount): { visible: string; accessible: string } {
  if (count.blocked === 0) return { visible: `${count.total}`, accessible: `${count.total}件` }
  return {
    visible: `利用可能${count.usable} / 全${count.total}、利用不可${count.blocked}`,
    accessible: `利用可能${count.usable}件 / 全${count.total}件、利用不可${count.blocked}件`,
  }
}

export function ScenarioEvidencePicker({
  entries,
  direction,
  selectedId,
  disabled,
  barNoun,
  onDirection,
  onSelect,
}: {
  entries: ReadonlyArray<ScenarioEvidenceEntry>
  direction: ScenarioDirection
  selectedId: string | null
  disabled: boolean
  barNoun: string
  onDirection: (direction: ScenarioDirection) => void
  onSelect: (id: string) => void
}) {
  const fmtBars = (bars: number) => `${barNoun}${bars}本`
  // Normal list and counts: standard deterministic templates only. Everything else is developer-only.
  const standard = entries.filter(isStandardScenarioEntry)
  const developer = entries.filter((entry) => !standard.includes(entry))
  const inDirection = standard.filter((entry) => entry.direction === direction)
  const usable = inDirection.filter(isUsableScenarioEntry)
  const blocked = inDirection.filter((entry) => !usable.includes(entry))
  // Candidates without a readable direction (malformed or direction unavailable) are never hidden: developer panel, every tab.
  const undirected = developer.filter((entry) => entry.direction == null)
  const developerDirected = developer.filter((entry) => entry.direction != null)
  const developerSelected = developer.some((entry) => entry.candidate.id === selectedId)
  const counts = scenarioDirectionCounts(entries)
  const option = (entry: ScenarioEvidenceEntry) => {
    const envelope = envelopeOf(entry)
    const status = entryStatus(entry, fmtBars)
    const selected = entry.candidate.id === selectedId
    const isStandard = standard.includes(entry)
    const shape = isStandard ? scenarioShapeText(envelope) : null
    return (
      <li key={entry.candidate.id} className="min-w-0">
        <button
          type="button"
          aria-pressed={selected}
          disabled={disabled}
          onClick={() => onSelect(entry.candidate.id)}
          data-scenario-candidate={entry.candidate.id}
          data-scenario-status={status.state}
          className={`flex min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-9 ${
            selected ? 'border-[var(--color-brand-900)] bg-[var(--color-surface-subtle)] shadow-[inset_3px_0_0_var(--color-brand-900)]' : 'border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]'
          }`}
        >
          <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 text-[12px] font-bold text-[var(--color-text-primary)]">{selected && <span aria-hidden="true">✓ </span>}{entry.candidate.label}</span>
            {envelope && <ScenarioOriginBadge origin={envelope.origin} />}
            {entry.direction && !isStandard && <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{SCENARIO_DIRECTION_LABEL[entry.direction]}</span>}
          </span>
          {shape && <span className="text-[11px] font-medium text-[var(--color-text-secondary)]" data-scenario-shape>{shape}</span>}
          <span className={`text-[11px] font-medium tabular-nums ${status.state === 'projectable' ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-tertiary)]'}`}>
            {status.state === 'rejected' && <span aria-hidden="true">⊘ </span>}
            {status.state === 'no_path' && <span aria-hidden="true">— </span>}
            {status.text}
          </span>
        </button>
      </li>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-scenario-picker>
      <div role="group" aria-label="値動きの方向 (仮定の種類)" className="flex min-w-0 flex-wrap items-center gap-1" data-scenario-directions>
        {SCENARIO_DIRECTIONS.map((id) => {
          const Icon = DIRECTION_ICON[id]
          const count = counts[id]
          const countText = directionCountText(count)
          const on = id === direction
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              aria-label={`${SCENARIO_DIRECTION_LABEL[id]}の仮定 ${countText.accessible}`}
              disabled={disabled}
              data-scenario-direction={id}
              data-scenario-direction-count={count.total}
              data-scenario-direction-usable={count.usable}
              data-scenario-direction-blocked={count.blocked}
              onClick={() => onDirection(id)}
              className={`inline-flex min-h-11 max-w-full flex-wrap items-center gap-x-1 rounded-[var(--radius-sm)] border px-2.5 py-1 text-left text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-8 ${
                on ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-primary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              <Icon size={13} aria-hidden="true" />
              {SCENARIO_DIRECTION_LABEL[id]}
              <span aria-hidden="true" className={`text-[11px] font-medium tabular-nums ${count.blocked === 0 ? 'font-mono' : ''} ${on ? 'text-white/80' : 'text-[var(--color-text-tertiary)]'}`} data-scenario-direction-count-text>{countText.visible}</span>
            </button>
          )
        })}
      </div>
      {inDirection.length === 0 ? (
        <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">この方向のシナリオはありません。</p>
      ) : (
        <ul className={GROUP_LIST} aria-label={`${SCENARIO_DIRECTION_LABEL[direction]}の仮定シナリオ`} data-scenario-standard-list>
          {usable.map(option)}
        </ul>
      )}
      {standard.length > 0 && <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]" data-scenario-list-note>{SCENARIO_TEMPLATE_LIST_NOTE}</p>}
      {blocked.length > 0 && (
        <details className="group min-w-0" data-scenario-blocked>
          <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)] sm:min-h-7 [&::-webkit-details-marker]:hidden">
            <ArrowRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
            表示できないシナリオ ({blocked.length}件)
          </summary>
          <ul className={`${GROUP_LIST} pt-1`}>{blocked.map(option)}</ul>
        </details>
      )}
      {developer.length > 0 && (
        // Collapsed by default; opened only while one of its fixtures is the current selection.
        <details className="group min-w-0 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)]" open={developerSelected || undefined} data-scenario-developer>
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 text-[11px] font-bold text-[var(--color-text-secondary)] sm:min-h-8 [&::-webkit-details-marker]:hidden">
            <ArrowRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
            <Wrench size={12} aria-hidden="true" className="shrink-0" />
            開発者向け: 検証用のシナリオ ({developer.length}件)
            <span className="font-medium text-[var(--color-text-tertiary)]">通常の一覧と件数には含めません</span>
          </summary>
          <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border-soft)] px-2 pb-2 pt-1.5">
            {DEVELOPER_GROUPS.map((group) => {
              const items = developerDirected.filter((entry) => entryStatus(entry, fmtBars).state === group.state)
              return items.length > 0 && (
                <div key={group.state} className="flex min-w-0 flex-col gap-1" data-scenario-developer-group={group.state}>
                  <p className="m-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{group.label}</p>
                  <ul className={GROUP_LIST} aria-label={group.label}>{items.map(option)}</ul>
                </div>
              )
            })}
            {undirected.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1" data-scenario-undirected>
                <p className="m-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">方向の情報がないシナリオ ({undirected.length}件)</p>
                <ul className={GROUP_LIST} aria-label="方向の情報がないシナリオ">{undirected.map(option)}</ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

/** The draft is kept while a selection is not drawn; the clear action brings it back unchanged. */
function DraftKeptClear({ onClear }: { onClear?: () => void }) {
  if (!onClear) return null
  return (
    <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-scenario-draft-kept>
      <span>{SCENARIO_DRAFT_KEPT_NOTE}</span>
      <button type="button" className="btn max-sm:min-h-11!" data-size="sm" onClick={onClear} data-scenario-clear>
        <X size={13} aria-hidden="true" />{SCENARIO_CLEAR_LABEL}
      </button>
    </span>
  )
}

/**
 * Why a selected scenario is not drawn, and the explicit view change that would allow it.
 * Nothing else is drawn in its place: not the user's draft, not its result.
 */
export function ScenarioEvidenceStatus({ entry, onAlign, onClear }: { entry: ScenarioEvidenceEntry; onAlign: (envelope: ScenarioEvidenceEnvelope) => void; onClear?: () => void }) {
  const { validation } = entry
  if (validation.status === 'projectable') return null
  if (validation.status === 'no_path') {
    const shownClaim = displayableClaim(validation.envelope)
    const claim = shownClaim ? describeQuantitativeClaim(shownClaim) : null
    return (
      <Callout role="status" data-scenario-selected-status="no_path" data-scenario-selection-cause={validation.reason}>
        <b>{validation.reason === 'classification_only' ? SCENARIO_ORIGIN_COPY.model_classification.premise : '将来価格の経路は未提供'}</b>。経路を作らないため、SMAは計算しません。
        {claim && <> {claim.label} {claim.value} ({claim.meaning})。</>}
        <DraftKeptClear onClear={onClear} />
      </Callout>
    )
  }
  if (isViewAlignable(validation) && validation.envelope) {
    const envelope = validation.envelope
    const tf = smaLabTimeframe(envelope.forecastTimeframe)
    return (
      <Callout role="status" data-scenario-selected-status="alignable" data-scenario-selection-cause="view_mismatch">
        <span className="mr-2">このシナリオは {tf.name} ({tf.label}) の{envelope.forecastHorizonBars}本で作られています。経路は別の時間軸・本数に変換しないため、表示を切り替えるまでチャートと結果には何も重ねません。</span>
        <button type="button" className="inline-flex items-center font-bold text-[var(--color-brand-700)] underline underline-offset-2 max-sm:min-h-11" onClick={() => onAlign(envelope)} data-scenario-align>
          表示を {tf.label}・{envelope.forecastHorizonBars}本に切り替える
        </button>
        <DraftKeptClear onClear={onClear} />
      </Callout>
    )
  }
  return (
    <Callout role="status" tone="warn" data-scenario-selected-status="rejected" data-scenario-selection-cause="rejected">
      <b data-scenario-selection-headline>{scenarioSelectionHeadline({ kind: 'rejected', issues: validation.issues })}。</b>SMAの計算には使いません。
      <ul className="m-0 mt-0.5 list-disc pl-4">
        {validation.issues.map((issue) => (
          <li key={`${issue.code}|${issue.field}`} data-scenario-issue={issue.code}>
            {SCENARIO_ISSUE_TEXT[issue.code]}{issue.detail ? <span className="font-mono text-[10px]"> ({issue.detail})</span> : null}
          </li>
        ))}
      </ul>
      <DraftKeptClear onClear={onClear} />
    </Callout>
  )
}

/** A selection with no candidate or validation behind it (list changed, history pending, adapter refused). */
export function ScenarioSelectionUnavailable({ cause, onClear }: { cause: ScenarioSelectionCause; onClear: () => void }) {
  return (
    <Callout role="status" tone="warn" data-scenario-selected-status="unavailable" data-scenario-selection-cause={cause.kind}>
      <b data-scenario-selection-headline>{scenarioSelectionHeadline(cause)}。</b>
      <DraftKeptClear onClear={onClear} />
    </Callout>
  )
}

export const SCENARIO_ANALYSIS_KICKER = 'シナリオ分析中'
export const SCENARIO_ANALYSIS_NAME_LABEL = '仮定したシナリオ'

/** Dynamic heading of the Scenario Analysis state; always names the assumption, never an outcome. */
export function scenarioAnalysisTitle(name: string): string {
  return `「${name}」なら、移動平均線はどう動く？`
}

/** Screen-reader announcement when the Scenario Analysis state starts or ends. */
export function scenarioAnalysisAnnouncement(name: string | null): string {
  return name ? `${SCENARIO_ANALYSIS_KICKER}: ${name}。結果とチャートを更新しました。` : ''
}

/**
 * Scenario Analysis state header: what is assumed, how it was made (rule, not a model),
 * and reversible next steps. Rendered only while a projectable scenario is drawn.
 */
export function ScenarioAnalysisHeader({
  titleId,
  name,
  envelope,
  barCount,
  barNoun,
  fmt,
  freezeCompared,
  onEdit,
  onSolve,
  onToggleFreeze,
  onClear,
}: {
  titleId: string
  name: string
  envelope: ScenarioEvidenceEnvelope
  barCount: number
  barNoun: string
  fmt: PriceFormat
  freezeCompared: boolean
  onEdit: () => void
  onSolve: () => void
  onToggleFreeze: () => void
  onClear: () => void
}) {
  const copy = SCENARIO_ORIGIN_COPY[envelope.origin.kind]
  const shape = scenarioShapeText(envelope)
  const template = envelope.origin.kind === 'deterministic_template'
  return (
    <section
      aria-labelledby={titleId}
      // Programmatic focus target when the control that started the analysis unmounts.
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border-2 border-[var(--color-brand-900)] bg-white px-3 py-2.5 outline-none"
      data-scenario-analysis={envelope.origin.kind}
    >
      <p className="m-0 inline-flex w-fit items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-brand-900)] px-1.5 py-px text-[11px] font-bold text-white" data-scenario-analysis-kicker>
        <ScanSearch size={12} aria-hidden="true" />{SCENARIO_ANALYSIS_KICKER}
      </p>
      <h3 id={titleId} className="m-0 text-[15px] font-bold leading-6 text-[var(--color-text-primary)]" data-scenario-analysis-title>{scenarioAnalysisTitle(name)}</h3>
      <dl className={`${FACT_GRID} text-[12px]`} data-scenario-analysis-facts>
        <dt className="m-0 font-bold text-[var(--color-text-tertiary)]">{SCENARIO_ANALYSIS_NAME_LABEL}</dt>
        <dd className={`${FACT_VALUE} flex flex-wrap items-center gap-1.5 font-bold text-[var(--color-text-primary)]`} data-scenario-analysis-name>
          {name}<ScenarioOriginBadge origin={envelope.origin} />
        </dd>
        {shape && (
          <>
            <dt className="m-0 font-bold text-[var(--color-text-tertiary)]">経路の形</dt>
            <dd className={`${FACT_VALUE} font-medium text-[var(--color-text-secondary)]`}>{shape}</dd>
          </>
        )}
        <dt className="m-0 font-bold text-[var(--color-text-tertiary)]">起点と本数</dt>
        <dd className={`${FACT_VALUE} font-medium tabular-nums text-[var(--color-text-secondary)]`}>基準日 {envelope.asOfDate} の終値 {fmt(envelope.predictionReferencePrice)} から {barNoun}{barCount}本</dd>
      </dl>
      <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]" data-scenario-premise>
        <b className="text-[var(--color-text-primary)]">{copy.premise}</b>のSMAです。
        {template
          ? <span className="block text-[11px] text-[var(--color-text-tertiary)]" data-scenario-template-note>作り方: {SCENARIO_TEMPLATE_NOTE}</span>
          : <span className="block text-[11px] text-[var(--color-text-tertiary)]" data-scenario-origin-note>由来: {copy.label} ({originVersionText(envelope.origin)})</span>}
      </p>
      <div role="group" aria-label="このシナリオで続ける" className="flex min-w-0 flex-wrap items-center gap-1.5" data-scenario-handoff>
        <button type="button" className="btn max-sm:min-h-11!" data-size="sm" onClick={onEdit} data-scenario-handoff-target="scenario">
          <PencilLine size={13} aria-hidden="true" />この経路を編集する
        </button>
        <button type="button" className="btn max-sm:min-h-11!" data-size="sm" onClick={onSolve} data-scenario-handoff-target="solver">
          <Target size={13} aria-hidden="true" />この経路で逆算と比べる
        </button>
        <button type="button" className="btn max-sm:min-h-11!" data-size="sm" aria-pressed={freezeCompared} onClick={onToggleFreeze} data-scenario-compare-freeze>
          <Snowflake size={13} aria-hidden="true" />{freezeCompared && <span aria-hidden="true">✓ </span>}価格固定と重ねる
        </button>
        <button type="button" className="btn max-sm:min-h-11!" data-size="sm" onClick={onClear} data-scenario-clear>
          <X size={13} aria-hidden="true" />{SCENARIO_CLEAR_LABEL}
        </button>
      </div>
    </section>
  )
}

/** Assumed closes of the selected scenario; shown inside a collapsed details block below the chart. */
export function ScenarioAssumedCloses({ envelope, closes, fmt }: { envelope: ScenarioEvidenceEnvelope; closes: readonly number[]; fmt: PriceFormat }) {
  const copy = SCENARIO_ORIGIN_COPY[envelope.origin.kind]
  const sessions = envelope.futureClosePath.status === 'available' ? envelope.futureClosePath.value.map((point) => point.dateOrPeriod) : []
  return (
    <div className="min-w-0" data-scenario-selection={envelope.origin.kind}>
      <div className="min-w-0 overflow-x-auto">
        <table className="border-collapse text-[11px] tabular-nums" data-scenario-closes>
          <caption className="sr-only">仮定した将来の終値 ({copy.label})</caption>
          <tbody>
            <tr className="text-[var(--color-text-tertiary)]">
              <th scope="row" className="py-0.5 pr-2 text-left font-bold">足</th>
              {closes.map((_, i) => <th key={i} scope="col" className="px-1.5 py-0.5 text-right font-mono font-bold" title={sessions[i]}>T+{i + 1}</th>)}
            </tr>
            <tr className="text-[var(--color-text-tertiary)]">
              <th scope="row" className="py-0.5 pr-2 text-left font-bold">日付</th>
              {sessions.map((date, i) => <td key={i} className="px-1.5 py-0.5 text-right font-mono">{date.slice(5)}</td>)}
            </tr>
            <tr className="text-[var(--color-text-primary)]">
              <th scope="row" className="py-0.5 pr-2 text-left font-bold text-[var(--color-text-tertiary)]">仮定終値</th>
              {closes.map((close, i) => <td key={i} className="px-1.5 py-0.5 text-right font-mono font-bold">{fmt(close)}</td>)}
            </tr>
            <tr className="text-[var(--color-text-secondary)]">
              <th scope="row" className="py-0.5 pr-2 text-left font-bold text-[var(--color-text-tertiary)]">基準日比</th>
              {closes.map((close, i) => <td key={i} className="px-1.5 py-0.5 text-right font-mono">{formatPct((close / envelope.predictionReferencePrice - 1) * 100)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const HANDOFF_ORIGIN_TEXT: Record<HandoffPathOrigin, string> = { inherited: '引き継いだまま', user_modified: 'あなたが変更' }

function handoffMarkers(record: ScenarioHandoffRecord, path: HandoffPathState) {
  return {
    'data-handoff-source-origin': record.sourceOrigin,
    'data-handoff-scope': path.status,
    'data-handoff-path-origin': path.status === 'in_scope' ? path.currentOrigin : undefined,
  }
}

/**
 * Shown above the editor after a hand-off. The source stays named; whether the path is still
 * the inherited one is read from the draft's values (restoring them makes it inherited again).
 */
export function ScenarioHandoffNote({ record, path }: { record: ScenarioHandoffRecord; path: HandoffPathState }) {
  const className = 'm-0 mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]'
  if (path.status === 'out_of_scope') {
    return <p className={className} data-scenario-handoff-note {...handoffMarkers(record, path)}>{handoffScopeText(record, path.mismatches)}</p>
  }
  return (
    <p className={className} data-scenario-handoff-note {...handoffMarkers(record, path)}>
      <ScenarioOriginBadge origin={{ kind: record.sourceOrigin }} />
      {path.currentOrigin === 'inherited'
        ? <>「{record.label}」の終値を読み込みました (引き継いだまま)。ここで変えた値は <ScenarioOriginBadge origin={{ kind: 'user_input' }} /> {SCENARIO_ORIGIN_COPY.user_input.premise}として扱います。</>
        : <>「{record.label}」を基に <ScenarioOriginBadge origin={{ kind: 'user_input' }} /> あなたが変更した経路です (T+{path.changedK.join(', T+')} が元と異なります)。元の値に戻すと、引き継いだ経路として扱います。</>}
    </p>
  )
}

/**
 * Solver comparison of an inherited path. The inherited path is a compared assumption, never a
 * solver result; source metadata and the original closes stay in a compact disclosure.
 */
export function SolverHandoffCallout({
  record,
  path,
  fmt,
  comparisonOnChart,
  solverOnChart,
  onRestoreView,
}: {
  record: ScenarioHandoffRecord
  path: HandoffPathState
  fmt: PriceFormat
  comparisonOnChart: boolean
  solverOnChart: boolean
  /** Switches the view back to the hand-off's timeframe and horizon (absent when the as-of differs). */
  onRestoreView?: () => void
}) {
  const tf = smaLabTimeframe(record.timeframe)
  const details = (
    <details className="group mt-1 min-w-0" data-handoff-details>
      <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)] sm:min-h-7 [&::-webkit-details-marker]:hidden">
        <ArrowRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
        引き継ぎ元の詳細
      </summary>
      <dl className={`${FACT_GRID} pt-1`}>
        <Row label="シナリオ"><span data-handoff-source-label>{record.label}</span></Row>
        <Row label="由来"><span className="inline-flex max-w-full flex-wrap items-center gap-1.5"><ScenarioOriginBadge origin={{ kind: record.sourceOrigin }} />{SCENARIO_ORIGIN_COPY[record.sourceOrigin].label}</span></Row>
        <Row label="時間軸・本数"><span data-handoff-source-timeframe={record.timeframe} data-handoff-source-horizon={record.horizon}>{tf.name} ({tf.label}) ・ {record.horizon}本</span></Row>
        <Row label="基準日"><span data-handoff-source-asof={record.asOfDate}>{record.asOfDate}</span></Row>
        <Row label="現在の経路">{path.status === 'in_scope' ? HANDOFF_ORIGIN_TEXT[path.currentOrigin] : '比較していません (表示中の足と異なります)'}</Row>
        <Row label="元の終値">
          <ol className="m-0 flex list-none flex-wrap gap-x-2.5 gap-y-0.5 p-0 font-mono tabular-nums" data-handoff-source-closes>
            {record.sourceCloses.map((close, i) => <li key={i}>T+{i + 1} {fmt(close)}</li>)}
          </ol>
        </Row>
      </dl>
    </details>
  )
  if (path.status === 'out_of_scope') {
    return (
      <Callout tone="warn" data-sma-solver-handoff {...handoffMarkers(record, path)}>
        <span className="block">{handoffScopeText(record, path.mismatches)}</span>
        {onRestoreView && (
          <button type="button" className="mt-1 inline-flex items-center font-bold text-[var(--color-brand-700)] underline underline-offset-2 max-sm:min-h-11" onClick={onRestoreView} data-handoff-restore-view>
            表示を {tf.label}・{record.horizon}本に戻して比較する
          </button>
        )}
        {details}
      </Callout>
    )
  }
  return (
    <Callout data-sma-solver-handoff {...handoffMarkers(record, path)}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ScenarioOriginBadge origin={{ kind: path.currentOrigin === 'inherited' ? record.sourceOrigin : 'user_input' }} />
        <b className="text-[var(--color-text-primary)]" data-handoff-lead>{handoffSolverLead(record.label, path.currentOrigin)}</b>
      </span>
      <span className="block" data-handoff-labels>
        {comparisonOnChart ? (
          solverOnChart
            ? <>チャート: <b>{handoffComparisonLabel(record, path.currentOrigin)}</b> と <b>{SOLVER_REPRESENTATIVE_PATH_LABEL}</b>。</>
            : <>チャート: <b>{handoffComparisonLabel(record, path.currentOrigin)}</b>。<b>{SOLVER_REPRESENTATIVE_PATH_LABEL}</b>は現在表示できる経路がありません。</>
        ) : (
          solverOnChart
            ? <>引き継いだ経路は現在チャートに重ねていません。「比較」で「シナリオ」を選ぶと、<b>{handoffComparisonLabel(record, path.currentOrigin)}</b> と <b>{SOLVER_REPRESENTATIVE_PATH_LABEL}</b> を見比べられます。</>
            : <>引き継いだ経路は現在チャートに重ねていません。「比較」で「シナリオ」を選べます。<b>{SOLVER_REPRESENTATIVE_PATH_LABEL}</b>が見つかったときに、2つの経路を見比べられます。</>
        )}
        {HANDOFF_NOT_SOLVER_NOTE}
      </span>
      {details}
    </Callout>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="m-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className={`${FACT_VALUE} text-[11px] font-medium text-[var(--color-text-primary)]`}>{children}</dd>
    </div>
  )
}

/** Collapsed provenance: every field that decided whether the scenario could be drawn. */
export function ScenarioEvidenceDetails({ envelope }: { envelope: ScenarioEvidenceEnvelope }) {
  const shownClaim = displayableClaim(envelope)
  const claim = shownClaim ? describeQuantitativeClaim(shownClaim) : null
  const tf = smaLabTimeframe(envelope.forecastTimeframe)
  return (
    <dl className={FACT_GRID} data-scenario-details>
      <Row label="由来"><span className="inline-flex max-w-full flex-wrap items-center gap-1.5"><ScenarioOriginBadge origin={envelope.origin} />{SCENARIO_ORIGIN_COPY[envelope.origin.kind].label} ・ {originVersionText(envelope.origin)}</span></Row>
      <Row label="数値の意味">
        {claim && shownClaim
          ? <span data-scenario-claim={shownClaim.kind}>{claim.label} {claim.value} ・ {claim.meaning}</span>
          : envelope.quantitativeClaim.status === 'available'
            ? <span data-scenario-claim-withheld>表示しません (この由来には付けられない数値か、範囲外の値です)</span>
            : `なし (${envelope.quantitativeClaim.reason})`}
      </Row>
      <Row label="銘柄">{envelope.identity.market} {envelope.identity.symbol} ・ 恒久ID {envelope.identity.permanentId.status === 'available' ? envelope.identity.permanentId.value : `なし (${envelope.identity.permanentId.reason})`}</Row>
      <Row label="基準日・終値">{envelope.asOfDate} ・ {envelope.predictionReferencePrice}</Row>
      <Row label="時間軸・本数">{tf.name} ({tf.label}) ・ {envelope.forecastHorizonBars}本</Row>
      <Row label="価格の基準">{describePriceBasis(envelope.priceBasis)}</Row>
      <Row label="カレンダー">{envelope.calendar.id} ・ {envelope.calendar.version}</Row>
      <Row label="過去データ">{envelope.historicalOhlc.availableThrough} まで ・ {envelope.historicalOhlc.completeness === 'complete' ? '欠けなし' : envelope.historicalOhlc.completeness === 'partial' ? '一部欠け' : '不明'} ・ {envelope.historicalOhlc.sourceProvenance}</Row>
      <Row label="経路">{envelope.futureClosePath.status === 'available' ? `終値 ${envelope.futureClosePath.value.length}本 (ローソク足は作りません)` : `なし (${envelope.futureClosePath.reason})`}</Row>
      <Row label="価格レンジ">{envelope.futurePriceRange.status === 'available' ? `${envelope.futurePriceRange.value.low}〜${envelope.futurePriceRange.value.high} (T+${envelope.futurePriceRange.value.asOfBar})` : `なし (${envelope.futurePriceRange.reason})`}</Row>
      <Row label="データの完全性">{envelope.dataCompleteness === 'complete' ? '完全' : envelope.dataCompleteness === 'partial' ? '一部' : '不足'}</Row>
    </dl>
  )
}
