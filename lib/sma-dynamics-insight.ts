// SMA Dynamics Lab Phase 2.3: insight-first copy for the inverse solver.
// Pure presentation helpers. Every number comes from the unchanged solver contract
// (BarRequirement / GoalCheck / SmaStep); nothing here decides feasibility, compares
// price boundaries of different bars, or implies probability.
import type { SmaLabFutureBar } from '@/lib/sma-dynamics-lab'
import {
  DIRECTION_LABEL,
  goalBars,
  goalTarget,
  type BarRequirement,
  type GoalCheck,
  type SmaDirection,
  type SmaStep,
  type SolverAnalysis,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import {
  boundQualifier,
  isSingleBarSameDirection,
  priceCondition,
  singleBarScopeNote,
  smaLineName,
  spanLabel,
  timingLabel,
  withinLabel,
  type NumberFormat,
  type WordingContext,
} from '@/lib/sma-dynamics-solver-copy'
import type { SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

type Listed = Extract<BarRequirement, { kind: 'threshold' | 'relative' }>

export function listedRequirements(analysis: SolverAnalysis): Listed[] {
  return analysis.requirements.filter((item): item is Listed => item.kind === 'threshold' || item.kind === 'relative')
}

/** Relative requirements exist exactly when the horizon passes the SMA period (outgoing close is an assumed future close). */
export function hasRelativeRequirements(analysis: SolverAnalysis): boolean {
  return listedRequirements(analysis).some((item) => item.kind === 'relative') || analysis.oppositeRequirements.some((item) => item.kind === 'relative')
}

function periodText(futureBars: ReadonlyArray<SmaLabFutureBar> | undefined, k: number): string {
  const bar = futureBars?.[k - 1]
  if (!bar) return ''
  return bar.firstSession === bar.lastSession ? bar.lastSession : `${bar.firstSession}〜${bar.lastSession}`
}

// ---------------------------------------------------------------------------
// Path dependency (delta at T+k = [P(T+k) − P(T+k−N)] / N)

export const SMA_DELTA_FORMULA = 'SMA_N(T+k) − SMA_N(T+k−1) = [P(T+k) − P(T+k−N)] / N'
export const SMA_DELTA_TERMS = 'N はSMAの窓の本数、P は選んだ時間軸の確定終値、k は基準足(T)から数えた足の本数です。'
export const SMA_DELTA_BEGINNER = '移動平均線は、新しく加わる株価と、計算から外れる古い株価の差によって動きます。'

/** Why a fixed boundary exists only while the outgoing close is confirmed history. */
export function pathDependencyRule(period: number, timeframe: SmaLabTimeframeId): string {
  return `${SMA_DELTA_FORMULA} (${SMA_DELTA_TERMS}) k ≤ ${period} の間、窓から抜ける P(T+k−${period}) は確定済みの過去終値なので、その足だけの価格の境界が決まります。k > ${period} (${timingLabel(timeframe, period + 1)}以降) では、抜けるのが仮定した将来終値 P(T+k−${period}) になるため、固定の境界価格は存在せず、どの価格を仮定したかで条件が変わります。`
}

export interface RelativeInstance {
  k: number
  otherK: number
  op: '>' | '=' | '<'
  /** Assumed closes on the representative path (null without a path). */
  close: number | null
  otherClose: number | null
  text: string
}

const REL_WORD = { '>': 'より高い', '<': 'より低い', '=': 'と同じ' } as const

/** The earlier assumed close each relative condition is measured against, with the example path's numbers when known. */
export function relativeInstances(analysis: SolverAnalysis, ctx: Pick<WordingContext, 'timeframe' | 'exact' | 'unit'>, closes: ReadonlyArray<number | null> | null): RelativeInstance[] {
  const lists = [...analysis.oppositeRequirements, ...analysis.requirements]
  const seen = new Set<string>()
  const out: RelativeInstance[] = []
  for (const item of lists) {
    if (item.kind !== 'relative') continue
    const key = `${item.k}:${item.op}:${item.otherK}`
    if (seen.has(key)) continue
    seen.add(key)
    const close = closes?.[item.k - 1] ?? null
    const otherClose = closes?.[item.otherK - 1] ?? null
    const base = `${timingLabel(ctx.timeframe, item.k)} (T+${item.k}) の終値が、仮定した${timingLabel(ctx.timeframe, item.otherK)} (T+${item.otherK}) の終値${REL_WORD[item.op]}こと`
    const eg = close != null && otherClose != null ? `。この例の経路では T+${item.k} = ${ctx.exact(close)}${ctx.unit}、T+${item.otherK} = ${ctx.exact(otherClose)}${ctx.unit}` : ''
    out.push({ k: item.k, otherK: item.otherK, op: item.op, close, otherClose, text: `${base}${eg}` })
  }
  return out
}

// ---------------------------------------------------------------------------
// How the per-bar conditions combine (replaces the fixed "each bar is independent" claim)

/**
 * Condition structure sentence, derived from the actual requirement types.
 * "独立" is stated only when every listed requirement is a confirmed-price threshold.
 */
export function conditionStructureText(analysis: SolverAnalysis, timeframe: SmaLabTimeframeId): string {
  const goal = analysis.goal
  const tp = (k: number) => timingLabel(timeframe, k)
  const listed = listedRequirements(analysis)
  const dependent = hasRelativeRequirements(analysis)
  const firstRelative = [...analysis.oppositeRequirements, ...analysis.requirements].find((item) => item.kind === 'relative')
  const relativeNote = firstRelative && firstRelative.kind === 'relative'
    ? `${tp(firstRelative.k)}以降の条件は、窓から抜ける仮定した終値 (例: ${tp(firstRelative.k)}なら${tp(firstRelative.otherK)}の終値) との関係で決まるため、固定の境界価格はなく、足どうしを独立に扱えません。`
    : ''
  if (goal.kind === 'level') {
    const sum = analysis.sum!
    if (sum.count === 1) return `${tp(sum.fromK)}の終値だけが条件です${sum.fromK > 1 ? `。${tp(1)}〜${tp(sum.fromK - 1)}は窓に入って抜けるため影響しません` : ''}。`
    return `${tp(sum.fromK)}〜${tp(sum.toK)}の終値の平均だけが条件で、各足への配分は自由です${sum.fromK > 1 ? `。${tp(1)}〜${tp(sum.fromK - 1)}は窓に入って抜けるため影響しません` : ''}。`
  }
  if (isSingleBarSameDirection(goal) && !dependent) return `${singleBarScopeNote(timeframe)}${tp(1)}の向きは${tp(1)}の終値だけで決まります。`
  if (goal.kind === 'direction') {
    const item = listed[0]
    if (item?.kind === 'relative') return `${tp(goal.bar)}の向きは、${tp(goal.bar)}の終値と仮定した${tp(item.otherK)}の終値の関係で決まります。価格水準はいくらでも取れますが、固定の境界価格はありません。他の足は影響しません。`
    return goal.bar === 1
      ? `${tp(1)}の向きは${tp(1)}の終値だけで決まります (それ以降の足は影響しません)。`
      : `${tp(goal.bar)}の向きは${tp(goal.bar)}の終値だけで決まり、それ以前の足の終値はこの向きに影響しません (SMAの水準には影響します)。途中の足の向きは条件に含まれません。`
  }
  if (goal.kind === 'within') {
    const head = `${withinLabel(timeframe, goal.within)}のうちどれか1本でも条件を満たせば成立します (論理和・OR)。T+0 は数えず、到達後に外れても成立は変わりません。`
    return dependent
      ? `${head}${relativeNote}`
      : `${head}どの足の条件も確定済みの終値だけが基準なので、足ごとの条件は互いに独立です。`
  }
  if (goal.kind === 'reversal') {
    const head = analysis.combinator === 'sequence'
      ? `「反対向きの足」のあとに「目標の向きの足」が出る2段階が必要です。間の横ばいは数えず、転換した最初の足が転換点です。`
      : `直近の向きがすでに反対向きなので、${withinLabel(timeframe, goal.within)}のうち最初に目標の向きになった足が転換点です (横ばいは数えません)。`
    return dependent ? `${head}${relativeNote}` : head
  }
  const head = `${spanLabel(timeframe, goal.through)}のすべての足で条件が必要です (論理積・AND)。1本でも外れれば成立しません。`
  return dependent
    ? `${head}${relativeNote}`
    : `${head}どの足の条件も確定済みの終値だけが基準なので、足ごとの条件は互いに独立で、それぞれの範囲内なら自由に取れます。`
}

// ---------------------------------------------------------------------------
// Scope glossary: exact / within / throughout / reversal, with the real N

export interface ScopeGlossaryItem {
  id: 'direction' | 'within' | 'maintain' | 'reversal'
  term: string
  definition: string
  active: boolean
}

export function scopeGlossary(goal: SolverGoal, timeframe: SmaLabTimeframeId): ScopeGlossaryItem[] {
  const n = goal.kind === 'level' ? goal.bar : goalBars(goal)
  const last = timingLabel(timeframe, n)
  return [
    { id: 'direction', term: `${last}の時点だけ (T+${n} のみ)`, definition: `T+${n} の1本だけが目標の向きであれば成立。途中の足の向きは問いません。`, active: goal.kind === 'direction' },
    n === 1
      ? { id: 'within', term: `${last}に目標の向き (T+1 のみ)`, definition: `${singleBarScopeNote(timeframe)}N=1 では「その時点だけ」「一度でも」「ずっと」は同じ条件です。`, active: goal.kind === 'within' }
      : { id: 'within', term: `${withinLabel(timeframe, n)}に一度でも (T+1〜T+${n} の論理和)`, definition: `どれか1本でも目標の向きになれば成立。T+0 は含めず、到達後に外れても成立のままで、T+${n} の時点で目標の向きとは限りません。`, active: goal.kind === 'within' },
    n === 1
      ? { id: 'maintain', term: `${last}に目標の向き (T+1 のみ)`, definition: `${singleBarScopeNote(timeframe)}N=1 では「ずっと」も「一度でも」も同じ条件です。`, active: goal.kind === 'maintain' }
      : { id: 'maintain', term: `${spanLabel(timeframe, n)}ずっと (T+1〜T+${n} の論理積)`, definition: `すべての足が目標の向きのときだけ成立。1本でも外れれば不成立です。`, active: goal.kind === 'maintain' },
    { id: 'reversal', term: '転換 (符号反転)', definition: '横ばいを読み飛ばした直近の向きから、反対の向きへ実際に切り替わること。目標の向きに「なる」だけの「一度でも」とは別の条件です。', active: goal.kind === 'reversal' },
  ]
}

/** Short cautions against the classic mix-ups. Only the ones relevant to the current goal are returned. */
export function readingNotes(analysis: SolverAnalysis): string[] {
  const goal = analysis.goal
  const notes = [
    '条件を満たす価格が存在すること (数学的な成立可能性) は、実際に起こりやすいことを意味しません。',
    '代表経路は条件を満たす無数の経路のうちの一例で、唯一の解ではありません。',
  ]
  if (goal.kind !== 'level') notes.push('SMAの向き (直前の足との比較) と水準 (基準日のSMAとの比較) は別の条件です。')
  if ((goal.kind === 'within' && goal.within > 1) || goal.kind === 'reversal') notes.push('足ごとの必要価格の高低を比べても、どの足が起こりやすいかは分かりません。別の日の条件は前提が違います。')
  return notes
}

// ---------------------------------------------------------------------------
// First hit of the representative path

export type HitOutcome = 'last_bar' | 'held' | 'lost' | 'reversed'

export interface FirstHitMarker {
  k: number
  /** "4営業日後" */
  timing: string
  /** Confirmation date or session range of that bar. */
  period: string
  close: number
  sma: number | null
  /** Slope into the hit bar (the previous bar's direction; the current direction for T+1). */
  priorDirection: SmaDirection | null
  /** Reversal only: last non-flat direction before the hit. */
  priorNonFlat: SmaDirection | null
  hitDirection: SmaDirection
  outcome: HitOutcome
  lostK: number | null
  lostTo: SmaDirection | null
  oppositeK: number | null
  holdsAtEnd: boolean
  kind: 'within' | 'reversal'
  /** Short chart label. */
  label: string
  /** Full lines for tooltip / focus / aria. */
  lines: string[]
  ariaLabel: string
}

const REPRESENTATIVE_SCOPE = 'これは選択中の代表経路での最初の到達です。すべての経路で最も早い到達という意味ではありません。'

export function outcomeText(marker: Pick<FirstHitMarker, 'outcome' | 'lostK' | 'lostTo' | 'oppositeK' | 'holdsAtEnd' | 'hitDirection' | 'kind'>, goalBarsN: number, timeframe: SmaLabTimeframeId): string {
  const word = DIRECTION_LABEL[marker.hitDirection]
  const noun = marker.kind === 'reversal' ? '転換' : '到達'
  switch (marker.outcome) {
    case 'last_bar': return goalBarsN === 1 && marker.kind === 'within' ? singleBarScopeNote(timeframe) : `最後の足 (T+${goalBarsN}) での${noun}なので、その後の足はありません`
    case 'held': return `${noun}後は T+${goalBarsN} までずっと${word}のままです (${noun}前については何も保証しません)`
    case 'lost':
    case 'reversed': {
      const lost = marker.lostK != null ? `${timingLabel(timeframe, marker.lostK)} (T+${marker.lostK}) で${marker.lostTo ? DIRECTION_LABEL[marker.lostTo] : `${word}以外`}に変わり` : `途中で${word}でなくなり`
      const end = marker.holdsAtEnd ? `T+${goalBarsN} では再び${word}です` : `T+${goalBarsN} の時点では${word}ではありません`
      const back = marker.outcome === 'reversed' && marker.oppositeK != null ? `。反対向きになるのは T+${marker.oppositeK} です` : ''
      return `${noun}後に外れます: ${lost}、${end}${back}`
    }
  }
}

export function firstHitMarker(args: {
  goal: SolverGoal
  check: GoalCheck | null
  steps: ReadonlyArray<SmaStep> | null
  closes: ReadonlyArray<number | null> | null
  ctx: WordingContext
  futureBars: ReadonlyArray<SmaLabFutureBar> | undefined
  /** Direction of the confirmed SMA into the anchor bar. */
  currentDirection: SmaDirection | null
  retained: SolverAnalysis['retained']
  fmt: NumberFormat
}): FirstHitMarker | null {
  const { goal, check, steps, closes, ctx } = args
  if (goal.kind !== 'within' && goal.kind !== 'reversal') return null
  if (!check || check.hitK == null || !steps || !closes) return null
  const k = check.hitK
  const close = closes[k - 1]
  if (close == null) return null
  const step = steps[k - 1]
  const hitDirection = goalTarget(goal)
  const n = goalBars(goal)
  const name = smaLineName(goal.period, ctx.timeframe)
  const word = DIRECTION_LABEL[hitDirection]
  const priorDirection = k === 1 ? args.currentDirection : (check.directions[k - 2] ?? null)
  let priorNonFlat: SmaDirection | null = args.retained?.state === 'known' ? args.retained.direction : null
  for (let i = 0; i < k - 1; i += 1) {
    const direction = check.directions[i]
    if (direction && direction !== 'flat') priorNonFlat = direction
  }
  const after = check.aftermath
  const opposite = hitDirection === 'up' ? 'down' : hitDirection === 'down' ? 'up' : null
  const outcome: HitOutcome = k === n ? 'last_bar'
    : after?.heldThrough ? 'held'
    : after && (after.oppositeK != null || (opposite != null && after.lostTo === opposite)) ? 'reversed'
    : 'lost'
  const partial = {
    outcome,
    lostK: after?.lostK ?? null,
    lostTo: after?.lostTo ?? null,
    oppositeK: after?.oppositeK ?? null,
    holdsAtEnd: after?.holdsAtEnd ?? true,
    hitDirection,
    kind: goal.kind,
  }
  const period = periodText(args.futureBars, k)
  const timing = timingLabel(ctx.timeframe, k)
  const noun = goal.kind === 'reversal' ? '転換' : '到達'
  const sma = step?.sma ?? null
  const priorText = goal.kind === 'reversal'
    ? `転換前の向き ${priorNonFlat ? DIRECTION_LABEL[priorNonFlat] : '履歴なし'} (横ばいを除く)・直前の足 ${priorDirection ? DIRECTION_LABEL[priorDirection] : '—'}`
    : `直前の向き ${priorDirection ? DIRECTION_LABEL[priorDirection] : '—'}`
  const lines = [
    `${timing} (T+${k}${period ? ` ・ ${period}` : ''}) に初めて${name}が${word}`,
    `仮定した終値 ${ctx.exact(close)}${ctx.unit}${sma != null ? ` ・ ${name} ${args.fmt(sma)}` : ''}`,
    `${priorText} → ${noun}時 ${word}`,
    outcomeText({ ...partial }, n, ctx.timeframe),
    ...(isSingleBarSameDirection(goal) ? [] : [REPRESENTATIVE_SCOPE]),
  ]
  return {
    k, timing, period, close, sma, priorDirection, priorNonFlat, ...partial,
    label: `例の経路の最初の${noun} T+${k}`,
    lines,
    ariaLabel: `この例の経路の最初の${noun}: ${lines.join('。')}`,
  }
}

// ---------------------------------------------------------------------------
// Layer 1: one dynamic conclusion sentence, Layer 2: key figures

export interface InsightFigure {
  id: 'current' | 'target' | 'hit' | 'close' | 'sma' | 'boundary'
  label: string
  value: string
}

export interface SolverInsight {
  sentence: string
  figures: InsightFigure[]
}

function dirWord(direction: SmaDirection | null | undefined): string {
  return direction ? DIRECTION_LABEL[direction] : '判定できません'
}

/** Date/bar-specific boundary of the requirement a figure points at; never a boundary shared across bars. */
function requirementBoundary(req: Listed, analysis: SolverAnalysis, ctx: WordingContext): string {
  const when = timingLabel(ctx.timeframe, req.k)
  if (req.kind === 'relative') return `${when}の終値 ${req.op} 仮定した${timingLabel(ctx.timeframe, req.otherK)}の終値 (固定の価格はありません)`
  const v = `${ctx.exact(req.value)}${ctx.unit}`
  const qual = boundQualifier(req.op, req, analysis.domain.grid != null, ctx)
  return `${when}の終値 ${req.op} ${v}${req.op === '=' ? '' : ' (ちょうどなら横ばい)'}${qual && req.op !== '=' ? `・${qual}` : ''}`
}

/** True when every future close on the path equals the anchor close (the price-freeze example). */
export function isPriceFreezePath(closes: ReadonlyArray<number | null> | null | undefined, anchorClose: number | null | undefined): boolean {
  return anchorClose != null && closes != null && closes.length > 0 && closes.every((close) => close === anchorClose)
}

/** Compact "what happens after the first hit" clause for Layer 1 (the full wording stays in the marker lines). */
function compactAftermath(hit: FirstHitMarker, n: number, timeframe: SmaLabTimeframeId): string {
  const word = DIRECTION_LABEL[hit.hitDirection]
  const noun = hit.kind === 'reversal' ? '転換' : '到達'
  if (hit.outcome === 'last_bar') return `これが最後の足 (T+${n}) なので、その後は見ていません`
  if (hit.outcome === 'held') return `その後は T+${n} までずっと${word}のままです`
  const to = hit.lostTo ? DIRECTION_LABEL[hit.lostTo] : null
  const lost = hit.lostK != null
    ? `${timingLabel(timeframe, hit.lostK)}には${to ? `${to}${hit.lostTo === 'flat' ? 'へ戻ります' : 'になります'}` : `${word}でなくなります`}`
    : `${noun}後に${word}でなくなります`
  return hit.holdsAtEnd ? `${lost}が、T+${n} では再び${word}です` : lost
}

export function solverInsight(args: {
  analysis: SolverAnalysis
  ctx: WordingContext
  check: GoalCheck | null
  hit: FirstHitMarker | null
  steps: ReadonlyArray<SmaStep> | null
  futureBars: ReadonlyArray<SmaLabFutureBar> | undefined
  fmt: NumberFormat
  /** Representative path closes and the anchor close; used to word the price-freeze example specifically. */
  closes?: ReadonlyArray<number | null> | null
  anchorClose?: number | null
}): SolverInsight {
  const { analysis, ctx, hit } = args
  const goal = analysis.goal
  const name = smaLineName(goal.period, ctx.timeframe)
  const target = goalTarget(goal)
  const word = DIRECTION_LABEL[target]
  const cond = priceCondition(analysis, ctx)
  const listed = listedRequirements(analysis)
  const feasible = analysis.status === 'feasible'
  const n = goal.kind === 'level' ? goal.bar : goalBars(goal)

  let sentence: string
  if (!feasible) {
    sentence = cond.headline || '条件を計算できません。'
  } else if (goal.kind === 'direction') {
    const req = listed[0]
    const when = timingLabel(ctx.timeframe, goal.bar)
    const need = !req ? '条件を満たす終値が必要です'
      : req.kind === 'relative' ? `終値が仮定した${timingLabel(ctx.timeframe, req.otherK)}の終値${REL_WORD[req.op]}必要があります`
      : req.op === '=' ? `終値がちょうど${ctx.exact(req.value)}${ctx.unit}になる必要があります`
      : `終値が${ctx.exact(req.value)}${ctx.unit}を${req.op === '>' ? '上回る' : '下回る'}必要があります（${ctx.exact(req.value)}${ctx.unit}なら横ばい）`
    sentence = `${when}に${name}を${word}にするには、${need}。`
  } else if (goal.kind === 'within' || goal.kind === 'reversal') {
    const reversal = goal.kind === 'reversal'
    const lead = isPriceFreezePath(args.closes, args.anchorClose) ? `終値を${ctx.exact(args.anchorClose!)}${ctx.unit}のままにする例では、` : '選んだ代表経路では、'
    if (hit && isSingleBarSameDirection(goal)) {
      sentence = `${lead}${name}は${hit.timing}に${word}になります。${singleBarScopeNote(ctx.timeframe)}`
    } else if (hit) {
      const prior = reversal && hit.priorNonFlat ? `${DIRECTION_LABEL[hit.priorNonFlat]}から` : ''
      const event = reversal ? `${name}は${hit.timing}に${prior}${word}へ転換し` : `${name}は${hit.timing}に初めて${word}になり`
      sentence = `${lead}${event}、${compactAftermath(hit, n, ctx.timeframe)}。`
    } else {
      sentence = isSingleBarSameDirection(goal)
        ? `${timingLabel(ctx.timeframe, 1)}に${name}が${word}になる条件は成立しますが、選んだ補助条件では代表経路が見つかっていません。`
        : `${withinLabel(ctx.timeframe, n)}に${reversal ? `${word}へ転換する` : `一度でも${name}が${word}になる`}条件は成立しますが、選んだ補助条件では代表経路が見つかっていません。`
    }
  } else if (goal.kind === 'maintain' && goal.through === 1) {
    const req = listed[0]
    sentence = `${timingLabel(ctx.timeframe, 1)}に${name}を${word}にするには、${req ? requirementBoundary(req, analysis, ctx) : '条件を満たす終値が必要です'}。${singleBarScopeNote(ctx.timeframe)}`
  } else if (goal.kind === 'maintain') {
    sentence = `${spanLabel(ctx.timeframe, n)}のすべての足で${name}を${word}にするには、各足の条件を同時に満たす必要があります。${hasRelativeRequirements(analysis) ? '一部の足は仮定した価格どうしの関係で決まります。' : ''}${analysis.startsWithTurn ? '現在の向きと違うため、T+1 で向きを変えるところから始まります。' : ''}`
  } else {
    sentence = `${cond.headline}`
  }

  const figures: InsightFigure[] = [
    { id: 'current', label: '現在の向き', value: dirWord(ctx.current) },
    { id: 'target', label: '目標', value: goal.kind === 'level' ? `基準日より${word.replace('向き', '')}` : goal.kind === 'reversal' ? `${word}へ転換` : `${word}` },
  ]
  if (feasible && (goal.kind === 'within' || goal.kind === 'reversal')) {
    figures.push({ id: 'hit', label: 'この例の最初の' + (goal.kind === 'reversal' ? '転換' : '到達'), value: hit ? `${hit.timing} (T+${hit.k})${hit.period ? ` ${hit.period}` : ''}` : '例の経路では起きません' })
    figures.push({ id: 'close', label: 'その日の仮定終値', value: hit ? `${ctx.exact(hit.close)}${ctx.unit}` : '—' })
    figures.push({ id: 'sma', label: `その日の${name}`, value: hit && hit.sma != null ? args.fmt(hit.sma) : '—' })
  } else if (feasible && (goal.kind === 'direction' || goal.kind === 'level')) {
    const k = goal.bar
    figures.push({ id: 'hit', label: '判定する足', value: `${timingLabel(ctx.timeframe, k)} (T+${k})${periodText(args.futureBars, k) ? ` ${periodText(args.futureBars, k)}` : ''}` })
    const step = args.steps?.[k - 1]
    figures.push({ id: 'close', label: 'この例の仮定終値', value: step?.incoming != null ? `${ctx.exact(step.incoming)}${ctx.unit}` : '—' })
    figures.push({ id: 'sma', label: `その日の${name}`, value: step?.sma != null ? args.fmt(step.sma) : '—' })
  } else if (feasible) {
    figures.push({ id: 'hit', label: '判定する足', value: `T+1〜T+${n}` })
  }
  if (feasible) {
    let boundary: string
    if (analysis.sum) boundary = cond.headline
    else if (goal.kind === 'direction' && listed[0]) boundary = requirementBoundary(listed[0], analysis, ctx)
    else if (hit && (goal.kind === 'within' || goal.kind === 'reversal')) {
      const req = [...analysis.requirements].find((item): item is Listed => (item.kind === 'threshold' || item.kind === 'relative') && item.k === hit.k)
      boundary = req ? `${requirementBoundary(req, analysis, ctx)} (この到達足の条件)` : '足ごとに異なります'
    } else boundary = `足ごとに異なります (${listed.length}本。詳細を参照)`
    figures.push({ id: 'boundary', label: '適用される境界', value: boundary })
  }
  return { sentence, figures }
}
