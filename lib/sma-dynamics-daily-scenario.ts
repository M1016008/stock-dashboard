// SMA Dynamics Lab: ONE shared daily future-close scenario projected onto all 15 timeframes.
//
// The user types closes for the next market sessions (T+1, T+2, … as dates of the market calendar).
// The same daily path feeds every timeframe's bars:
//
//   confirmed    every session through the bar's last session is explicitly entered. The bar's
//                close is the close of its last session and it enters the SMA window.
//   provisional  the entries (contiguous from T+1) reach into the bar but not to its last session.
//                A provisional SMA uses the latest entered close; it is never a confirmed close
//                and never feeds a later bar.
//   unentered    nothing contiguous reaches the bar.
//
// Nothing is inferred: a missing, invalid or non-contiguous session is never filled, and a gap
// stops confirmation of every later bar (entries after a gap are counted but unusable).
// Confirmed closes are projected with projectSmaPath, the same rolling-window engine as the
// selected-timeframe scenario, Price Freeze and the inverse solver.
import {
  projectSmaPath,
  smaLabConfirmedCloses,
  type SmaLabAvailable,
  type SmaLabResult,
} from '@/lib/sma-dynamics-lab'
import {
  addCalendarDays,
  bucketForDate,
  nextBucket,
  nextSessionAfter,
  sessionsBetween,
  smaLabCalendar,
  SMA_LAB_TIMEFRAMES,
  type SmaLabBucket,
  type SmaLabCalendar,
  type SmaLabTimeframeId,
} from '@/lib/sma-dynamics-timeframes'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import {
  clearScenario,
  convertScenarioUnit,
  DAILY_SCENARIO_MAX_SESSIONS,
  presetConstantRate,
  presetFreeze,
  presetShock,
  scenarioCellClose,
  scenarioFromCloses,
  setScenarioInput,
  cleanFloat,
  type DailyScenarioDraft,
  type ForwardBase,
  type ScenarioCell,
  type ScenarioDraft,
  type ScenarioUnit,
  type ShockAftermath,
} from '@/lib/sma-dynamics-scenario'

// ---------------------------------------------------------------------------
// Sessions and entry evaluation

/** The next `count` market sessions strictly after `asOf`. Throws RangeError outside the supported calendar. */
export function dailyFutureSessions(calendar: SmaLabCalendar, asOf: string, count: number): string[] {
  const out: string[] = []
  let cursor = asOf
  for (let i = 0; i < count; i += 1) {
    cursor = nextSessionAfter(calendar, cursor)
    out.push(cursor)
  }
  return out
}

export interface DailyScenarioCell extends ScenarioCell {
  /** Market session this entry is the close of. */
  date: string
}

export interface DailyScenarioEvaluation {
  cells: DailyScenarioCell[]
  /** Usable close per session; null = missing or rejected input. Never filled in. */
  closes: Array<number | null>
  filled: number
  /** Leading sessions that are all usable: only these can confirm bars. */
  enteredThrough: number
  missingK: number[]
  invalidK: number[]
  state: 'empty' | 'partial' | 'complete'
}

/** Only the as-of close is needed to read an entry; the rest of the base is unused by scenarioCellClose. */
function pseudoBase(anchorClose: number, horizon: number): ForwardBase {
  return { confirmedCloses: [], anchorIndex: -1, anchorClose, horizon }
}

export function evaluateDailyScenario(anchorClose: number, sessions: readonly string[], draft: DailyScenarioDraft): DailyScenarioEvaluation {
  const base = pseudoBase(anchorClose, sessions.length)
  const cells = sessions.map((date, index): DailyScenarioCell => {
    const raw = draft.inputs[index] ?? ''
    return { k: index + 1, date, raw, ...scenarioCellClose(base, draft.unit, raw) }
  })
  const closes = cells.map((cell) => cell.close)
  const filled = cells.filter((cell) => cell.status === 'ok').length
  let enteredThrough = 0
  while (enteredThrough < cells.length && cells[enteredThrough].status === 'ok') enteredThrough += 1
  return {
    cells,
    closes,
    filled,
    enteredThrough,
    missingK: cells.filter((cell) => cell.status === 'missing').map((cell) => cell.k),
    invalidK: cells.filter((cell) => cell.status === 'invalid' || cell.status === 'non_positive').map((cell) => cell.k),
    state: filled === 0 ? 'empty' : filled === cells.length ? 'complete' : 'partial',
  }
}

