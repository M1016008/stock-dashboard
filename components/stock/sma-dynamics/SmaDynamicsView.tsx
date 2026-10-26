'use client'

// SMA Dynamics Lab: presentational and fetch-free. Stock detail pages wrap it in
// SmaDynamicsSection (history adapter); the dev preview feeds fixtures.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronUp, Expand, ListChecks, Maximize2, Minimize2, RotateCcw, Shrink, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import {
  computeSmaLab,
  describeHorizon,
  describeSmaLabUnavailable,
  firstBarIndexInRange,
  priceFreezePath,
  SMA_LAB_DEFAULT_PERIODS,
  SMA_LAB_FEW_BARS,
  SMA_LAB_FOCUS_OPTIONS,
  normalizeSmaLabPeriods,
  SMA_LAB_MAX_SELECTED_PERIODS,
  SMA_LAB_PERIODS,
  SMA_LAB_RANGES,
  smaLabDefaultHorizon,
  smaLabHorizonOptions,
  SMA_LAB_SOLVER_MAX_BARS,
  smaLabMaxHorizonBars,
  smaLabRangeStart,
  visibleSlotRange,
  type SmaLabAvailable,
  type SmaLabFocus,
  type SmaLabPeriod,
  type SmaLabRangeId,
  type SmaLabResult,
} from '@/lib/sma-dynamics-lab'
import {
  compareDirections,
  priceUnit,
  describeCurrentDirection,
  goalCondition,
  isSingleBarSameDirection,
  priceCondition,
  type WordingContext,
  smaLineName,
  solverBoundaries,
  MAX_BOUNDARY_MARKERS,
  solverDirectionHint,
  timingLabel,
} from '@/lib/sma-dynamics-solver-copy'
import { buildSmaLabChartModel, type SmaLabBoundaryLine, type SmaLabHighlightInput, type SmaLabOverlayId, type SmaLabOverlayInput } from '@/lib/sma-dynamics-chart-model'
import { SMA_LAB_TIMEFRAMES, smaLabTimeframe, type SmaLabRawRow, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import {
  analyzeSolverGoal,
  anchorDirection,
  anchorSmaValue,
  checkGoal,
  emptyScenario,
  evaluateScenario,
  forwardBase,
  freshSimulationState,
  goalBars,
  goalFromDraft,
  parseConstraints,
  PATH_ASSUMPTIONS,
  applySolverDraftPatch,
  presetFreeze,
  priceDomain,
  projectAllSma,
  representativePath,
  resizeScenario,
  scenarioFromCloses,
  scenarioKey,
  scopeSimulationState,
  simulationIdentity,
  SMA_LAB_ANALYSIS_MODES,
  type PathAssumption,
  type RepresentativePath,
  type ScenarioDraft,
  type SmaLabAnalysisMode,
  type SmaSimulationState,
  type SolverDraft,
} from '@/lib/sma-dynamics-scenario'
import { SmaDynamicsChart, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR, type SmaDynamicsChartHandle } from './SmaDynamicsChart'
import { ControlRow, CustomPeriodInput, periodStatusText, SegmentedControl, SmaPeriodPicker } from './SmaDynamicsControls'
import { ChartLegend, formatPct, FutureValuesDetails, IssuesBand, priceFormatter, SlotReadout, SummaryTable, type ReadoutLayer } from './SmaDynamicsPanels'
import { ScenarioDetails, ScenarioEditor } from './SmaScenarioPanel'
import { DirectionBadge, hitHighlight, SolverAdvanced, SolverConclusion, SolverDetails, solverFirstHit, solverPeriodOptions, solverWording, type SolverViewModel } from './SmaSolverPanel'
import { CurrentDirectionCard, SolverDirectionPicker, SolverKindPicker, SolverScopePicker, SolverTimingPicker } from './SmaSolverSteps'
import { FreezeConclusion, ScenarioConclusion, scenarioResultLead } from './SmaConclusions'
import { AdvancedSettings, DetailsSection, GuideStep, MoreOptions, PurposePicker, SMA_PURPOSES, TermHelp } from './SmaGuidedControls'
import { Callout } from './SmaSimulationParts'
import { SmaShapePanel, type ShapeBarLabel } from './SmaShapePanel'
import { SmaCrossingPanel } from './SmaCrossingPanel'
import { buildShapeTimeline } from '@/lib/sma-dynamics-geometry'
import { SMA_LINK_ORIGIN_LABEL, type SmaLinkIntent } from '@/lib/sma-dynamics-link'
import { exactFormatter } from './SmaSimulationParts'
import {
  adaptScenarioToSma,
  candidateDirection,
  evaluateScenarioCandidates,
  handoffCheckLabel,
  handoffComparisonLabel,
  presentedScenario,
  resolveHandoffPath,
  resolveScenarioPresentation,
  SCENARIO_DRAFT_KEPT_NOTE,
  SCENARIO_ORIGIN_COPY,
  scenarioValidationContext,
  showsUserDraftEditor,
  SOLVER_REPRESENTATIVE_PATH_LABEL,
  validateScenarioEvidence,
  type ScenarioDirection,
  type ScenarioEvidenceCandidate,
  type ScenarioEvidenceEnvelope,
  type ScenarioHandoffRecord,
  type ScenarioOriginKind,
  type ScenarioPriceBasis,
  type Availability,
} from '@/lib/sma-dynamics-scenario-evidence'
import {
  ScenarioAnalysisHeader,
  scenarioAnalysisAnnouncement,
  scenarioAnalysisTitle,
  ScenarioAssumedCloses,
  ScenarioEvidenceDetails,
  ScenarioEvidencePicker,
  ScenarioEvidenceStatus,
  ScenarioHandoffNote,
  ScenarioOriginBadge,
  ScenarioSelectionUnavailable,
  SolverHandoffCallout,
  SMA_SCENARIO_EVIDENCE_INTRO,
  SMA_SCENARIO_EVIDENCE_PREMISE,
  SMA_SCENARIO_EVIDENCE_TITLE,
} from './SmaScenarioEvidence'

export const SMA_DYNAMICS_TITLE = 'SMA Dynamics Lab'
/** Top subtitle per active mode (internal ids stay freeze / scenario / solver). */
export const SMA_MODE_SUBTITLE: Record<SmaLabAnalysisMode, string> = {
  freeze: '株価が今のままなら、移動平均線はどう動く？',
  scenario: 'これからの株価を自由に変えて、移動平均線の動きを確かめよう',
  solver: '移動平均線を希望する向きにするための株価条件を調べよう',
}
/** Mode-neutral line for the collapsed launcher, where no mode is active yet. */
export const SMA_DYNAMICS_LAUNCHER_SUBTITLE = '株価の仮定から、移動平均線の動きを確かめます'
/** Shared header label for the anchor close; never the Price-Freeze-only wording. */
export const SMA_ANCHOR_CLOSE_LABEL = '基準日の終値'
export const SMA_DYNAMICS_PREMISE = '点線は、基準日の終値が将来も変わらないと仮定し、選択した足の確定終値で実際のローリング窓を再計算したSMAです。現在の傾きの延長ではなく、株価予測でもありません。'
export const SMA_DYNAMICS_SCENARIO_PREMISE = '破線は、入力した将来の終値 (選択した足の確定終値) で実際のローリング窓を再計算したSMAです。入力のない足は補完せず、その足を含む計算窓のSMAは表示しません。仮定に基づく計算で、将来の株価を示すものではありません。'
export const SMA_DYNAMICS_SOLVER_PREMISE = '目標とするSMAの向きが成立するための終値の数学的な条件です。条件を満たす価格経路は一般に無数にあり、表示する経路は明示した補助条件のもとでの一例です。将来の株価を示すものではありません。'
export const SCENARIO_WITHHELD_PREMISE = '選択中のシナリオは表示できないため、将来の終値とそのSMAは描いていません。あなたの入力も、このシナリオの代わりには表示しません。'
export const SMA_DYNAMICS_GROUPING_NOTE = '2D/3D/5D は2000年最初の営業日を起点に市場の営業日を連続して区切り、1W/2W/3W は暦週、1M〜6M は暦月・四半期・半期、1Y〜5Y は暦年 (多年足は1970年起点) で区切ります。2D/3D/2W/3W の境界はメインチャート (年初から数え直す) と異なる場合があります。表示期間を変えても足の境界とSMAの値は変わりません。'

export interface SmaDynamicsSecurity {
  market: SmaDynamicsMarket
  ticker: string
  name: string | null
}

export interface SmaDynamicsSettings {
  timeframe: SmaLabTimeframeId
  periods: SmaLabPeriod[]
  range: SmaLabRangeId
  horizon: number
  focus: SmaLabFocus
  /** A Price Freeze / B scenario / C inverse solver. View setting: carries across securities. */
  analysis: SmaLabAnalysisMode
  /** Non-active assumptions drawn faded for comparison. */
  compare: SmaLabOverlayId[]
}

const BEGINNER_HORIZON = 5
const QUICK_PERIODS: readonly SmaLabPeriod[] = [5, 25, 75]
const QUICK_HORIZONS: readonly number[] = [1, 3, 5, 10, 20]

/** Compact picker for every horizon not shown as a quick button (any 1..20, plus daily 60). */
function HorizonSelect({ label, options, value, disabled, onChange }: { label: string; options: readonly number[]; value: number; disabled: boolean; onChange: (horizon: number) => void }) {
  const hasValue = options.includes(value)
  return (
    <label className="flex items-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]" data-sma-horizon-select>
      ほかの本数
      <select
        aria-label={label}
        className="h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-1.5 text-[12px] font-bold text-[var(--color-text-primary)] sm:h-8"
        value={hasValue ? value : ''}
        disabled={disabled}
        onChange={(event) => { if (event.target.value) onChange(Number(event.target.value)) }}
      >
        {!hasValue && <option value="" hidden>選んでください</option>}
        {options.map((k) => <option key={k} value={k}>{k}本</option>)}
      </select>
    </label>
  )
}

export const SMA_DYNAMICS_DEFAULT_SETTINGS: SmaDynamicsSettings = {
  timeframe: '1D',
  periods: [...SMA_LAB_DEFAULT_PERIODS],
  // Beginner defaults: 1D, SMA 5/25/75, 3 months back, 5 bars ahead.
  range: '3m',
  horizon: BEGINNER_HORIZON,
  focus: 'both',
  analysis: 'freeze',
  compare: ['freeze'],
}

export const SMA_LAB_OVERLAY_LABEL: Record<SmaLabOverlayId, string> = { freeze: '価格固定', scenario: 'シナリオ', solver: '逆算経路' }
const MODE_OVERLAY: Record<SmaLabAnalysisMode, SmaLabOverlayId> = { freeze: 'freeze', scenario: 'scenario', solver: 'solver' }
const MODE_PREMISE: Record<SmaLabAnalysisMode, string> = {
  freeze: SMA_DYNAMICS_PREMISE,
  scenario: SMA_DYNAMICS_SCENARIO_PREMISE,
  solver: SMA_DYNAMICS_SOLVER_PREMISE,
}

export type SmaDynamicsLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'unconnected'; message: string }
  | { status: 'ready'; rows: ReadonlyArray<SmaLabRawRow> }

