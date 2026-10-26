// Direction-neutral wording and timing labels for the inverse solver (Phase 2.2).
// Presentation only: every number comes from the unchanged Phase 2 solver contract
// (strict inequalities, tick/bounds, relative requirements). Nothing here decides
// feasibility, and no sentence claims more than the goal actually enforces.
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import type { SmaLabFutureBar, SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import {
  analyzeSolverGoal,
  DIRECTION_LABEL,
  describeSolverIssue,
  type AnchorDirection,
  type BarRequirement,
  type SolverGoalKind,
  type Comparator,
  type ForwardBase,
  type PriceConstraints,
  type SmaDirection,
  type SolverAnalysis,
  goalBars,
  goalTarget,
  type GoalCheck,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import { smaLabTimeframe, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

export type NumberFormat = (value: number | null | undefined) => string
export type PriceUnit = '円' | 'ドル'

export const SMA_DIRECTIONS: readonly SmaDirection[] = ['up', 'flat', 'down']
export const DIRECTION_ARROW: Record<SmaDirection, string> = { up: '↑', flat: '→', down: '↓' }

export function priceUnit(market: SmaDynamicsMarket): PriceUnit {
  return market === 'US' ? 'ドル' : '円'
}

// ---------------------------------------------------------------------------
// Timing: "which bar" in the words of the selected timeframe

const SUFFIX: Record<SmaLabTimeframeId, string> = {
  '1D': '営業日', '2D': '本', '3D': '本', '5D': '本', '1W': '週', '2W': '本', '3W': '本',
  '1M': 'か月', '2M': '本', '3M': '本', '6M': '本', '1Y': '年', '2Y': '本', '3Y': '本', '5Y': '本',
}

/** "次の営業日" / "3営業日後" / "次の週足" / "3週後" / "5本後". Always derived from k and the timeframe. */
export function timingLabel(timeframe: SmaLabTimeframeId, k: number): string {
  const tf = smaLabTimeframe(timeframe)
  if (k === 1) return timeframe === '1D' ? '次の営業日' : `次の${tf.barNoun}`
  return `${k}${SUFFIX[timeframe]}後`
}

/** "3営業日以内" / "5本以内". */
export function withinLabel(timeframe: SmaLabTimeframeId, k: number): string {
  return `${k}${SUFFIX[timeframe]}以内`
}

/** "今後5営業日" / "今後3本". */
export function spanLabel(timeframe: SmaLabTimeframeId, k: number): string {
  return `今後${k}${SUFFIX[timeframe]}`
}

/** Same direction condition with N = 1: exact T+1, within T+1 and maintain T+1 are the same single-bar question. */
export function isSingleBarSameDirection(goal: SolverGoal): boolean {
  return (goal.kind === 'within' && goal.within === 1) || (goal.kind === 'maintain' && goal.through === 1)
}

/** 1D: "対象は次の1営業日だけです。この日に条件を満たせば成立します。" Other timeframes: "次の1週だけです。この足で…" (unit and bar noun follow the timeframe). */
export function singleBarScopeNote(timeframe: SmaLabTimeframeId): string {
  return `対象は次の${unitLabel(timeframe, 1)}だけです。${timeframe === '1D' ? 'この日に' : 'この足で'}条件を満たせば成立します。`
}

function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
}

/** Confirmation date of the k-th future bar (its last market session), straight from the calendar-aware projection. */
export function timingDate(futureBars: ReadonlyArray<SmaLabFutureBar> | undefined, k: number): { iso: string; short: string; multiSession: boolean; completesForming: boolean } | null {
  const bar = futureBars?.[k - 1]
  if (!bar) return null
  return { iso: bar.lastSession, short: monthDay(bar.lastSession), multiSession: bar.firstSession !== bar.lastSession, completesForming: bar.completesForming }
}

/** Full sentence for the selected timing: label, T+k, confirmation date. Never a fixed T+3 explanation. */
export function describeTiming(timeframe: SmaLabTimeframeId, k: number, futureBars?: ReadonlyArray<SmaLabFutureBar>): string {
  const bar = futureBars?.[k - 1]
  const head = `${timingLabel(timeframe, k)} (T+${k})`
  if (!bar) return head
  const range = bar.firstSession === bar.lastSession ? bar.lastSession : `${bar.firstSession}〜${bar.lastSession}`
  return `${head} = ${range} の${smaLabTimeframe(timeframe).barNoun}が確定する日の終値${bar.completesForming ? ' (現在の未確定足を完成させる足)' : ''}`
}

/** Basic N choices; any other N in 1..20 is reachable from "ほかの本数". */
export const SOLVER_QUICK_TIMINGS: readonly number[] = [1, 3, 5, 10, 20]

// ---------------------------------------------------------------------------
// Names

/** "5日線" on the daily chart; "週足SMA5" elsewhere (the window is always N bars of the selected timeframe). */
export function smaLineName(period: SmaLabPeriod | number, timeframe: SmaLabTimeframeId): string {
  return timeframe === '1D' ? `${period}日線` : `${smaLabTimeframe(timeframe).name}SMA${period}`
}

export function directionWord(direction: SmaDirection): string {
  return DIRECTION_LABEL[direction]
}

// ---------------------------------------------------------------------------
// Current direction (unrounded confirmed SMAs; the solver already derives it)

export interface CurrentDirectionState {
  state: SmaDirection | 'unavailable'
  headline: string
  detail: string
  /** Non-zero change inside the display tolerance: exact direction is kept, but flagged. */
  nearFlat: boolean
}

export function describeCurrentDirection(args: {
  period: SmaLabPeriod
  timeframe: SmaLabTimeframeId
  anchorSma: number | null
  anchor: AnchorDirection | null
  exact: NumberFormat
}): CurrentDirectionState {
  const name = smaLineName(args.period, args.timeframe)
  const noun = smaLabTimeframe(args.timeframe).barNoun
  if (args.anchorSma == null) {
    return { state: 'unavailable', nearFlat: false, headline: `現在の${name}：計算できません`, detail: `この時間軸では${noun}の確定終値が足りないか、窓内に使用できない終値があります。` }
  }
  if (!args.anchor) {
    return { state: 'unavailable', nearFlat: false, headline: `現在の${name}：現在の向きは判定できません`, detail: `向きの判定には ${noun}が SMA期間 + 1本 (${args.period + 1}本) 必要です。推測で補完していません。` }
  }
  const { direction, delta, displayFlat } = args.anchor
  const signed = `${delta > 0 ? '+' : ''}${args.exact(delta)}`
  return {
    state: direction,
    nearFlat: displayFlat && direction !== 'flat',
    headline: `現在の${name}：${DIRECTION_LABEL[direction]}`,
    detail: `最後の確定足 ${args.exact(args.anchor.current)} ・ 直前の確定足 ${args.exact(args.anchor.previous)} (差 ${signed})${displayFlat && direction !== 'flat' ? '。変化はごくわずかですが、厳密な値で判定しています。' : ''}`,
  }
}

// ---------------------------------------------------------------------------
// Goal wording

export interface WordingContext {
  timeframe: SmaLabTimeframeId
  /** Exact current direction; null when it cannot be determined. */
  current: SmaDirection | null
  unit: PriceUnit
  exact: NumberFormat
}

const LEVEL_PHRASE: Record<SmaDirection, string> = { up: '高く', flat: '同じに', down: '低く' }

/** Title of the goal (heading of the result). Neutral about direction; the scope is always spelled out. */
export function goalTitle(goal: SolverGoal, ctx: WordingContext): string {
  const name = smaLineName(goal.period, ctx.timeframe)
  switch (goal.kind) {
    case 'direction': return `${name}を${timingLabel(ctx.timeframe, goal.bar)}の時点で${DIRECTION_LABEL[goal.direction]}にする`
    case 'within':
      if (goal.within === 1) return `${name}を${timingLabel(ctx.timeframe, 1)}に${DIRECTION_LABEL[goal.direction]}にする`
      return `${name}を${withinLabel(ctx.timeframe, goal.within)}に一度でも${DIRECTION_LABEL[goal.direction]}にする`
    case 'maintain':
      if (goal.through === 1) return `${name}を${timingLabel(ctx.timeframe, 1)}に${DIRECTION_LABEL[goal.direction]}にする`
      return `${name}を${spanLabel(ctx.timeframe, goal.through)}、すべての足で${DIRECTION_LABEL[goal.direction]}にする`
    case 'reversal': return `${name}を${withinLabel(ctx.timeframe, goal.within)}に${DIRECTION_LABEL[goal.to]}へ転換 (符号反転) させる`
    case 'level': return `${timingLabel(ctx.timeframe, goal.bar)}の${name}を基準日の${name}より${LEVEL_PHRASE[goal.relation]}する`
  }
}

/**
 * "条件" form of the goal. 「続ける」 appears only for a throughout goal whose direction already
 * is the current one (every bar is enforced); a single-bar goal never implies the path before it.
 */
export function goalCondition(goal: SolverGoal, ctx: WordingContext): string {
  const name = smaLineName(goal.period, ctx.timeframe)
  switch (goal.kind) {
    case 'direction': return `${timingLabel(ctx.timeframe, goal.bar)}の時点で${name}が${DIRECTION_LABEL[goal.direction]}になっている条件`
    case 'within':
      if (goal.within === 1) return `${timingLabel(ctx.timeframe, 1)}に${name}が${DIRECTION_LABEL[goal.direction]}になる条件`
      return `${withinLabel(ctx.timeframe, goal.within)}に${name}が一度でも${DIRECTION_LABEL[goal.direction]}になる条件`
    case 'maintain':
      if (goal.through === 1) return `${timingLabel(ctx.timeframe, 1)}に${name}が${DIRECTION_LABEL[goal.direction]}になる条件`
      return ctx.current === goal.direction
        ? `${name}が${spanLabel(ctx.timeframe, goal.through)}、${DIRECTION_LABEL[goal.direction]}を続ける条件`
        : `${spanLabel(ctx.timeframe, goal.through)}のすべての足で${name}が${DIRECTION_LABEL[goal.direction]}になる条件`
    case 'reversal': return `${withinLabel(ctx.timeframe, goal.within)}に${name}が${DIRECTION_LABEL[goal.to]}へ転換 (符号反転) する条件`
    case 'level': return `${timingLabel(ctx.timeframe, goal.bar)}の${name}が基準日の${name}より${LEVEL_PHRASE[goal.relation]}なる条件`
  }
}

/** Step 3 hint: reversal offers two choices, every other kind three. */
export function solverDirectionHint(kind: SolverGoalKind): string {
  return kind === 'reversal' ? '転換先の向きを選びます (2択)' : '3つは対等です'
}

/** Tag naming which of the distinct analyses is running. */
export const GOAL_KIND_TAG: Record<SolverGoal['kind'], string> = {
  direction: 'N本後の時点だけ',
  within: 'N本以内に一度でも',
  maintain: 'N本ずっと',
  reversal: '向きの転換 (符号反転)',
  level: '基準日との水準比較',
}

/** Goal-aware tag: within / maintain at N = 1 are the single-bar question, so the "N本…" scope wording is dropped. */
export function goalKindTag(goal: SolverGoal): string {
  return isSingleBarSameDirection(goal) ? '次の1本だけ' : GOAL_KIND_TAG[goal.kind]
}

/** The three scopes of the main flow. Same N, same direction choices; only the question differs. */
export type SolverScope = Extract<SolverGoalKind, 'direction' | 'within' | 'maintain'>
export const SOLVER_SCOPES: readonly SolverScope[] = ['direction', 'within', 'maintain']

/** "3営業日" / "1週" / "5本": the bare count in the timeframe's unit (button face for the N choices). */
export function unitLabel(timeframe: SmaLabTimeframeId, k: number): string {
  return `${k}${SUFFIX[timeframe]}`
}

/** Main label of a scope button with the real N in the selected timeframe's words. */
export function scopeLabel(scope: SolverScope, timeframe: SmaLabTimeframeId, n: number): string {
  return scope === 'direction' ? `${unitLabel(timeframe, n)}後` : scope === 'within' ? withinLabel(timeframe, n) : `${unitLabel(timeframe, n)}ずっと`
}

export function isSolverScope(kind: SolverGoalKind): kind is SolverScope {
  return kind === 'direction' || kind === 'within' || kind === 'maintain'
}

export const SOLVER_SCOPE_CHOICES: ReadonlyArray<{ id: SolverScope; sub: string; help: string }> = [
  { id: 'direction', sub: 'その時点だけ', help: 'T+N の1本だけを見ます。途中 (T+1〜T+N−1) の向きは問いません。' },
  { id: 'within', sub: '一度でも', help: 'T+1〜T+N のうち、どこか1本でも目標の向きになれば成立です。今の状態 (T+0) は数えず、あとで向きが崩れても一度到達していれば成立です。' },
  { id: 'maintain', sub: 'すべての足で', help: 'T+1〜T+N のすべての足で目標の向きになる条件です。1本でも外れれば成立しません。' },
]

/** Help under the scope buttons; within / maintain collapse to the single-bar sentence when N = 1. */
export function scopeHelp(scope: SolverScope, timeframe: SmaLabTimeframeId, n: number): string {
  if (n === 1 && scope !== 'direction') return singleBarScopeNote(timeframe)
  return SOLVER_SCOPE_CHOICES.find((choice) => choice.id === scope)!.help
}

/** Advanced research goals, kept apart from the three scopes. */
export const GOAL_KIND_CHOICES: ReadonlyArray<{ id: 'reversal' | 'level'; label: string; help: string }> = [
  { id: 'reversal', label: '向きの転換 (符号反転)', help: '目標の向きへ実際に切り替わる出来事を調べます。「N本以内に一度でも」とは別の条件です。定義は下の説明を参照してください。' },
  { id: 'level', label: '基準日との水準比較', help: '直前の足との傾きではなく、基準日 (最後の確定足) のSMAの値より高い・同じ・低いかを比べます。' },
]

/** One-line definition of a reversal shown wherever the advanced goal is offered. */
export const REVERSAL_DEFINITION =
  '転換 = 横ばいを中立の橋として読み飛ばし、直近に決まっていた上向き/下向きから、目標の反対向きへ実際に切り替わること。上向きのままは「上向きへの転換」ではありません。上向き→横ばい→下向きは下向きへの転換、上向き→下向き→上向きの最後の上向きも転換になり得ます。'

/** N >= 2 keeps the "one hit is enough even if it later leaves the direction" wording; N = 1 has no later bar. */
export function withinExplanation(timeframe: SmaLabTimeframeId, n: number): string {
  return n === 1 ? `${singleBarScopeNote(timeframe)}今 (T+0) の向きは数えません。` : WITHIN_EXPLANATION
}

export const WITHIN_EXPLANATION = 'T+1〜T+N のどこか1本でも目標の向きになれば成立です。今 (T+0) の向きは数えず、あとで向きが崩れても、一度到達していれば成立です。'

/** Always shown next to a representative hit so it is never read as the earliest or only possibility. */
export const REPRESENTATIVE_HIT_NOTE = '最初の到達足は、この例の経路での結果です。条件を満たす経路は他にもあり、すべての経路で最短という意味ではありません。'

// ---------------------------------------------------------------------------
// Required price condition

const OP_VERB: Record<Comparator, string> = { '>': 'を上回れば', '=': 'になれば', '<': 'を下回れば' }

/** Tick/bound qualifier for a threshold; null when the plain threshold already says everything. */
export function boundQualifier(op: Comparator, req: { value: number; bound: { value: number; attained: boolean } | null }, tick: boolean, ctx: Pick<WordingContext, 'exact' | 'unit'>): string | null {
  const bound = req.bound
  if (!bound) return '制約の範囲内に該当する価格はありません'
  const v = `${ctx.exact(bound.value)}${ctx.unit}`
  if (op === '=') return `ちょうど${v}`
  if (!bound.attained) return null
  if (tick) return `刻みを考慮すると${op === '>' ? '最小' : '最大'}${v}`
  return bound.value !== req.value ? `制約の端の${v}まで` : null
}

function thresholdSentence(req: Extract<BarRequirement, { kind: 'threshold' }>, goalDirection: SmaDirection, ctx: WordingContext, name: string): string {
  const when = timingLabel(ctx.timeframe, req.k)
  const v = `${ctx.exact(req.value)}${ctx.unit}`
  const head = req.op === '='
    ? `${when}なら、終値がちょうど${v}で`
    : `${when}なら、終値が${v}${OP_VERB[req.op]}`
  const tail = `${name}は${DIRECTION_LABEL[goalDirection]}になります`
  const strict = req.op === '=' ? '' : `。ちょうど${v}なら${DIRECTION_LABEL.flat}です。`
  return `${head}、${tail}${strict || '。'}`
}

export interface PriceConditionView {
  /** one: a single price condition. several: every/any listed bar. dependent: relative to another assumed close. none: nothing to state. */
  kind: 'one' | 'several' | 'dependent' | 'none'
  /** Lead sentence. */
  headline: string
  /** Remaining sentences (per-bar conditions, caveats). */
  lines: string[]
  /** The condition rests on assumed future closes, so no single unconditional price level exists. */
  pathDependent: boolean
}

export function priceCondition(analysis: SolverAnalysis, ctx: WordingContext): PriceConditionView {
  const goal = analysis.goal
  const name = smaLineName(goal.period, ctx.timeframe)
  const target: SmaDirection = goalTarget(goal)
  const none: PriceConditionView = { kind: 'none', headline: '', lines: [], pathDependent: false }

  if (analysis.status === 'unavailable') return { ...none, headline: analysis.issue ? describeSolverIssue(analysis.issue, smaLabTimeframe(ctx.timeframe).barNoun) : '計算できません' }
  if (analysis.status === 'precondition_failed') return { ...none, headline: analysis.issue ? describeSolverIssue(analysis.issue, smaLabTimeframe(ctx.timeframe).barNoun) : '前提が成立していません' }
  if (analysis.status === 'infeasible') {
    return { ...none, headline: `指定した価格の制約の下では、この目標を満たす終値はありません。${analysis.issue ? describeSolverIssue(analysis.issue, smaLabTimeframe(ctx.timeframe).barNoun) : ''}` }
  }

  if (analysis.sum) {
    const sum = analysis.sum
    const when = sum.count > 1 ? `${timingLabel(ctx.timeframe, sum.fromK)}〜${timingLabel(ctx.timeframe, sum.toK)}の終値の平均` : `${timingLabel(ctx.timeframe, sum.fromK)}の終値`
    const v = `${ctx.exact(sum.mean)}${ctx.unit}`
    const tail = `${timingLabel(ctx.timeframe, goal.kind === 'level' ? goal.bar : sum.toK)}の${name}は基準日の${name}より${LEVEL_PHRASE[target]}なります`
    const headline = sum.op === '=' ? `${when}がちょうど${v}なら、${tail}` : `${when}が${v}${OP_VERB[sum.op]}、${tail}`
    const lines: string[] = []
    if (sum.count > 1) lines.push('各足の配分は自由で、平均だけが条件です。')
    return { kind: 'one', headline, lines, pathDependent: false }
  }

  const listed = analysis.requirements.filter((item): item is Extract<BarRequirement, { kind: 'threshold' | 'relative' }> => item.kind === 'threshold' || item.kind === 'relative')
  if (listed.length === 0) return none

  const per = (req: (typeof listed)[number]): string => {
    if (req.kind === 'threshold') return thresholdSentence(req, target, ctx, name)
    const when = timingLabel(ctx.timeframe, req.k)
    const other = timingLabel(ctx.timeframe, req.otherK)
    const rel = req.op === '>' ? 'より高ければ' : req.op === '<' ? 'より低ければ' : 'と同じなら'
    return `${when}なら、終値が仮定した${other}の終値${rel}、${name}は${DIRECTION_LABEL[target]}になります`
  }
  const dependent = listed.some((item) => item.kind === 'relative')
  const firstRel = listed.find((item): item is Extract<BarRequirement, { kind: 'relative' }> => item.kind === 'relative')
  const caveat = firstRel
    ? `${timingLabel(ctx.timeframe, firstRel.k)}以降は窓から抜けるのが仮定した終値 (例: ${timingLabel(ctx.timeframe, firstRel.k)}なら${timingLabel(ctx.timeframe, firstRel.otherK)}の終値) なので、単独の価格境界では示せません。`
    : ''

  if (goal.kind === 'direction' || (isSingleBarSameDirection(goal) && listed.length === 1)) {
    const req = listed[0]
    return {
      kind: req.kind === 'relative' ? 'dependent' : 'one',
      headline: per(req),
      lines: [
        ...(req.kind === 'threshold' ? [boundQualifier(req.op, req, analysis.domain.grid != null, ctx)].filter((x): x is string => x != null) : []),
        ...(req.kind === 'relative' ? [`${timingLabel(ctx.timeframe, req.k)}の計算窓から抜けるのは、将来の${timingLabel(ctx.timeframe, req.otherK)}の仮定終値です。どの価格を仮定したかで条件が変わるため、単独の価格水準では示せません。`] : []),
      ],
      pathDependent: req.kind === 'relative',
    }
  }

  const shown = listed.slice(0, 4).map(per)
  if (listed.length > 4) shown.push(`ほか${listed.length - 4}本の足にも同様の条件があります (詳しい計算を参照)`)
  if (goal.kind === 'within') {
    return {
      kind: 'several',
      headline: '次のどれか1本でも満たせば到達します (T+0 は数えません)。足ごとに条件の前提が違うため、価格の高低で起こりやすさは比べられません',
      lines: [...shown, ...(caveat ? [caveat] : [])],
      pathDependent: dependent,
    }
  }
  if (goal.kind === 'reversal') {
    const opposite = DIRECTION_LABEL[goal.to === 'up' ? 'down' : 'up']
    if (analysis.combinator === 'sequence') {
      const plan = analysis.sequencePlan
      const first = plan ? analysis.oppositeRequirements[plan.firstK - 1] : null
      const firstText = first && first.kind === 'threshold'
        ? `${timingLabel(ctx.timeframe, first.k)}の終値が${ctx.exact(first.value)}${ctx.unit}${OP_VERB[first.op]}、${name}が${opposite}になる`
        : first && first.kind === 'relative' ? `${timingLabel(ctx.timeframe, first.k)}の終値が仮定した${timingLabel(ctx.timeframe, first.otherK)}の終値${first.op === '>' ? 'より高ければ' : 'より低ければ'}、${name}が${opposite}になる` : null
      return {
        kind: 'several',
        headline: `今の向きの延長は転換ではありません。先に${opposite}の足が出て、その後に${DIRECTION_LABEL[goal.to]}へ切り替わる2段階が必要です (間の横ばいは数えません)`,
        lines: [
          ...(plan && firstText ? [`例: ${firstText}。そのあと、${per(analysis.requirements[plan.secondK - 1] as (typeof listed)[number])}`] : []),
          ...(caveat ? [caveat] : []),
        ],
        pathDependent: dependent,
      }
    }
    return {
      kind: 'several',
      headline: `次のどれか1本でも満たせば転換します (直近の向きは${opposite})。足ごとに条件の前提が違うため、価格の高低で起こりやすさは比べられません`,
      lines: [...shown, ...(caveat ? [caveat] : [])],
      pathDependent: dependent,
    }
  }
  return {
    kind: 'several',
    headline: `すべての足で次の条件が必要です (1本でも外れると成立しません)`,
    lines: [...shown, ...(caveat ? [caveat] : [])],
    pathDependent: dependent,
  }
}

// ---------------------------------------------------------------------------
// Three directions side by side (single-bar direction goal only)

export interface DirectionComparisonRow {
  direction: SmaDirection
  status: SolverAnalysis['status']
  /** Compact condition. */
  text: string
  /** The condition depends on another assumed close: no fixed number is given. */
  dependent: boolean
}

export function compareDirections(args: {
  base: ForwardBase
  period: SmaLabPeriod
  bar: number
  constraints: PriceConstraints
  ctx: WordingContext
}): DirectionComparisonRow[] {
  const { ctx } = args
  return SMA_DIRECTIONS.map((direction) => {
    const analysis = analyzeSolverGoal(args.base, { kind: 'direction', period: args.period, bar: args.bar, direction }, args.constraints)
    const req = analysis.requirements[args.bar - 1]
    if (analysis.status !== 'feasible') {
      return { direction, status: analysis.status, dependent: false, text: analysis.status === 'infeasible' ? '制約の下では達成できません' : '計算できません' }
    }
    if (req?.kind === 'threshold') {
      const v = `${ctx.exact(req.value)}${ctx.unit}`
      const qual = boundQualifier(req.op, req, analysis.domain.grid != null, ctx)
      const main = req.op === '>' ? `終値が${v}を上回る` : req.op === '<' ? `終値が${v}を下回る` : `終値がちょうど${v}`
      return { direction, status: analysis.status, dependent: false, text: qual && req.op !== '=' ? `${main} (${qual})` : main }
    }
    if (req?.kind === 'relative') {
      const other = timingLabel(ctx.timeframe, req.otherK)
      return { direction, status: analysis.status, dependent: true, text: `${other}の仮定終値との比較で決まります (固定の価格はありません)` }
    }
    return { direction, status: analysis.status, dependent: false, text: '—' }
  })
}

// ---------------------------------------------------------------------------
// Chart boundaries: only where a price level really exists

export interface SolverBoundarySpec {
  price: number
  label: string
  /** Bar the level applies to; omitted for a level that applies to the whole projection. */
  k?: number
  /** Which direction each side of the level gives (relative to the previous SMA). */
  above: SmaDirection | null
  below: SmaDirection | null
}

/**
 * Horizontal levels the chart may draw. A direction goal on a bar whose outgoing close is a
 * confirmed price has one level, valid for that bar only. Maintain/reversal get one short
 * marker per bar. Conditions that depend on assumed closes (relative) get no line at all.
 */
/** More per-bar markers than this would bury the candles; the caption says when some are not drawn. */
export const MAX_BOUNDARY_MARKERS = 10

export function solverBoundaries(analysis: SolverAnalysis, ctx: Pick<WordingContext, 'timeframe' | 'exact' | 'unit'>): SolverBoundarySpec[] {
  if (analysis.status !== 'feasible') return []
  const goal = analysis.goal
  if (goal.kind === 'level') {
    const sum = analysis.sum
    if (!sum || sum.count !== 1) return []
    return [{ price: sum.mean, k: goal.bar, label: `${timingLabel(ctx.timeframe, goal.bar)}の境界 ${ctx.exact(sum.mean)}`, above: null, below: null }]
  }
  const bars = analysis.requirements.filter((item): item is Extract<BarRequirement, { kind: 'threshold' }> => item.kind === 'threshold').slice(0, MAX_BOUNDARY_MARKERS)
  return bars.map((req) => ({
    price: req.value,
    k: req.k,
    label: `${timingLabel(ctx.timeframe, req.k)}の境界 ${ctx.exact(req.value)} (上${DIRECTION_ARROW.up} 同値${DIRECTION_ARROW.flat} 下${DIRECTION_ARROW.down})`,
    above: 'up' as const,
    below: 'down' as const,
  }))
}

// ---------------------------------------------------------------------------
// Representative hit (one example path; never "the" first possible hit)

export interface HitSummary {
  /** First matching bar on this example path (within) or its sign change (reversal); null when there is none. */
  hitK: number | null
  headline: string
  lines: string[]
}

function periodText(futureBars: ReadonlyArray<SmaLabFutureBar> | undefined, k: number): string {
  const bar = futureBars?.[k - 1]
  if (!bar) return ''
  return bar.firstSession === bar.lastSession ? bar.lastSession : `${bar.firstSession}〜${bar.lastSession}`
}

/**
 * Wording for the first hit on the representative path of a within / reversal goal. The three claims stay
 * separate: "hit within N" (this bar), "still true at N" (T+N) and "true throughout" (every bar from T+1).
 */
export function describeRepresentativeHit(args: {
  goal: SolverGoal
  check: GoalCheck
  ctx: WordingContext
  futureBars: ReadonlyArray<SmaLabFutureBar> | undefined
  /** SMA value and assumed close on the hit bar of this path. */
  smaAtHit: number | null
  closeAtHit: number | null
  fmt: NumberFormat
  retained: SolverAnalysis['retained']
}): HitSummary | null {
  const { goal, check, ctx } = args
  if (goal.kind !== 'within' && goal.kind !== 'reversal') return null
  const name = smaLineName(goal.period, ctx.timeframe)
  const target = goalTarget(goal)
  const word = DIRECTION_LABEL[target]
  const n = goalBars(goal)
  const hitK = check.hitK
  if (hitK == null) {
    return { hitK: null, headline: `この例の経路では、${withinLabel(ctx.timeframe, n)}に${goal.kind === 'within' ? `一度も${word}になりません` : `${word}への転換は起きません`}。`, lines: [] }
  }
  const when = `${timingLabel(ctx.timeframe, hitK)} (T+${hitK}${periodText(args.futureBars, hitK) ? ` ・ ${periodText(args.futureBars, hitK)}` : ''})`
  let headline: string
  if (goal.kind === 'within') {
    headline = `この例の経路では、${when}に初めて${name}が${word}になります。`
  } else {
    let prior: SmaDirection | null = args.retained?.state === 'known' ? args.retained.direction : null
    for (let i = 0; i < hitK - 1; i += 1) {
      const direction = check.directions[i]
      if (direction && direction !== 'flat') prior = direction
    }
    headline = `この例の経路では、${when}に${prior ? `${DIRECTION_LABEL[prior]}から` : ''}${word}へ転換します。`
  }
  const lines: string[] = []
  const sma = args.smaAtHit != null ? `${name} ${args.fmt(args.smaAtHit)}` : null
  const close = args.closeAtHit != null ? `仮定した終値 ${ctx.exact(args.closeAtHit)}${ctx.unit}` : null
  if (sma || close) lines.push(`その足の値: ${[sma, close].filter(Boolean).join(' ・ ')}`)
  const after = check.aftermath
  if (isSingleBarSameDirection(goal)) return { hitK, headline, lines: [...lines, singleBarScopeNote(ctx.timeframe)] }
  if (after) {
    if (hitK === n) lines.push(`最後の足 (T+${n}) で初めて到達するため、その後の足はありません。`)
    else if (after.heldThrough) lines.push(`到達後は T+${n} までずっと${word}のままです。`)
    else if (after.lostK != null) {
      const lost = after.lostTo ? DIRECTION_LABEL[after.lostTo] : ''
      lines.push(`到達後、${timingLabel(ctx.timeframe, after.lostK)} (T+${after.lostK}) で${word}ではなくなり${lost ? `${lost}になります` : ''}。${goal.kind === 'within' ? `${withinLabel(ctx.timeframe, n)}の到達は成立のままです。` : ''}`)
      if (after.oppositeK != null && after.oppositeK !== after.lostK) lines.push(`反対向きになるのは T+${after.oppositeK} です。`)
    }
    lines.push(`T+${n} の時点では${word}${after.holdsAtEnd ? 'です' : 'ではありません'}${goal.kind === 'within' ? ` (「${timingLabel(ctx.timeframe, n)}の時点」は別の条件です)` : ''}。`)
  }
  lines.push(REPRESENTATIVE_HIT_NOTE)
  return { hitK, headline, lines }
}