// ---------------------------------------------------------------------------
// Draft editing (pure; presets reuse the selected-timeframe presets on a daily "bar" = one session)

function asDaily(draft: DailyScenarioDraft, next: ScenarioDraft): DailyScenarioDraft {
  return { ...next, sessions: draft.sessions }
}

export function setDailySessions(draft: DailyScenarioDraft, sessions: number): DailyScenarioDraft {
  const count = Math.min(Math.max(1, Math.floor(sessions)), DAILY_SCENARIO_MAX_SESSIONS)
  const inputs = draft.inputs.length >= count ? draft.inputs : [...draft.inputs, ...Array<string>(count - draft.inputs.length).fill('')]
  return { ...draft, sessions: count, inputs }
}

export function setDailyInput(draft: DailyScenarioDraft, k: number, raw: string): DailyScenarioDraft {
  return asDaily(draft, setScenarioInput(draft, k, raw))
}

export function clearDaily(anchorClose: number, draft: DailyScenarioDraft): DailyScenarioDraft {
  return asDaily(draft, clearScenario(pseudoBase(anchorClose, draft.sessions), draft))
}

export function convertDailyUnit(anchorClose: number, draft: DailyScenarioDraft, unit: ScenarioUnit): DailyScenarioDraft {
  return asDaily(draft, convertScenarioUnit(pseudoBase(anchorClose, draft.sessions), draft, unit))
}

/** Every session closes at the as-of close. */
export function dailyPresetFlat(anchorClose: number, draft: DailyScenarioDraft): DailyScenarioDraft {
  return asDaily(draft, presetFreeze(pseudoBase(anchorClose, draft.sessions), draft))
}

/** x_k = P0 × (1 + r)^k, r per session. */
export function dailyPresetRate(anchorClose: number, draft: DailyScenarioDraft, ratePctPerSession: number): DailyScenarioDraft {
  return asDaily(draft, presetConstantRate(pseudoBase(anchorClose, draft.sessions), draft, ratePctPerSession))
}

/** One-off jump at session `atSession`, then held or walking back to the as-of close at the last session. */
export function dailyPresetShock(anchorClose: number, draft: DailyScenarioDraft, shockPct: number, atSession: number, aftermath: ShockAftermath): DailyScenarioDraft {
  return asDaily(draft, presetShock(pseudoBase(anchorClose, draft.sessions), draft, shockPct, atSession, aftermath))
}

export type DailyTargetDistribution = 'even' | 'first' | 'final'
export const DAILY_TARGET_DISTRIBUTIONS: ReadonlyArray<{ id: DailyTargetDistribution; label: string; title: string }> = [
  { id: 'even', label: '均等', title: '目標の変化を毎営業日に等分 (現値比の直線)。最終営業日に目標へ到達' },
  { id: 'first', label: '初日に集中', title: '最初の営業日に目標へ一気に動き、その水準が続く' },
  { id: 'final', label: '最終日に集中', title: '最終営業日まで現値のまま、最終営業日に目標へ一気に動く' },
]

/**
 * Closes that move the price by `targetPct` (relative to the as-of close) over the draft's sessions:
 * even = straight line, first = all on T+1 (held), final = flat until the last session.
 */
export function dailyTargetCloses(anchorClose: number, sessions: number, targetPct: number, distribution: DailyTargetDistribution): number[] {
  const target = cleanFloat(anchorClose * (1 + targetPct / 100))
  return Array.from({ length: sessions }, (_, i) => {
    const k = i + 1
    if (distribution === 'first') return target
    if (distribution === 'final') return k === sessions ? target : anchorClose
    return cleanFloat(anchorClose * (1 + (targetPct / 100) * (k / sessions)))
  })
}

export function dailyPresetTarget(anchorClose: number, draft: DailyScenarioDraft, targetPct: number, distribution: DailyTargetDistribution): DailyScenarioDraft {
  const closes = dailyTargetCloses(anchorClose, draft.sessions, targetPct, distribution)
  const leading = scenarioFromCloses(pseudoBase(anchorClose, draft.sessions), closes, draft.unit)
  return { ...draft, inputs: [...leading.inputs, ...draft.inputs.slice(leading.inputs.length)] }
}

// ---------------------------------------------------------------------------
// Projection onto every timeframe

export type DailyBarPhase = 'confirmed' | 'provisional' | 'unentered'