export interface SmaDynamicsDataSourceInfo {
  label: string
  priceBasis: string
}

export interface SmaScenarioHandoff {
  candidateId: string
  target: 'scenario' | 'solver'
  closes: number[]
  origin: ScenarioOriginKind
  label: string
  timeframe: SmaLabTimeframeId
  horizon: number
  asOfDate: string
}

/**
 * Optional scenario evidence (Phase 3B). Without it the lab renders exactly as before.
 * Every candidate is validated against the loaded history; nothing is trusted as typed.
 */
export interface SmaExternalScenarioInput {
  candidates: ReadonlyArray<ScenarioEvidenceCandidate>
  /** Machine-readable basis of the loaded history; an unknown basis rejects every scenario. */
  historyBasis: ScenarioPriceBasis
  /** Permanent identity is compared when available on either side; unavailable must be explicit. */
  securityPermanentId: Availability<string>
  /** Version of the calendar that produced the loaded projection bars. */
  calendarVersion: string
  onHandoff?: (handoff: SmaScenarioHandoff) => void
  /** Candidate selected on first render (dev deep links, static tests). Validated like any selection. */
  initialSelectedId?: string
}

interface EvidenceState {
  identity: string
  selectedId: string | null
  direction: ScenarioDirection
  /** Set after a hand-off: the source is kept; the current path origin is derived from the draft's values. */
  handoff: ScenarioHandoffRecord | null
}

const INLINE_CHART_HEIGHT = 'clamp(320px, 56vh, 540px)'
const EXPANDED_CHART_HEIGHT = 'max(340px, calc(100dvh - 410px))'

function priceDigits(market: SmaDynamicsMarket): number {
  return market === 'US' ? 2 : 1
}

/** Smallest displayed price step; used only to space representative-path values when no tick is given. */
function displayUnit(market: SmaDynamicsMarket): number {
  return market === 'US' ? 0.01 : 0.1
}

function sortPeriods(periods: readonly SmaLabPeriod[]): SmaLabPeriod[] {
  return normalizeSmaLabPeriods(periods)
}

/** Selected periods that are not presets: the only ones the lab has to compute in addition. */
function customPeriods(periods: readonly SmaLabPeriod[]): SmaLabPeriod[] {
  return normalizeSmaLabPeriods(periods).filter((period) => !(SMA_LAB_PERIODS as readonly number[]).includes(period))
}

export function securityLabel(security: SmaDynamicsSecurity): string {
  return `${security.market} ${security.ticker}${security.name ? ` ${security.name}` : ''}`
}