export interface DailyProjectedBar {
  /** 1-based among this timeframe's projected bars; aligned with SmaLabAvailable.projection.bars. */
  k: number
  key: string
  periodStart: string
  periodEnd: string
  firstSession: string
  lastSession: string
  /** The bar already started (contains the as-of date); the scenario completes it. */
  completesForming: boolean
  /** Market sessions after the as-of date up to and including lastSession, counted from T+1 cumulatively. */
  sessionsAheadEnd: number
  /** Sessions after the as-of date inside this bar. */
  requiredSessions: number
  /** Leading entered sessions inside this bar (usable). */
  enteredSessions: number
  /** Entered sessions inside this bar that cannot be used because an earlier session is missing. */
  isolatedSessions: number
  phase: DailyBarPhase
  /** Close of lastSession; only for confirmed bars. */
  close: number | null
  /** Latest entered close; only for the provisional bar. Never feeds a later bar. */
  provisionalClose: number | null
}

export interface DailyPeriodSummary {
  period: number
  /** SMA at the last confirmed bar of the history. */
  anchor: number | null
  /** SMA at the last confirmed projected bar, null if none or the window is incomplete. */
  latestConfirmed: number | null
  latestConfirmedPct: number | null
  /** SMA with the provisional close in the open bar; null without one. */
  provisional: number | null
  provisionalPct: number | null
}

export type DailyTimeframeUnavailable = 'lab_unavailable' | 'calendar_range'

export type DailyTimeframeProjection =
  | {
    status: 'available'
    timeframe: SmaLabTimeframeId
    lab: SmaLabAvailable
    bars: DailyProjectedBar[]
    confirmedBars: number
    /** Index in `bars` of the provisional bar, or null. */
    provisionalIndex: number | null
    /** Confirmed SMA per projected bar (null unless the bar is confirmed and its whole window is). */
    sma: Record<number, Array<number | null>>
    /** Provisional SMA, non-null only at provisionalIndex. */
    provisionalSma: Record<number, Array<number | null>>
    periods: DailyPeriodSummary[]
  }
  | { status: 'unavailable'; timeframe: SmaLabTimeframeId; reason: DailyTimeframeUnavailable }

export interface DailyScenarioProjection {
  market: SmaDynamicsMarket
  asOf: string
  anchorClose: number
  sessions: string[]
  evaluation: DailyScenarioEvaluation
  timeframes: DailyTimeframeProjection[]
}

function pct(value: number | null, anchor: number | null): number | null {
  return value != null && anchor != null && anchor !== 0 ? ((value - anchor) / anchor) * 100 : null
}

function projectOntoTimeframe(args: {
  calendar: SmaLabCalendar
  lab: SmaLabAvailable
  evaluation: DailyScenarioEvaluation
  sessionCount: number
}): DailyTimeframeProjection {
  const { calendar, lab, evaluation, sessionCount } = args
  const timeframe = lab.timeframe
  const spec = SMA_LAB_TIMEFRAMES.find((item) => item.id === timeframe)!.spec
  const asOf = lab.asOf.date
  const firstFutureDay = addCalendarDays(asOf, 1)
  const formingKey = lab.formingIndex == null ? null : lab.bars[lab.formingIndex].key
  const cells = evaluation.cells
  const E = evaluation.enteredThrough

  let buckets: SmaLabBucket[]
  try {
    let bucket = bucketForDate(calendar, spec, asOf)
    if (bucket.sessions.at(-1)! <= asOf) bucket = nextBucket(calendar, spec, bucket)
    buckets = [bucket]
    let ahead = sessionsBetween(calendar, firstFutureDay, bucket.sessions.at(-1)!).length
    for (let guard = 0; ahead < sessionCount && guard < 200; guard += 1) {
      bucket = nextBucket(calendar, spec, bucket)
      buckets.push(bucket)
      ahead = sessionsBetween(calendar, firstFutureDay, bucket.sessions.at(-1)!).length
    }
  } catch (error) {
    if (error instanceof RangeError) return { status: 'unavailable', timeframe, reason: 'calendar_range' }
    throw error
  }

  const bars: DailyProjectedBar[] = []
  let previousAhead = 0
  for (const [index, bucket] of buckets.entries()) {
    const ahead = sessionsBetween(calendar, firstFutureDay, bucket.sessions.at(-1)!).length
    const entered = Math.min(Math.max(E - previousAhead, 0), ahead - previousAhead)
    // Entries inside this bar that sit behind a gap (or after an invalid session).
    let isolated = 0
    for (let k = Math.max(E, previousAhead) + 1; k <= Math.min(ahead, cells.length); k += 1) {
      if (cells[k - 1].status === 'ok') isolated += 1
    }
    const phase: DailyBarPhase = E >= ahead ? 'confirmed' : E > previousAhead ? 'provisional' : 'unentered'
    bars.push({
      k: index + 1,
      key: bucket.key,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      firstSession: bucket.sessions[0],
      lastSession: bucket.sessions.at(-1)!,
      completesForming: formingKey != null && bucket.key === formingKey,
      sessionsAheadEnd: ahead,
      requiredSessions: ahead - previousAhead,
      enteredSessions: entered,
      isolatedSessions: isolated,
      phase,
      close: phase === 'confirmed' ? cells[ahead - 1].close : null,
      provisionalClose: phase === 'provisional' ? cells[E - 1].close : null,
    })
    previousAhead = ahead
  }

  const confirmedCloses = smaLabConfirmedCloses(lab)
  const confirmedFuture = bars.map((bar) => bar.close)
  const provisionalIndex = bars.findIndex((bar) => bar.phase === 'provisional')
  const confirmedBars = bars.filter((bar) => bar.phase === 'confirmed').length
  const sma: Record<number, Array<number | null>> = {}
  const provisionalSma: Record<number, Array<number | null>> = {}
  const periods: DailyPeriodSummary[] = []
  for (const summary of lab.periods) {
    const period = summary.period
    sma[period] = projectSmaPath(confirmedCloses, confirmedFuture, period)
    provisionalSma[period] = bars.map(() => null)
    if (provisionalIndex >= 0) {
      const path = [...confirmedFuture.slice(0, provisionalIndex), bars[provisionalIndex].provisionalClose]
      provisionalSma[period][provisionalIndex] = projectSmaPath(confirmedCloses, path, period).at(-1) ?? null
    }
    const latestConfirmed = confirmedBars > 0 ? sma[period][confirmedBars - 1] : null
    const provisional = provisionalIndex >= 0 ? provisionalSma[period][provisionalIndex] : null
    periods.push({
      period,
      anchor: summary.anchorValue,
      latestConfirmed,
      latestConfirmedPct: pct(latestConfirmed, summary.anchorValue),
      provisional,
      provisionalPct: pct(provisional, summary.anchorValue),
    })
  }

  return {
    status: 'available',
    timeframe,
    lab,
    bars,
    confirmedBars,
    provisionalIndex: provisionalIndex >= 0 ? provisionalIndex : null,
    sma,
    provisionalSma,
    periods,
  }
}

export interface ProjectDailyScenarioInput {
  market: SmaDynamicsMarket
  /** The as-of date and close, shared by every timeframe (they come from the same PIT history). */
  asOf: { date: string; close: number }
  draft: DailyScenarioDraft
  /** Lab result for a timeframe (any horizon); callers may cache it. */
  labFor: (timeframe: SmaLabTimeframeId) => SmaLabResult
  calendar?: SmaLabCalendar
}