export function SmaDynamicsView({
  security,
  analysisDate,
  load,
  dataSource,
  initialSettings,
  onSettingsChange,
  initialMaximized = false,
  onCollapse,
  externalScenarios,
  linkIntent = null,
}: {
  security: SmaDynamicsSecurity
  analysisDate: string | null
  load: SmaDynamicsLoadState
  dataSource: SmaDynamicsDataSourceInfo
  initialSettings?: SmaDynamicsSettings
  onSettingsChange?: (settings: SmaDynamicsSettings) => void
  initialMaximized?: boolean
  onCollapse?: () => void
  externalScenarios?: SmaExternalScenarioInput
  /** Where the view was opened from (lib/sma-dynamics-link); shown, and used to preselect the SMA pair. */
  linkIntent?: SmaLinkIntent | null
}) {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const readoutId = `${baseId}-readout`
  const rootRef = useRef<HTMLElement>(null)
  const chartRef = useRef<SmaDynamicsChartHandle>(null)
  const [settings, setSettings] = useState<SmaDynamicsSettings>({ ...SMA_DYNAMICS_DEFAULT_SETTINGS, ...initialSettings })
  // Scenario inputs and solver goals belong to one security + analysis date; they are
  // never carried to another security (settings above are).
  const identity = simulationIdentity(security.market, security.ticker, analysisDate)
  const [simulationState, setSimulationState] = useState<SmaSimulationState>(() => freshSimulationState(identity))
  const simulation = scopeSimulationState(simulationState, identity)
  const [hoverSlot, setHoverSlot] = useState<number | null>(null)
  const [maximized, setMaximized] = useState(initialMaximized)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenSupported, setFullscreenSupported] = useState(false)
  const expanded = maximized || fullscreen
  const fmt = useMemo(() => priceFormatter(priceDigits(security.market)), [security.market])
  const timeframe = smaLabTimeframe(settings.timeframe)
  const periods = useMemo(() => sortPeriods(settings.periods), [settings.periods])

  const update = (patch: Partial<SmaDynamicsSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    onSettingsChange?.(next)
    setHoverSlot(null)
  }

  // Results per timeframe × horizon are cached for the lifetime of the loaded rows.
  const cache = useMemo(() => new Map<string, SmaLabResult>(), [load, security.market, analysisDate])
  const extraPeriodsKey = customPeriods(settings.periods).join('.')
  const extraPeriods = useMemo(() => (extraPeriodsKey === '' ? [] : extraPeriodsKey.split('.').map(Number)), [extraPeriodsKey])
  const result = useMemo((): SmaLabResult | null => {
    if (load.status !== 'ready') return null
    const key = `${settings.timeframe}:${settings.horizon}:${extraPeriodsKey}`
    const cached = cache.get(key)
    if (cached) return cached
    const computed = computeSmaLab({ rows: load.rows, market: security.market, timeframe: settings.timeframe, horizon: settings.horizon, analysisDate, periods: extraPeriods })
    cache.set(key, computed)
    return computed
  }, [analysisDate, cache, extraPeriods, extraPeriodsKey, load, security.market, settings.horizon, settings.timeframe])
  const available = result?.status === 'available' ? result : null
  const base = useMemo(() => (available ? forwardBase(available) : null), [available])
  const fmtExact = useMemo(() => exactFormatter(priceDigits(security.market)), [security.market])
  const mode = settings.analysis

  // Mode B
  const currentScenarioKey = available ? scenarioKey(available.timeframe, available.asOf.date) : null
  const storedScenario = currentScenarioKey ? simulation.scenarios[currentScenarioKey] : undefined
  const scenarioDraft = useMemo(
    (): ScenarioDraft | null => (base ? resizeScenario(storedScenario ?? emptyScenario(base.horizon), base.horizon) : null),
    [base, storedScenario],
  )
  const draftScenario = useMemo(() => (base && scenarioDraft ? evaluateScenario(base, scenarioDraft) : null), [base, scenarioDraft])

  // Phase 3B: external scenario evidence. Scoped to one security + analysis date like the drafts.
  const [evidenceState, setEvidenceState] = useState<EvidenceState>(() => {
    const initial = externalScenarios?.candidates.find((candidate) => candidate.id === externalScenarios.initialSelectedId) ?? null
    return { identity, selectedId: initial?.id ?? null, direction: (initial && candidateDirection(initial)) ?? 'up', handoff: null }
  })
  const evidence: EvidenceState = evidenceState.identity === identity ? evidenceState : { identity, selectedId: null, direction: 'up', handoff: null }
  const setEvidence = (patch: Partial<Omit<EvidenceState, 'identity'>>) => setEvidenceState({ ...evidence, ...patch })
  // Persist the scope reset as well as rendering the safe fallback. Otherwise an old hand-off
  // could reappear after switching JP -> US -> the original JP identity in the same component.
  useEffect(() => {
    setEvidenceState((current) => current.identity === identity
      ? current
      : { identity, selectedId: null, direction: 'up', handoff: null })
  }, [identity])
  const historyBasis = externalScenarios?.historyBasis
  const evidenceEntries = useMemo(() => {
    if (!externalScenarios || !historyBasis || !available || load.status !== 'ready') return null
    const rows = load.rows
    const identityKey = { market: security.market, ticker: security.ticker, permanentId: externalScenarios.securityPermanentId }
    const current = scenarioValidationContext(available, identityKey, historyBasis, externalScenarios.calendarVersion)
    // A candidate is listed against the current timeframe at its own horizon (applied on selection).
    return evaluateScenarioCandidates(externalScenarios.candidates, (horizon) => {
      if (horizon == null || horizon === available.horizon || !smaLabHorizonOptions(settings.timeframe).includes(horizon)) return current
      const key = `${settings.timeframe}:${horizon}:${extraPeriodsKey}`
      let lab = cache.get(key)
      if (!lab) {
        lab = computeSmaLab({ rows, market: security.market, timeframe: settings.timeframe, horizon, analysisDate, periods: extraPeriods })
        cache.set(key, lab)
      }
      return lab.status === 'available' ? scenarioValidationContext(lab, identityKey, historyBasis, externalScenarios.calendarVersion) : current
    })
  }, [externalScenarios, historyBasis, available, load, cache, security.market, security.ticker, settings.timeframe, analysisDate, extraPeriods, extraPeriodsKey])
  const selectedEntry = evidenceEntries?.find((entry) => entry.candidate.id === evidence.selectedId) ?? null
  // The drawn path is validated against the bars actually on screen (current horizon), not the list-level horizon.
  const activeValidation = useMemo(
    () => (selectedEntry && available && historyBasis
      ? validateScenarioEvidence(selectedEntry.candidate.envelope, scenarioValidationContext(
        available,
        { market: security.market, ticker: security.ticker, permanentId: externalScenarios!.securityPermanentId },
        historyBasis,
        externalScenarios!.calendarVersion,
      ))
      : null),
    [selectedEntry, available, historyBasis, security.market, security.ticker, externalScenarios],
  )
  const adaptedProjection = useMemo(() => (activeValidation && base ? adaptScenarioToSma(activeValidation, base) : null), [activeValidation, base])
  // One explicit state for the scenario layer. A selection that is not drawable never falls back
  // to the user's draft (no path, SMA, result, readout or editor); the draft itself is untouched.
  const presentation = resolveScenarioPresentation({
    selectedId: evidence.selectedId,
    validated: evidenceEntries != null,
    validation: activeValidation,
    projection: adaptedProjection,
  })
  const evidenceProjection = presentation.state === 'evidence_projectable' ? presentation.projection : null
  const evidenceEnvelope = presentation.state === 'evidence_projectable' ? presentation.envelope : null
  const evidenceActive = mode === 'scenario' && evidenceProjection != null && evidenceEnvelope != null
  // While a scenario is previewed it feeds the existing scenario overlay; the user's draft is untouched.
  const scenario = presentedScenario(presentation, draftScenario, evidenceActive)
  // Name of the assumption while the Scenario Analysis state is on (null otherwise).
  const analysisName = evidenceActive && selectedEntry ? selectedEntry.candidate.label : null

  // Hand-off provenance. Out of its own bars (timeframe / horizon / as-of) the inherited path is
  // not compared outside the editor: never resized or converted. Plain drafts are unaffected.
  // A selection owns the visible evidence state. Keep a prior hand-off in memory so clearing can
  // restore its provenance, but never show or compare that older path while another item is selected.
  const handoff = evidence.selectedId == null ? evidence.handoff : null
  const handoffPath = handoff && available && base && draftScenario
    ? resolveHandoffPath(handoff, { timeframe: available.timeframe, horizon: base.horizon, asOfDate: available.asOf.date, closes: draftScenario.closes })
    : null
  const handoffInScope = handoffPath?.status === 'in_scope' ? handoffPath : null
  const comparedScenario = handoff && !handoffInScope && mode !== 'scenario' ? null : scenario
  const handoffLabel = handoff && handoffInScope && mode !== 'scenario' ? handoffComparisonLabel(handoff, handoffInScope.currentOrigin) : null

  const setScenarioDraft = (draft: ScenarioDraft) => {
    if (!currentScenarioKey) return
    setSimulationState({ ...simulation, scenarios: { ...simulation.scenarios, [currentScenarioKey]: draft } })
    setHoverSlot(null)
  }

  // Mode C
  const solverDraft = simulation.solver
  const setSolverDraft = (patch: Partial<SolverDraft>) => setSimulationState({
    ...simulation,
    solver: applySolverDraftPatch(
      simulation.solver,
      patch,
      base && available && solverPeriod != null ? (anchorDirection(base, solverPeriod)?.direction ?? null) : null,
    ),
  })
  const solverPeriods = available ? solverPeriodOptions(available, periods) : []
  const solverPeriod = solverPeriods.find((option) => option.period === solverDraft.period && option.available)?.period
    ?? solverPeriods.find((option) => option.available)?.period
    ?? null
  const parsedConstraints = parseConstraints(solverDraft)
  const solver = useMemo((): SolverViewModel | null => {
    if (!base || !available || solverPeriod == null || mode !== 'solver') return null
    if (available.periods.find((item) => item.period === solverPeriod)?.status !== 'ok') return null
    const goal = goalFromDraft(solverDraft, base.horizon, solverPeriod)
    const analysis = analyzeSolverGoal(base, goal, parsedConstraints.constraints)
    const paths = Object.fromEntries(
      PATH_ASSUMPTIONS.map((item) => [item.id, representativePath(base, analysis, item.id, displayUnit(security.market))]),
    ) as Record<PathAssumption, RepresentativePath>
    const comparison = goal.kind === 'direction'
      ? compareDirections({
          base,
          period: solverPeriod,
          bar: goal.bar,
          constraints: parsedConstraints.constraints,
          ctx: { timeframe: settings.timeframe, current: analysis.anchorDirection?.direction ?? null, unit: priceUnit(security.market), exact: fmtExact },
        })
      : null
    return {
      goal,
      analysis,
      comparison,
      paths,
      freezeCheck: checkGoal(base, goal, priceFreezePath(base.anchorClose, base.horizon), priceDomain(parsedConstraints.constraints)),
      scenarioCheck: comparedScenario && comparedScenario.filled > 0
        ? checkGoal(base, goal, comparedScenario.closes, priceDomain(parsedConstraints.constraints))
        : null,
      ...(handoff && handoffInScope ? { scenarioCheckLabel: handoffCheckLabel(handoff.label, handoffInScope.currentOrigin) } : {}),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, available, solverPeriod, mode, JSON.stringify(solverDraft), JSON.stringify(parsedConstraints.constraints), comparedScenario, handoff, handoffInScope?.currentOrigin, security.market, settings.timeframe, fmtExact])
  const currentDirection = useMemo(() => {
    if (!base || !available) return null
    // No SMA is computable on this timeframe (long bars, short history): say so for the chosen line.
    if (solverPeriod == null) {
      return describeCurrentDirection({ period: solverDraft.period ?? QUICK_PERIODS[0], timeframe: settings.timeframe, anchorSma: null, anchor: null, exact: fmtExact })
    }
    return describeCurrentDirection({
      period: solverPeriod,
      timeframe: settings.timeframe,
      anchorSma: anchorSmaValue(base, solverPeriod),
      anchor: anchorDirection(base, solverPeriod),
      exact: fmtExact,
    })
  }, [base, available, solverPeriod, solverDraft.period, settings.timeframe, fmtExact])
  const solverGoalNow = solver?.goal ?? (base && solverPeriod != null ? goalFromDraft(solverDraft, base.horizon, solverPeriod) : null)
  const solverActiveK = solverGoalNow ? goalBars(solverGoalNow) : 1
  const solverMaxK = Math.min(SMA_LAB_SOLVER_MAX_BARS, smaLabMaxHorizonBars(settings.timeframe))
  const pickTiming = (k: number) => {
    // N is shared by every scope (bar: A and level, within: B / C / reversal).
    setSolverDraft({ bar: k, within: k })
    // The projection must reach the chosen bar; the smallest supported horizon that does is used.
    if (k > settings.horizon) update({ horizon: smaLabHorizonOptions(settings.timeframe).find((value) => value >= k) ?? settings.horizon })
  }
  const solverPath = solver?.paths[solverDraft.assumption]
  const solverCloses = solverPath?.status === 'found' ? solverPath.closes : null
  const solverSeries = useMemo(() => (base && solverCloses ? projectAllSma(base, solverCloses) : null), [base, solverCloses])
  const copyToScenario = (closes: number[]) => {
    if (!base || !currentScenarioKey || !scenarioDraft) return
    setSimulationState({ ...simulation, scenarios: { ...simulation.scenarios, [currentScenarioKey]: scenarioFromCloses(base, closes, scenarioDraft.unit) } })
    // The draft now holds a solver path, not one based on the handed-off scenario.
    if (evidence.handoff) setEvidence({ handoff: null })
    update({ analysis: 'scenario' })
  }

  // Shape analysis follows the assumption the active mode draws (freeze, scenario, solver path).
  const shapeSource = useMemo(() => {
    if (!available || !base) return null
    const freezeCloses = available.projection.bars.map((bar) => bar.close)
    let label = SMA_LAB_OVERLAY_LABEL.freeze
    let closes: ReadonlyArray<number | null> = freezeCloses
    let sma = available.projection.sma
    if (mode === 'scenario' && scenario && scenario.filled > 0) {
      label = analysisName ? `シナリオ (${analysisName})` : SMA_LAB_OVERLAY_LABEL.scenario
      closes = scenario.closes
      sma = scenario.sma
    } else if (mode === 'solver' && solverCloses && solverSeries) {
      label = SMA_LAB_OVERLAY_LABEL.solver
      closes = solverCloses
      sma = solverSeries
    }
    const usable = available.periods.filter((summary) => summary.status === 'ok' && periods.includes(summary.period)).map((summary) => summary.period)
    const labels: ShapeBarLabel[] = [
      ...available.bars.slice(0, base.anchorIndex + 1).map((bar) => ({ date: bar.lastSession, tag: null })),
      ...available.projection.bars.map((bar) => ({ date: bar.lastSession, tag: `T+${bar.k}` })),
    ]
    return { label, usable, labels, timeline: buildShapeTimeline(available, base, closes, sma, usable) }
  }, [available, base, mode, scenario, analysisName, solverCloses, solverSeries, periods])
  const scenarioComplete = draftScenario && draftScenario.state === 'complete' && draftScenario.invalidK.length === 0 && draftScenario.closes.every((close) => close != null)
    ? (draftScenario.closes as number[])
    : null

  // Chart: the active mode is drawn at full strength, compared assumptions faded.
  const primaryOverlay = MODE_OVERLAY[mode]
  const shows = (id: SmaLabOverlayId) => id === primaryOverlay || settings.compare.includes(id)
  const overlayInputs: SmaLabOverlayInput[] = []
  if (comparedScenario && comparedScenario.filled > 0 && shows('scenario')) {
    overlayInputs.push({ id: 'scenario', closes: comparedScenario.closes, sma: comparedScenario.sma, emphasis: primaryOverlay === 'scenario' ? 'primary' : 'muted' })
  }
  if (solverCloses && solverSeries && shows('solver')) {
    overlayInputs.push({ id: 'solver', closes: solverCloses, sma: solverSeries, emphasis: primaryOverlay === 'solver' ? 'primary' : 'muted' })
  }
  // Only levels that really exist are drawn: per-bar markers for confirmed-price thresholds; nothing for
  // conditions that depend on other assumed closes.
  const boundaries: SmaLabBoundaryLine[] = []
  if (mode === 'solver' && solver) {
    const wording = solverWording({ timeframe: settings.timeframe, market: security.market, analysis: solver.analysis, exact: fmtExact })
    for (const spec of solverBoundaries(solver.analysis, wording)) boundaries.push({ price: spec.price, label: spec.label, k: spec.k })
  }
  // The example path's first hit (within / reversal) is ringed; it is a point on one path, not a claim about all paths.
  const highlights: SmaLabHighlightInput[] = []
  if (mode === 'solver' && solver && base && available && solverCloses && shows('solver')) {
    const hit = solverFirstHit({ result: available, base, model: solver, draft: solverDraft, fmt, exact: fmtExact, market: security.market })
    if (hit) highlights.push(hitHighlight(hit))
  }
  const freezeEmphasis = primaryOverlay === 'freeze' ? 'primary' : shows('freeze') ? 'muted' : 'hidden'
  const overlayKey = JSON.stringify([freezeEmphasis, overlayInputs.map((item) => [item.id, item.emphasis, item.closes]), boundaries, highlights])
  const model = useMemo(
    () => (available ? buildSmaLabChartModel(available, periods, { freeze: freezeEmphasis, overlays: overlayInputs, boundaries, highlights }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [available, periods, overlayKey],
  )
  // A previewed scenario keeps its origin in every chart label (legend, readout, future region);
  // an inherited comparison path and the solver's representative path are named apart.
  const overlayLabel = (id: SmaLabOverlayId) => {
    if (id === 'scenario' && evidenceActive && evidenceEnvelope) return `シナリオ (${SCENARIO_ORIGIN_COPY[evidenceEnvelope.origin.kind].tag})`
    if (handoffLabel && id === 'scenario') return handoffLabel
    if (handoffLabel && id === 'solver') return SOLVER_REPRESENTATIVE_PATH_LABEL
    return SMA_LAB_OVERLAY_LABEL[id]
  }
  const readoutLayers: ReadoutLayer[] = available
    ? [
        ...(freezeEmphasis !== 'hidden'
          ? [{ id: 'freeze' as const, label: SMA_LAB_OVERLAY_LABEL.freeze, closes: available.projection.bars.map((bar) => bar.close), sma: available.projection.sma, primary: primaryOverlay === 'freeze' }]
          : []),
        ...overlayInputs.map((item) => ({ id: item.id, label: overlayLabel(item.id), closes: item.closes, sma: item.sma, primary: item.emphasis === 'primary' })),
      ]
    : []
  const compareOptions = (['freeze', 'scenario', 'solver'] as const).filter((id) => id !== primaryOverlay)
  const overlayAvailable: Record<SmaLabOverlayId, boolean> = { freeze: true, scenario: (comparedScenario?.filled ?? 0) > 0, solver: solverCloses != null }

  const firstPastSlot = available ? firstBarIndexInRange(available.bars, smaLabRangeStart(available.asOf.date, settings.range)) : 0
  const viewRange = model
    ? visibleSlotRange({ firstPastSlot, anchorSlot: model.anchorSlot, lastSlot: model.lastSlot, focus: settings.focus })
    : { from: 0, to: 1 }
  const viewKey = `${settings.timeframe}|${settings.range}|${settings.horizon}|${settings.focus}|${analysisDate ?? ''}|${expanded}|${identity}`
  const barsInRange = model ? model.anchorSlot - firstPastSlot + 1 : 0

  useEffect(() => {
    setFullscreenSupported(typeof document !== 'undefined' && Boolean(document.fullscreenEnabled))
    const onChange = () => setFullscreen(document.fullscreenElement != null && document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!maximized) return
    rootRef.current?.focus({ preventScroll: true })
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement) setMaximized(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [maximized])

  // Entering / leaving Scenario Analysis moves the controls; when the focused control unmounts
  // with it (focus fell back to <body>), focus lands on the analysis header or the controls.
  const controlsRef = useRef<HTMLDivElement>(null)
  const focusWithinRef = useRef(false)
  const analysisOn = analysisName != null
  const analysisOnRef = useRef(analysisOn)
  useEffect(() => {
    if (analysisOnRef.current === analysisOn) return
    analysisOnRef.current = analysisOn
    const active = document.activeElement
    if (!focusWithinRef.current || (active && active !== document.body)) return
    const target = analysisOn ? rootRef.current?.querySelector<HTMLElement>('[data-scenario-analysis]') : controlsRef.current
    target?.focus()
  }, [analysisOn])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }

  const selectTimeframe = (id: SmaLabTimeframeId) => {
    const options = smaLabHorizonOptions(id)
    update({ timeframe: id, horizon: options.includes(settings.horizon) ? settings.horizon : BEGINNER_HORIZON })
  }

  const togglePeriod = (period: SmaLabPeriod) => {
    if (settings.periods.includes(period)) update({ periods: settings.periods.filter((item) => item !== period) })
    else if (settings.periods.length < SMA_LAB_MAX_SELECTED_PERIODS) update({ periods: [...settings.periods, period] })
  }

  const disabled = !available
  const horizonOptions = smaLabHorizonOptions(settings.timeframe)
  const unavailablePeriods = available
    ? available.periods.filter((summary) => periods.includes(summary.period) && summary.status !== 'ok')
    : []
  const purpose = SMA_PURPOSES.find((item) => item.id === mode)!
  const rangeLabel = SMA_LAB_RANGES.find((item) => item.id === settings.range)?.label ?? settings.range
  const solverTarget = solverPeriod ?? QUICK_PERIODS[0]
  const morePeriods = SMA_LAB_PERIODS.filter((period) => !QUICK_PERIODS.includes(period))
  const moreHorizons = horizonOptions.filter((value) => !QUICK_HORIZONS.includes(value))
  const extraSelected = periods.filter((period) => !QUICK_PERIODS.includes(period))

  // Entering the scenario editor with nothing typed starts from the flat example (an explicit,
  // visible preset) so a single edited price immediately updates every later SMA.
  const selectPurpose = (next: SmaLabAnalysisMode) => {
    // "自由に動かす" always means the user's own draft, and the other purposes never draw a preview,
    // so any purpose change ends the selection (no candidate stays marked while it is not used).
    if (evidence.selectedId != null) setEvidence({ selectedId: null })
    if (next === 'scenario' && base && scenarioDraft && draftScenario && draftScenario.filled === 0 && draftScenario.invalidK.length === 0) {
      setScenarioDraft(presetFreeze(base, scenarioDraft))
    }
    update({ analysis: next })
  }

  // Phase 3B selection and hand-off. One update() per handler (update merges into the current settings).
  const selectEvidence = (id: string) => {
    const entry = evidenceEntries?.find((item) => item.candidate.id === id)
    setEvidence({ selectedId: id })
    // Selecting a drawable scenario applies its own horizon; the timeframe is never changed here.
    if (entry?.validation.status === 'projectable') update({ analysis: 'scenario', horizon: entry.validation.envelope.forecastHorizonBars })
  }
  const alignToEvidence = (envelope: ScenarioEvidenceEnvelope) => {
    update({ analysis: 'scenario', timeframe: envelope.forecastTimeframe, horizon: envelope.forecastHorizonBars })
  }
  // Clearing only ends the selection: the saved draft is shown exactly as it was (no preset applied).
  const clearEvidenceSelection = () => {
    setEvidence({ selectedId: null })
  }
  const handOffEvidence = (target: 'scenario' | 'solver') => {
    if (!evidenceProjection || !evidenceEnvelope || !selectedEntry || !available || !base || !currentScenarioKey) return
    const closes = [...evidenceProjection.closes]
    // Same path as the solver's "シナリオにコピー": price units keep the closes exact.
    const written = scenarioFromCloses(base, closes, 'price')
    setSimulationState({ ...simulation, scenarios: { ...simulation.scenarios, [currentScenarioKey]: written } })
    const record: ScenarioHandoffRecord = {
      candidateId: selectedEntry.candidate.id,
      label: selectedEntry.candidate.label,
      sourceOrigin: evidenceEnvelope.origin.kind,
      timeframe: available.timeframe,
      horizon: base.horizon,
      asOfDate: available.asOf.date,
      sourceCloses: closes,
      inheritedCloses: evaluateScenario(base, written).closes,
    }
    setEvidence({ selectedId: null, handoff: record })
    update(target === 'scenario'
      ? { analysis: 'scenario' }
      : { analysis: 'solver', compare: settings.compare.includes('scenario') ? settings.compare : [...settings.compare, 'scenario'] })
    externalScenarios?.onHandoff?.({ candidateId: record.candidateId, target, closes, origin: record.sourceOrigin, label: record.label, timeframe: record.timeframe, horizon: record.horizon, asOfDate: record.asOfDate })
  }
  const pickSolverPeriod = (period: SmaLabPeriod) => {
    setSolverDraft({ period })
    if (!settings.periods.includes(period)) update({ periods: [...settings.periods, period] })
  }

  const solverWordingBase = {
    timeframe: settings.timeframe,
    current: solver?.analysis.anchorDirection?.direction ?? (base && solverPeriod != null ? anchorDirection(base, solverPeriod)?.direction ?? null : null),
    unit: priceUnit(security.market),
    exact: fmtExact,
  }

  // A selection that is not drawn leaves the scenario layer empty; its copy must not describe the draft.
  const scenarioWithheld = mode === 'scenario' && scenario == null && presentation.state !== 'user_draft'
  const premise = (
    <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]" data-sma-dynamics-premise data-mode={mode}>
      前提: {evidenceActive ? SMA_SCENARIO_EVIDENCE_PREMISE : scenarioWithheld ? SCENARIO_WITHHELD_PREMISE : MODE_PREMISE[mode]}
    </p>
  )
  const evidenceTitleId = `${baseId}-scenario-evidence`
  const analysisTitleId = `${baseId}-scenario-analysis`
  const toggleFreezeCompare = () => update({ compare: settings.compare.includes('freeze') ? settings.compare.filter((item) => item !== 'freeze') : [...settings.compare, 'freeze'] })

  const resultSection = available ? (
    <section aria-label={analysisName ? 'シナリオ分析の結果' : '結果'} className={analysisName ? 'min-w-0' : 'min-w-0 xl:col-start-2 xl:row-start-1'} data-sma-dynamics-result>
      <h3 className="m-0 mb-1.5 flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text-primary)]">
        <ListChecks size={14} aria-hidden="true" className="shrink-0 text-[var(--color-brand-700)]" />
        {mode === 'solver'
          ? <><span aria-hidden="true" className="inline-grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-brand-900)] text-[11px] font-bold text-white">4</span>結果を見る</>
          : analysisName ? <>シナリオ分析の結果 <span className="font-medium text-[var(--color-text-tertiary)]">「{analysisName}」を仮定</span></> : <>{purpose.label} の結果</>}
      </h3>
      {mode === 'freeze' && <FreezeConclusion result={available} periods={periods} fmt={fmt} />}
      {scenarioWithheld && (
        <Callout data-scenario-result-withheld={presentation.state}>
          選択中のシナリオは表示できないため、SMAを再計算した結果はありません。{SCENARIO_DRAFT_KEPT_NOTE}
        </Callout>
      )}
      {mode === 'scenario' && scenario && (
        <ScenarioConclusion
          result={available}
          evaluation={scenario}
          periods={periods}
          fmt={fmt}
          lead={analysisName ? scenarioResultLead({ result: available, evaluation: scenario, periods }) : undefined}
          premise={evidenceActive && evidenceEnvelope && selectedEntry && evidenceProjection ? (
            <span data-scenario-conclusion-premise>
              <ScenarioOriginBadge origin={evidenceEnvelope.origin} /> {SCENARIO_ORIGIN_COPY[evidenceEnvelope.origin.kind].premise}: 「{selectedEntry.candidate.label}」の{evidenceProjection.closes.length}本の終値で再計算しました。
              T+{evidenceProjection.closes.length} は <b className="font-mono">{fmt(evidenceProjection.closes.at(-1))}</b> (基準日比 {formatPct(evidenceProjection.evaluation.cells.at(-1)?.pctFromAnchor ?? null)})。
            </span>
          ) : undefined}
        />
      )}
      {mode === 'solver' && (solver && base
        ? <SolverConclusion result={available} base={base} model={solver} draft={solverDraft} fmt={fmt} exact={fmtExact} market={security.market} />
        : <Callout>このSMAは現在の足では計算できないため、逆算できません。SMAの選択か時間軸を変えてください。</Callout>)}
    </section>
  ) : null

  // Generic controls. Normal modes: at the top. Scenario Analysis: after the chart, collapsed.
  const controlsBody = (
    <>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]" data-sma-dynamics-intro>
          {analysisName
            ? 'SMAの選択は上の結果とチャートにそのまま反映します。本数や時間軸を変えるとシナリオの条件と合わなくなるため、表示を止めて理由と戻し方を示します。'
            : '上から順に選ぶだけです。初期設定のままでも、下のチャートと結果をすぐ確認できます。'}
        </p>
        <TermHelp />
      </div>

      <GuideStep n={null} title="何を調べますか？">
        <PurposePicker value={mode} disabled={disabled} onChange={selectPurpose} />
      </GuideStep>

      <div className={`grid min-w-0 gap-x-6 gap-y-3 md:grid-cols-2 ${mode === 'solver' ? 'lg:grid-cols-3' : ''}`} data-sma-steps={mode}>
        <GuideStep n={1} title={mode === 'solver' ? 'どの移動平均線？' : '表示する移動平均線'} hint={mode === 'solver' ? 'SMAを1つ選びます' : undefined}>
          {mode === 'solver' ? (
            <SmaPeriodPicker periods={QUICK_PERIODS} selected={[solverTarget]} summaries={available?.periods ?? null} disabled={disabled} onToggle={pickSolverPeriod} label="目標にするSMA (1つ選ぶ)" />
          ) : (
            <SmaPeriodPicker periods={QUICK_PERIODS} selected={settings.periods} summaries={available?.periods ?? null} disabled={disabled} onToggle={togglePeriod} />
          )}
          <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">SMA{mode === 'solver' ? solverTarget : QUICK_PERIODS[0]} = {timeframe.barNoun}{mode === 'solver' ? solverTarget : QUICK_PERIODS[0]}本の確定終値の平均 ({timeframe.name})</span>
          <MoreOptions note={extraSelected.length > 0 ? `追加で表示中: ${extraSelected.join(', ')}` : '10 / 50 / 200 や 3〜300 の任意の期間'}>
            {mode === 'solver' ? (
              <SmaPeriodPicker periods={morePeriods} selected={[solverTarget]} summaries={available?.periods ?? null} disabled={disabled} onToggle={pickSolverPeriod} label="目標にするSMA (その他)" />
            ) : (
              <SmaPeriodPicker periods={morePeriods} selected={settings.periods} summaries={available?.periods ?? null} disabled={disabled} onToggle={togglePeriod} label="表示するSMA (その他)" />
            )}
            <CustomPeriodInput
              selected={settings.periods}
              disabled={disabled}
              onChange={(next) => update({ periods: next })}
              onAdded={mode === 'solver' ? (added) => setSolverDraft({ period: added[0] }) : undefined}
            />
          </MoreOptions>
          {mode === 'solver' && currentDirection && <CurrentDirectionCard state={currentDirection} />}
        </GuideStep>

        {mode === 'solver' ? (
          <>
            <GuideStep n={2} title="どの範囲で？" hint="範囲と本数 N を選びます">
              <SolverScopePicker timeframe={settings.timeframe} kind={solverDraft.kind} n={solverActiveK} onPick={(scope) => setSolverDraft({ kind: scope })} />
              <SolverTimingPicker
                timeframe={settings.timeframe}
                kind={solverDraft.kind}
                value={solverActiveK}
                maxK={solverMaxK}
                futureBars={available?.projection.bars}
                onPick={pickTiming}
              />
            </GuideStep>
            <GuideStep n={3} title="どう動いてほしい？" hint={solverDirectionHint(solverDraft.kind)}>
              <SolverDirectionPicker draft={solverDraft} onDraftChange={setSolverDraft} />
              <SolverKindPicker draft={solverDraft} onDraftChange={setSolverDraft} />
            </GuideStep>
          </>
        ) : (
          <GuideStep n={2} title="何本先まで見る？">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <SegmentedControl
                label={`将来投影の本数 (${timeframe.barNoun})`}
                hideLabel
                value={settings.horizon}
                options={QUICK_HORIZONS.filter((value) => horizonOptions.includes(value)).map((value) => ({ value, label: `${value}本`, title: describeHorizon(settings.timeframe, value) }))}
                disabled={disabled}
                onChange={(horizon) => update({ horizon })}
              />
              <span className="text-[11px] font-medium text-[var(--color-text-secondary)]" data-sma-dynamics-horizon-unit>
                {describeHorizon(settings.timeframe, settings.horizon, available?.projection.bars)}
              </span>
            </div>
            {moreHorizons.length > 0 && (
              <MoreOptions label="ほかの本数 (1〜20)" note={QUICK_HORIZONS.includes(settings.horizon) ? undefined : `現在 ${settings.horizon}本`} open={!QUICK_HORIZONS.includes(settings.horizon)}>
                <HorizonSelect label={`将来投影の本数 (その他, ${timeframe.barNoun})`} options={moreHorizons} value={settings.horizon} disabled={disabled} onChange={(horizon) => update({ horizon })} />
              </MoreOptions>
            )}
          </GuideStep>
        )}
      </div>

      {mode === 'solver' && solverGoalNow && currentDirection && (
        <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2.5 py-1.5 text-[12px] font-bold leading-5 text-[var(--color-text-primary)]" data-sma-solver-selection>
          <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">調べる条件</span>
          {goalCondition(solverGoalNow, solverWordingBase)}
        </p>
      )}

      <AdvancedSettings summary={`時間軸 ${timeframe.label} ・ 表示期間 ${rangeLabel} ・ SMA ${periods.length > 0 ? periods.join('/') : 'なし'}`}>
        <ControlRow label="時間軸">
          <SegmentedControl
            label="時間軸 (ローソク足1本の期間)"
            hideLabel
            value={settings.timeframe}
            options={SMA_LAB_TIMEFRAMES.map((item) => ({ value: item.id, label: item.label, title: item.name }))}
            disabled={disabled}
            onChange={selectTimeframe}
          />
          <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{timeframe.name} ・ SMA N = {timeframe.barNoun} N本の確定終値の平均</span>
        </ControlRow>
        <ControlRow label="表示期間">
          <SegmentedControl
            label="表示期間 (画面に表示する過去の範囲)"
            hideLabel
            value={settings.range}
            options={SMA_LAB_RANGES.map((item) => ({ value: item.id, label: item.label }))}
            disabled={disabled}
            onChange={(range) => update({ range })}
          />
        </ControlRow>
        {mode === 'solver' && (
          <ControlRow label="将来投影">
            <HorizonSelect label={`将来投影の本数・全て (${timeframe.barNoun})`} options={horizonOptions} value={settings.horizon} disabled={disabled} onChange={(horizon) => update({ horizon })} />
            <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">{describeHorizon(settings.timeframe, settings.horizon, available?.projection.bars)}</span>
          </ControlRow>
        )}
        <ControlRow label="チャート">
          <SegmentedControl
            label="表示"
            value={settings.focus}
            options={SMA_LAB_FOCUS_OPTIONS.map((item) => ({ value: item.id, label: item.label }))}
            disabled={disabled}
            onChange={(focus) => update({ focus })}
          />
          <div role="group" aria-label="比較表示 (淡色で重ねる仮定)" className="flex flex-wrap items-center gap-1" data-sma-dynamics-compare>
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">比較</span>
            {compareOptions.map((id) => {
              const on = settings.compare.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  disabled={!overlayAvailable[id]}
                  title={overlayAvailable[id] ? `${SMA_LAB_OVERLAY_LABEL[id]}を淡色で重ねる` : `${SMA_LAB_OVERLAY_LABEL[id]}はまだありません`}
                  onClick={() => update({ compare: on ? settings.compare.filter((item) => item !== id) : [...settings.compare, id] })}
                  className={`inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border px-2 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-7 ${
                    on ? 'border-[var(--color-border-strong)] bg-white text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)]'
                  }`}
                >
                  {on && <span aria-hidden="true">✓ </span>}{SMA_LAB_OVERLAY_LABEL[id]}
                </button>
              )
            })}
          </div>
        </ControlRow>
        {mode === 'solver' && <SolverAdvanced draft={solverDraft} constraintErrors={parsedConstraints.errors} onDraftChange={setSolverDraft} />}
      </AdvancedSettings>
    </>
  )

  return (
    <section
      ref={rootRef}
      className={expanded
        ? 'fixed inset-0 z-[80] flex flex-col overflow-y-auto bg-white outline-none'
        : 'overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white outline-none'}
      aria-labelledby={titleId}
      tabIndex={-1}
      aria-modal={maximized || undefined}
      role={maximized ? 'dialog' : undefined}
      data-section="SMA dynamics"
      data-expanded={expanded || undefined}
      onFocus={() => { focusWithinRef.current = true }}
      // A removed element blurs with no relatedTarget; only a move to a known outside node clears the flag.
      onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusWithinRef.current = false }}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 pb-2 pt-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 id={titleId} className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">{SMA_DYNAMICS_TITLE}</h2>
            <span className="font-mono text-[12px] font-bold text-[var(--color-brand-800)]" data-sma-dynamics-security>
              {securityLabel(security)}
            </span>
          </div>
          <p className="m-0 mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]" data-sma-dynamics-subtitle data-mode={mode} data-scenario-analysis-active={analysisName ? true : undefined}>{analysisName ? scenarioAnalysisTitle(analysisName) : SMA_MODE_SUBTITLE[mode]}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {available && (
            <p className="m-0 mr-1 font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)]" data-sma-dynamics-asof>
              基準日 <b className="text-[var(--color-text-primary)]">{available.asOf.date}</b>
              <span aria-hidden="true"> ・ </span>
              {SMA_ANCHOR_CLOSE_LABEL} <b className="text-[var(--color-text-primary)]">{fmt(available.asOf.close)}</b>
            </p>
          )}
          <button type="button" className="btn max-sm:min-h-11! max-sm:min-w-11!" data-size="sm" onClick={() => setMaximized((value) => !value)} aria-pressed={maximized} title={maximized ? '元のサイズに戻す (Esc)' : 'チャートを最大化'}>
            {maximized ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
            <span>{maximized ? '戻す' : '最大化'}</span>
          </button>
          {maximized && (
            <button type="button" className="btn max-sm:min-h-11! max-sm:min-w-11!" data-size="sm" onClick={() => setMaximized(false)} aria-label="最大化を閉じる">
              <X size={13} aria-hidden="true" />
            </button>
          )}
          {onCollapse && !expanded && (
            <button type="button" className="btn max-sm:min-h-11! max-sm:min-w-11!" data-size="sm" onClick={onCollapse} title="SMA Dynamics Lab を閉じる">
              <ChevronUp size={13} aria-hidden="true" />
              <span className="max-sm:sr-only">閉じる</span>
            </button>
          )}
        </div>
      </header>

      {linkIntent?.origin && (
        <LinkOriginNotice intent={linkIntent} latestDate={available?.asOf.date ?? null} />
      )}

      {externalScenarios && (
        <section aria-labelledby={evidenceTitleId} className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border-soft)] px-3 py-3 sm:px-4" data-sma-scenario-evidence>
          <div className="min-w-0">
            <h3 id={evidenceTitleId} className="m-0 text-[13px] font-bold text-[var(--color-text-primary)]">{SMA_SCENARIO_EVIDENCE_TITLE}</h3>
            <p className="m-0 mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">{SMA_SCENARIO_EVIDENCE_INTRO}</p>
          </div>
          {evidenceEntries ? (
            <ScenarioEvidencePicker
              entries={evidenceEntries}
              direction={evidence.direction}
              selectedId={evidence.selectedId}
              disabled={disabled}
              barNoun={timeframe.barNoun}
              onDirection={(direction) => setEvidence({ direction, selectedId: null })}
              onSelect={selectEvidence}
            />
          ) : (
            <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]" data-scenario-waiting>価格履歴を読み込むと選べます。</p>
          )}
          {(presentation.state === 'evidence_unavailable' || presentation.state === 'evidence_alignable') && (
            selectedEntry && activeValidation && activeValidation.status !== 'projectable'
              ? <ScenarioEvidenceStatus entry={{ ...selectedEntry, validation: activeValidation }} onAlign={alignToEvidence} onClear={clearEvidenceSelection} />
              : <ScenarioSelectionUnavailable cause={presentation.state === 'evidence_unavailable' ? presentation.cause : { kind: 'projection_failed' }} onClear={clearEvidenceSelection} />
          )}
          {analysisName && evidenceEnvelope && evidenceProjection && (
            <ScenarioAnalysisHeader
              titleId={analysisTitleId}
              name={analysisName}
              envelope={evidenceEnvelope}
              barCount={evidenceProjection.closes.length}
              barNoun={timeframe.barNoun}
              fmt={fmt}
              freezeCompared={settings.compare.includes('freeze')}
              onEdit={() => handOffEvidence('scenario')}
              onSolve={() => handOffEvidence('solver')}
              onToggleFreeze={toggleFreezeCompare}
              onClear={clearEvidenceSelection}
            />
          )}
          {/* Always mounted so starting/ending the Scenario Analysis state is announced. */}
          <p className="sr-only" aria-live="polite" data-scenario-live>{scenarioAnalysisAnnouncement(analysisName)}</p>
        </section>
      )}

      {!analysisName && (
        <div ref={controlsRef} tabIndex={-1} className="flex flex-col gap-2.5 border-t border-[var(--color-border-soft)] px-3 py-3 outline-none sm:px-4" data-sma-dynamics-controls>
          {controlsBody}
        </div>
      )}

      {/* The editor belongs to the user-draft state only; any selection hides it (the draft is untouched). */}
      {available && base && mode === 'scenario' && showsUserDraftEditor(presentation) && scenario && scenarioDraft && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-3 sm:px-4" data-sma-dynamics-mode-panel="scenario">
          {handoff && handoffPath && <ScenarioHandoffNote record={handoff} path={handoffPath} />}
          <h3 className="m-0 mb-1.5 text-[12px] font-bold text-[var(--color-text-primary)]">将来の終値を入力 <span className="font-medium text-[var(--color-text-tertiary)]">基準日の終値 {fmt(available.asOf.close)} からの {timeframe.barNoun}ごとの価格</span></h3>
          <ScenarioEditor result={available} base={base} draft={scenarioDraft} evaluation={scenario} fmt={fmt} displayUnit={displayUnit(security.market)} onChange={setScenarioDraft} />
        </div>
      )}

      {load.status === 'loading' && <StateBand busy>価格履歴を読み込み中…</StateBand>}
      {load.status === 'error' && <StateBand>価格履歴を取得できませんでした ({load.message})。この銘柄のSMAは表示していません。</StateBand>}
      {load.status === 'unconnected' && <StateBand>{load.message}</StateBand>}
      {result?.status === 'unavailable' && <StateBand>{describeSmaLabUnavailable(result.reason, result.anchorDate)}</StateBand>}
      {!available && <div className="border-t border-[var(--color-border-soft)] px-3 py-2 sm:px-4">{premise}</div>}

      {available && model && (
        <div
          className={analysisName
            ? 'flex min-w-0 flex-col gap-3 border-t border-[var(--color-border-soft)] px-3 py-3 sm:px-4'
            : 'grid min-w-0 gap-x-5 gap-y-3 border-t border-[var(--color-border-soft)] px-3 py-3 sm:px-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]'}
          data-sma-dynamics-layout={analysisName ? 'result-first' : 'chart-side'}
        >
          {/* Scenario Analysis: result first, then the full-width chart. */}
          {analysisName && resultSection}
          <div className={analysisName ? 'flex min-w-0 flex-col gap-2' : 'flex min-w-0 flex-col gap-2 xl:col-start-1 xl:row-start-1'}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                {timeframe.name} ・ ホイールで拡大縮小、ドラッグで移動
              </p>
              <div role="group" aria-label="チャート操作" className="flex flex-wrap items-center gap-1">
                <IconButton label="縮小 (−)" onClick={() => chartRef.current?.zoom(ZOOM_OUT_FACTOR)}><ZoomOut size={14} aria-hidden="true" /></IconButton>
                <IconButton label="拡大 (+)" onClick={() => chartRef.current?.zoom(ZOOM_IN_FACTOR)}><ZoomIn size={14} aria-hidden="true" /></IconButton>
                <IconButton label="表示範囲をリセット" onClick={() => chartRef.current?.reset()}><RotateCcw size={14} aria-hidden="true" /></IconButton>
                {fullscreenSupported && (
                  <IconButton label={fullscreen ? '全画面を終了' : '全画面表示'} onClick={toggleFullscreen} pressed={fullscreen}>
                    {fullscreen ? <Shrink size={14} aria-hidden="true" /> : <Expand size={14} aria-hidden="true" />}
                  </IconButton>
                )}
              </div>
            </div>

            {barsInRange < SMA_LAB_FEW_BARS && settings.range !== 'all' && (
              <FewBarsNotice
                count={barsInRange}
                rangeLabel={rangeLabel}
                barNoun={timeframe.barNoun}
                current={settings.range}
                onSelect={(range) => update({ range })}
              />
            )}

            {mode === 'solver' && handoff && handoffPath && (
              <SolverHandoffCallout
                record={handoff}
                path={handoffPath}
                fmt={fmt}
                comparisonOnChart={shows('scenario') && overlayAvailable.scenario}
                solverOnChart={shows('solver') && overlayAvailable.solver}
                onRestoreView={handoffPath.status === 'out_of_scope' && !handoffPath.mismatches.includes('as_of')
                  ? () => update({ timeframe: handoff.timeframe, horizon: handoff.horizon })
                  : undefined}
              />
            )}
            <SlotReadout id={readoutId} result={available} model={model} slot={hoverSlot ?? model.anchorSlot} periods={periods} fmt={fmt} layers={readoutLayers} />
            <SmaDynamicsChart
              model={model}
              periods={periods}
              viewRange={viewRange}
              viewKey={viewKey}
              priceDigits={priceDigits(security.market)}
              height={expanded ? EXPANDED_CHART_HEIGHT : INLINE_CHART_HEIGHT}
              label={`${securityLabel(security)} の ${timeframe.name} とSMA。ホイールで拡大縮小、ドラッグで移動、左右キーで足を移動`}
              describedBy={readoutId}
              onHoverSlot={setHoverSlot}
              handleRef={chartRef}
              futureLabel={scenarioWithheld ? '仮定 (表示なし)' : `仮定 (${overlayLabel(primaryOverlay)})`}
            />
            <ChartLegend
              hasForming={available.formingIndex != null}
              hasIncomplete={available.bars.some((bar) => bar.phase === 'confirmed' && !bar.ohlcComplete && bar.open != null)}
              freeze={freezeEmphasis}
              overlays={model.overlays.map((overlay) => ({ id: overlay.id, label: overlayLabel(overlay.id), muted: overlay.emphasis === 'muted' }))}
              hasBoundary={model.boundaries.length > 0}
            />
            {unavailablePeriods.length > 0 && (
              <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0 text-[11px] font-medium text-amber-800" data-sma-dynamics-period-notes>
                {unavailablePeriods.map((summary) => (
                  <li key={summary.period}><span className="font-mono font-bold">SMA{summary.period}</span>: {periodStatusText(summary, timeframe.barNoun)}</li>
                ))}
              </ul>
            )}
            {mode === 'solver' && solver && <SolverChartCaption model={solver} boundaries={boundaries} wording={solverWordingBase} hasHighlight={highlights.length > 0} />}
            {premise}
          </div>
          {!analysisName && resultSection}
        </div>
      )}

      {/* Scenario Analysis: every control stays available, after the result and chart. */}
      {analysisName && (
        <DetailsSection
          title="表示条件を変更"
          meta={`SMA ${periods.length > 0 ? periods.join('/') : 'なし'} ・ ${timeframe.label} ・ ${settings.horizon}本先 ・ 表示期間 ${rangeLabel}`}
          data-sma-dynamics-controls-disclosure
        >
          <div ref={controlsRef} tabIndex={-1} className="flex flex-col gap-2.5 outline-none" data-sma-dynamics-controls>
            {controlsBody}
          </div>
        </DetailsSection>
      )}

      {available && base && mode === 'freeze' && (
        <DetailsSection title="SMAの数値表" meta={`最終確定足 → T+${available.projection.bars.length} ・ 終値差と変化率`} data-sma-dynamics-summary>
          <SummaryTable
            result={available}
            periods={periods}
            fmt={fmt}
            statusText={(period) => periodStatusText(available.periods.find((item) => item.period === period)!, timeframe.barNoun)}
          />
        </DetailsSection>
      )}
      {available && mode === 'freeze' && <FutureValuesDetails result={available} periods={periods} fmt={fmt} />}
      {analysisName && evidenceEnvelope && evidenceProjection && (
        <DetailsSection title="仮定した終値の表" meta={`T+1〜T+${evidenceProjection.closes.length} ・ 日付・仮定終値・基準日比`} data-scenario-closes-details>
          <ScenarioAssumedCloses envelope={evidenceEnvelope} closes={evidenceProjection.closes} fmt={fmt} />
        </DetailsSection>
      )}
      {selectedEntry && activeValidation?.envelope && (
        <DetailsSection title="シナリオの由来と前提" meta={`${SCENARIO_ORIGIN_COPY[activeValidation.envelope.origin.kind].label} ・ 版・価格の基準・カレンダー・完全性`} data-sma-scenario-evidence-details>
          <ScenarioEvidenceDetails envelope={activeValidation.envelope} />
        </DetailsSection>
      )}
      {available && base && mode === 'scenario' && showsUserDraftEditor(presentation) && scenario && scenarioDraft && (
        <DetailsSection title="計算表と細かい入力" meta="足ごとのSMA・一括入力・価格固定との比較" data-sma-dynamics-mode-panel="scenario-details">
          <ScenarioDetails result={available} base={base} draft={scenarioDraft} evaluation={scenario} periods={periods} fmt={fmt} onChange={setScenarioDraft} />
        </DetailsSection>
      )}
      {available && base && mode === 'solver' && solver && (
        <DetailsSection title="必要な価格条件と代表経路の詳細" meta="条件の根拠・補助条件の切替・不成立の例" data-sma-dynamics-mode-panel="solver">
          <div className="flex min-w-0 flex-col gap-2.5" data-sma-solver-panel data-sma-solver-result>
            <SolverDetails result={available} base={base} model={solver} draft={solverDraft} fmt={fmt} exact={fmtExact} market={security.market} onDraftChange={setSolverDraft} onCopyToScenario={copyToScenario} />
          </div>
        </DetailsSection>
      )}
      {available && base && shapeSource && (
        <DetailsSection
          open={linkIntent?.pair != null || undefined}
          title="SMAの形 (傾き・曲率・交差・収束と拡散・位置関係)"
          meta={`${shapeSource.label} を仮定 ・ 表示中のSMA ${shapeSource.usable.length}本`}
          data-sma-dynamics-shape
        >
          <SmaShapePanel timeline={shapeSource.timeline} periods={shapeSource.usable} labels={shapeSource.labels} sourceLabel={shapeSource.label} barNoun={timeframe.barNoun} />
        </DetailsSection>
      )}
      {available && base && (
        <DetailsSection open={linkIntent?.pair != null || undefined} title="接触・交差の逆算" meta="終値やSMAが別のSMAに触れる・抜けるための終値" data-sma-dynamics-crossing>
          <SmaCrossingPanel
            result={available}
            base={base}
            periods={periods}
            scenarioCloses={scenarioComplete}
            fmt={fmt}
            unit={priceUnit(security.market)}
            displayUnit={displayUnit(security.market)}
            onCopyToScenario={copyToScenario}
            initialPair={linkIntent?.pair ?? null}
          />
        </DetailsSection>
      )}
      {result && result.issues.length > 0 && <IssuesBand issues={result.issues} />}
      <SourceFooter security={security} dataSource={dataSource} result={available} analysisDate={analysisDate} />
    </section>
  )
}