/** Projects the one daily scenario onto all 15 timeframes. Pure. */
export function projectDailyScenario(input: ProjectDailyScenarioInput): DailyScenarioProjection | null {
  const calendar = input.calendar ?? smaLabCalendar(input.market)
  let sessions: string[]
  try {
    sessions = dailyFutureSessions(calendar, input.asOf.date, input.draft.sessions)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
  const evaluation = evaluateDailyScenario(input.asOf.close, sessions, input.draft)
  const timeframes = SMA_LAB_TIMEFRAMES.map((item): DailyTimeframeProjection => {
    const lab = input.labFor(item.id)
    if (lab.status !== 'available') return { status: 'unavailable', timeframe: item.id, reason: 'lab_unavailable' }
    return projectOntoTimeframe({ calendar, lab, evaluation, sessionCount: sessions.length })
  })
  return { market: input.market, asOf: input.asOf.date, anchorClose: input.asOf.close, sessions, evaluation, timeframes }
}

// ---------------------------------------------------------------------------
// Daily → selected-timeframe scenario (explicit, deterministic)

/** Shortest text that parses back to exactly `value` (no exponent form, which the input parser rejects). */
export function exactPriceText(value: number): string {
  const text = String(value)
  return /e/i.test(text) ? value.toFixed(12).replace(/\.?0+$/, '') : text
}

export interface DailyAdaptation {
  timeframe: SmaLabTimeframeId
  /** Price-unit draft: confirmed bars carry their exact closes, every other bar is left empty. */
  draft: ScenarioDraft
  horizon: number
  confirmedK: number[]
  provisional: Array<{ k: number; enteredSessions: number; requiredSessions: number }>
  /** Bars (≤ horizon) the daily sessions do not reach, or that nothing contiguous reaches. */
  emptyK: number[]
  /** Every one of the `horizon` bars is confirmed. */
  complete: boolean
}

/**
 * The selected timeframe's scenario draft implied by the daily scenario. Only confirmed bars get a
 * price; provisional and unreached bars stay empty (the scenario editor never fills them), so the
 * result and its completeness are fully determined by the daily entries.
 */
export function adaptDailyScenarioToTimeframe(projection: DailyTimeframeProjection, horizon: number): DailyAdaptation | null {
  if (projection.status !== 'available') return null
  const inputs = Array<string>(horizon).fill('')
  const confirmedK: number[] = []
  const provisional: DailyAdaptation['provisional'] = []
  const emptyK: number[] = []
  for (let k = 1; k <= horizon; k += 1) {
    const bar = projection.bars[k - 1]
    if (bar?.phase === 'confirmed' && bar.close != null) {
      inputs[k - 1] = exactPriceText(bar.close)
      confirmedK.push(k)
    } else {
      if (bar?.phase === 'provisional') provisional.push({ k, enteredSessions: bar.enteredSessions, requiredSessions: bar.requiredSessions })
      emptyK.push(k)
    }
  }
  return {
    timeframe: projection.timeframe,
    draft: { unit: 'price', inputs },
    horizon,
    confirmedK,
    provisional,
    emptyK,
    complete: confirmedK.length === horizon,
  }
}

/** True when the selected-timeframe draft already holds exactly the adapted closes (no more, no less). */
export function adaptationApplied(adaptation: DailyAdaptation, base: ForwardBase, current: ScenarioDraft): boolean {
  for (let k = 1; k <= adaptation.horizon; k += 1) {
    const wanted = scenarioCellClose(base, 'price', adaptation.draft.inputs[k - 1] ?? '')
    const have = scenarioCellClose(base, current.unit, current.inputs[k - 1] ?? '')
    if (wanted.status === 'missing') {
      if (have.status !== 'missing') return false
    } else if (have.status !== 'ok' || wanted.close !== have.close) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Copy (shared by the UI and tests)

export const DAILY_PHASE_LABEL: Record<DailyBarPhase, string> = {
  confirmed: '確定',
  provisional: '暫定',
  unentered: '未入力',
}

export function describeDailyBar(bar: DailyProjectedBar): string {
  if (bar.phase === 'confirmed') return `確定: ${bar.requiredSessions}営業日すべて入力済み`
  if (bar.phase === 'provisional') return `暫定: ${bar.enteredSessions}/${bar.requiredSessions}営業日まで入力。最終営業日まで入力すると確定します`
  return bar.isolatedSessions > 0
    ? `未確定: 途中の営業日が未入力のため、先の入力 ${bar.isolatedSessions}日分は使いません`
    : `未入力: 必要な営業日 ${bar.requiredSessions}日が入力されていません`
}

export function describeDailyAdaptation(adaptation: DailyAdaptation, barNoun: string): string {
  const list = (ks: number[]) => ks.slice(0, 6).map((k) => `T+${k}`).join(', ') + (ks.length > 6 ? ' ほか' : '')
  const parts = [`日次シナリオから導出: 確定した${barNoun} ${adaptation.confirmedK.length}/${adaptation.horizon}本${adaptation.confirmedK.length > 0 ? ` (${list(adaptation.confirmedK)})` : ''}`]
  if (adaptation.provisional.length > 0) {
    parts.push(`暫定の足 ${list(adaptation.provisional.map((item) => item.k))} は営業日が揃うまで空欄 (補完しません)`)
  }
  const unreached = adaptation.emptyK.filter((k) => !adaptation.provisional.some((item) => item.k === k))
  if (unreached.length > 0) parts.push(`日次の入力が届かない足 ${list(unreached)} は空欄`)
  if (adaptation.complete) parts.push('すべて確定済みなので完全なシナリオです')
  return parts.join(' ・ ')
}