/** Words for what the chart shows: current direction, target direction, and which price levels exist. */
export function SolverChartCaption({ model, boundaries, wording, hasHighlight }: { model: SolverViewModel; boundaries: ReadonlyArray<SmaLabBoundaryLine>; wording: WordingContext; hasHighlight: boolean }) {
  const { analysis, goal } = model
  const current = wording.current
  const target = goal.kind === 'reversal' ? goal.to : goal.kind === 'level' ? goal.relation : goal.direction
  const dependent = priceCondition(analysis, wording).pathDependent
  const note =
    analysis.status !== 'feasible' ? '条件を満たす価格がないため、境界線は引いていません。'
    : boundaries.length === 1 && boundaries[0].k != null ? `短い破線 = ${boundaries[0].label}。境界の上側と下側で向きが分かれます。`
    : boundaries.length > 1 ? `短い破線 = 足ごとの境界価格 (各足に別々の条件があり、1本の水平線にはなりません)${boundaries.length >= MAX_BOUNDARY_MARKERS ? `。先頭${MAX_BOUNDARY_MARKERS}本まで表示` : ''}。`
    : dependent ? '条件が仮定した別の足の価格に依存するため、単独の境界線は引いていません (代表経路の線だけを表示)。'
    : '平均や水準の条件のため、1本の境界線にはなりません。'
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]" data-sma-solver-chart-caption>
      <span>現在 {current ? <DirectionBadge direction={current} /> : '向き不明'}</span>
      <span aria-hidden="true">→</span>
      <span>目標 {goal.kind === 'level' ? '基準日より' : ''}<DirectionBadge direction={target} /></span>
      <span className="text-[var(--color-text-tertiary)]">{note}</span>
      {hasHighlight && (
        <span className="text-[var(--color-text-tertiary)]" data-sma-solver-hit-caption>
          {isSingleBarSameDirection(goal)
            ? '◎ = 次の1本で条件を確認する地点です。ホバー・フォーカス・タップで日付、仮定終値、SMA、向きを表示します。'
            : `◎ = 選択中の代表経路で最初に${goal.kind === 'reversal' ? '転換する' : '到達する'}足です。ホバー・フォーカス・タップで日付、仮定終値、SMA、前後の向きを表示します。全経路で最も早い足ではありません。`}
        </span>
      )}
    </p>
  )
}

/** Says where the lab was opened from and flags a candidate whose data date differs from the loaded history. */
export function LinkOriginNotice({ intent, latestDate }: { intent: SmaLinkIntent; latestDate: string | null }) {
  const origin = intent.origin ? SMA_LINK_ORIGIN_LABEL[intent.origin] : null
  if (!origin) return null
  const stale = intent.asOfTradingDate != null && latestDate != null && intent.asOfTradingDate !== latestDate
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-[var(--color-border-soft)] px-3 py-2 sm:px-4" data-sma-link-origin={intent.origin}>
      <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">
        <b>{origin}</b>から開きました。
        {intent.asOfTradingDate && <> 候補の基準日 <span className="font-mono">{intent.asOfTradingDate}</span></>}
        {intent.sourceGeneration && <> ・ データ世代 <span className="font-mono">{intent.sourceGeneration}</span></>}
        {intent.pair && <> ・ 注目するSMA <span className="font-mono">{intent.pair[0]}/{intent.pair[1]}</span></>}
        。ここでの計算は、この画面の価格履歴だけを使います。
      </p>
      {stale && (
        <Callout tone="warn" data-sma-link-asof-mismatch>
          候補の基準日 ({intent.asOfTradingDate}) と、この画面の価格履歴の最新日 ({latestDate}) が異なります。数値は{latestDate}時点のものです。
        </Callout>
      )}
    </div>
  )
}

function IconButton({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] sm:min-h-8 sm:min-w-8"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function StateBand({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      role="status"
      aria-busy={busy || undefined}
      className="flex min-h-[160px] items-center justify-center border-t border-[var(--color-border-soft)] px-3 py-6 text-center text-[12px] font-medium text-[var(--color-text-tertiary)] sm:px-4"
    >
      {children}
    </div>
  )
}

function FewBarsNotice({
  count,
  rangeLabel,
  barNoun,
  current,
  onSelect,
}: {
  count: number
  rangeLabel: string
  barNoun: string
  current: SmaLabRangeId
  onSelect: (range: SmaLabRangeId) => void
}) {
  const index = SMA_LAB_RANGES.findIndex((item) => item.id === current)
  const wider = SMA_LAB_RANGES.slice(index + 1).filter((item) => item.id === '3y' || item.id === 'all' || item.id === '1y').slice(0, 2)
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-900" data-sma-dynamics-few-bars>
      <span>表示期間「{rangeLabel}」に含まれる{barNoun}は {count}本です。時間軸は変更していません。</span>
      {wider.map((item) => (
        <button key={item.id} type="button" className="inline-flex items-center font-bold text-[var(--color-brand-700)] underline underline-offset-2 max-sm:min-h-11" onClick={() => onSelect(item.id)}>
          {item.label}で表示
        </button>
      ))}
    </div>
  )
}

function SourceFooter({
  security,
  dataSource,
  result,
  analysisDate,
}: {
  security: SmaDynamicsSecurity
  dataSource: SmaDynamicsDataSourceInfo
  result: SmaLabAvailable | null
  analysisDate: string | null
}) {
  return (
    <footer className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)] sm:px-4" data-sma-dynamics-source>
      <p className="m-0">
        データ: {dataSource.label} ・ 価格: {dataSource.priceBasis} ・ カレンダー: {result?.calendar.label ?? (security.market === 'US' ? '米国取引所カレンダー' : '東証カレンダー')} (半日取引も1営業日)
        {analysisDate && <> ・ 分析基準日 {analysisDate} より後の価格は使用しません</>}
        {result && result.excludedAfterBoundary > 0 && <> ({result.excludedAfterBoundary}行を除外)</>}
      </p>
      <p className="m-0">{SMA_DYNAMICS_GROUPING_NOTE}</p>
    </footer>
  )
}
