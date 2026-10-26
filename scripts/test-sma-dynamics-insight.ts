// SMA Dynamics Lab Phase 2.3 (insight-first): dynamic conclusion, first-hit marker, path-dependency copy.
// Deterministic, synthetic/fixture only. The solver math is consumed, never changed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSmaDynamicsFixtures } from '@/lib/sma-dynamics-fixtures'
import { buildSmaLabChartModel } from '@/lib/sma-dynamics-chart-model'
import { computeSmaLab, priceFreezePath, type SmaLabAvailable, type SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import {
  analyzeSolverGoal,
  anchorDirection,
  checkGoal,
  DEFAULT_SOLVER_DRAFT,
  forwardBase,
  PATH_ASSUMPTIONS,
  priceDomain,
  representativePath,
  smaSteps,
  type ForwardBase,
  type SmaDirection,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import { priceCondition, type WordingContext } from '@/lib/sma-dynamics-solver-copy'
import {
  conditionStructureText,
  firstHitMarker,
  hasRelativeRequirements,
  pathDependencyRule,
  readingNotes,
  relativeInstances,
  scopeGlossary,
  solverInsight,
} from '@/lib/sma-dynamics-insight'
import { FirstHitMarkerView } from '@/components/stock/sma-dynamics/SmaDynamicsChart'
import { hitHighlight, SolverConclusion, SolverDetails, solverFirstHit, uniquenessText, type SolverViewModel } from '@/components/stock/sma-dynamics/SmaSolverPanel'
import { exactFormatter } from '@/components/stock/sma-dynamics/SmaSimulationParts'
import { priceFormatter } from '@/components/stock/sma-dynamics/SmaDynamicsPanels'

const exact = (value: number | null | undefined) => (value == null ? '—' : String(Number(value.toFixed(6))))
const fmt = (value: number | null | undefined) => (value == null ? '—' : value.toFixed(2))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const noop = () => undefined

function base(closes: number[], horizon = 8): ForwardBase {
  return { confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose: closes.at(-1)!, horizon }
}
const ctxFor = (b: ForwardBase, period: SmaLabPeriod = 3): WordingContext => ({ timeframe: '1D', current: anchorDirection(b, period)?.direction ?? null, unit: '円', exact })

// Up-trending history, SMA3: leaving closes for T+1..T+3 are 13, 14, 15; from T+4 the leaving close is the assumed T+1.
const UP = base([10, 11, 12, 13, 14, 15])
const within = (n: number, direction: SmaDirection, period: SmaLabPeriod = 3): SolverGoal => ({ kind: 'within', period, within: n, direction })

function markerFor(b: ForwardBase, goal: SolverGoal, closes: number[]) {
  const analysis = analyzeSolverGoal(b, goal)
  const check = checkGoal(b, goal, closes)
  const steps = smaSteps(b, closes, goal.period)
  const marker = firstHitMarker({ goal, check, steps, closes, ctx: ctxFor(b, goal.period), futureBars: undefined, currentDirection: analysis.anchorDirection?.direction ?? null, retained: analysis.retained, fmt })
  return { analysis, check, steps, marker }
}
const pad = (head: number[], n = 8) => [...head, ...Array(n - head.length).fill(20)]

// ---------------------------------------------------------------------------
// 1. Within: first hit at T+1, T+4, T+N, none.
{
  const goal = within(5, 'down')
  const t1 = markerFor(UP, goal, pad([12, 13, 14, 15, 16]))
  assert.equal(t1.check.hitK, 1)
  assert.equal(t1.marker?.k, 1)
  assert.equal(t1.marker?.priorDirection, 'up', 'T+1 prior direction is the current (anchor) direction')
  assert.equal(t1.marker?.hitDirection, 'down')

  // x1=14 up, x2=15 up, x3=16 up, x4=13 < x1=14 → down at T+4.
  const t4 = markerFor(UP, goal, pad([14, 15, 16, 13, 17]))
  assert.equal(t4.marker?.k, 4)
  assert.equal(t4.marker?.close, 13)
  assert.equal(t4.marker?.sma, t4.steps[3].sma)
  assert.equal(t4.marker?.priorDirection, 'up')
  assert.match(t4.marker!.timing, /4営業日後/)

  // x4=15 up (>14), x5=14 < x2=15 → down only at T+N=5.
  const t5 = markerFor(UP, goal, pad([14, 15, 16, 15, 14]))
  assert.equal(t5.marker?.k, 5)
  assert.equal(t5.marker?.outcome, 'last_bar')
  assert.match(t5.marker!.lines.join(' '), /最後の足 \(T\+5\)/)

  const none = markerFor(UP, goal, pad([14, 15, 16, 15, 16]))
  assert.equal(none.check.hitK, null)
  assert.equal(none.marker, null, 'no hit → no marker')
  const insight = solverInsight({ analysis: none.analysis, ctx: ctxFor(UP), check: none.check, hit: null, steps: none.steps, futureBars: undefined, fmt })
  assert.match(insight.sentence, /代表経路が見つかっていません/, 'sentence never invents a hit')
  assert.ok(insight.figures.some((item) => item.id === 'hit' && /起きません/.test(item.value)))
}

// ---------------------------------------------------------------------------
// 2. Hit, then held / lost / reversed: end state is separate from first hit.
{
  const goal = within(5, 'down')
  const held = markerFor(UP, goal, pad([12, 11, 10, 9, 8]))
  assert.equal(held.marker?.k, 1)
  assert.equal(held.marker?.outcome, 'held')
  assert.match(held.marker!.lines.join(' '), /T\+5 までずっと下向きのまま/)

  const reversed = markerFor(UP, goal, pad([12, 15, 16, 17, 18]))
  assert.equal(reversed.marker?.k, 1)
  assert.equal(reversed.marker?.outcome, 'reversed', 'a later opposite-direction bar')
  assert.equal(reversed.marker?.lostK, 2)
  assert.equal(reversed.marker?.holdsAtEnd, false)
  assert.match(reversed.marker!.lines.join(' '), /T\+2 \) ?で上向きに変わり|T\+2\) で上向きに変わり/)
  assert.match(reversed.marker!.lines.join(' '), /T\+5 の時点では下向きではありません/)

  // x1=12 down, x2=14 (= out 14) flat → lost to flat, never opposite.
  const lost = markerFor(UP, goal, pad([12, 14, 15, 12, 14]))
  assert.equal(lost.marker?.outcome, 'lost')
  assert.equal(lost.marker?.lostTo, 'flat')
  assert.equal(lost.marker?.oppositeK, null)

  // Same path, three different questions: within holds, exact N and throughout do not.
  const closes = pad([12, 15, 16, 17, 18])
  assert.equal(checkGoal(UP, within(5, 'down'), closes).satisfied, true, 'within: hit at T+1 is enough')
  assert.equal(checkGoal(UP, { kind: 'direction', period: 3, bar: 5, direction: 'down' }, closes).satisfied, false, 'exact N judges T+5 only')
  assert.equal(checkGoal(UP, { kind: 'maintain', period: 3, through: 5, direction: 'down' }, closes).satisfied, false, 'throughout needs every bar')
  const sentence = solverInsight({ analysis: reversed.analysis, ctx: ctxFor(UP), check: reversed.check, hit: reversed.marker, steps: reversed.steps, futureBars: undefined, fmt }).sentence
  assert.match(sentence, /^選んだ代表経路では、3日線は次の営業日に初めて下向きになり、2営業日後には上向きになります。$/)
  assert.ok(!/しだい|現在の/.test(sentence), 'no abstract filler or current-direction preamble in Layer 1')
  assert.ok(sentence.length < 60, `Layer 1 stays one short sentence: ${sentence}`)

  // Price-freeze example: states the anchor close dynamically; a non-freeze path never claims it.
  const freezeB = base([10, 11, 12, 13, 16, 15])
  const freezeCloses = priceFreezePath(freezeB.anchorClose, freezeB.horizon)
  const fz = markerFor(freezeB, within(5, 'down'), freezeCloses)
  const fzSentence = solverInsight({ analysis: fz.analysis, ctx: ctxFor(freezeB), check: fz.check, hit: fz.marker, steps: fz.steps, futureBars: undefined, fmt, closes: freezeCloses, anchorClose: freezeB.anchorClose }).sentence
  assert.match(fzSentence, new RegExp(`^終値を${freezeB.anchorClose}円のままにする例では、3日線は`), fzSentence)
  assert.match(fzSentence, /2営業日後に初めて下向きになり、3営業日後には横ばいへ戻ります。$/, fzSentence)
  assert.ok(!/選んだ代表経路/.test(fzSentence))
  // Same marker but different anchor figure / non-freeze closes → representative-path wording.
  const nf = solverInsight({ analysis: reversed.analysis, ctx: ctxFor(UP), check: reversed.check, hit: reversed.marker, steps: reversed.steps, futureBars: undefined, fmt, closes: pad([12, 15, 16, 17, 18]), anchorClose: UP.anchorClose }).sentence
  assert.match(nf, /^選んだ代表経路では、/)
  const lenFreeze = [...freezeCloses]
  lenFreeze[3] = freezeB.anchorClose + 1
  const nf2 = solverInsight({ analysis: fz.analysis, ctx: ctxFor(freezeB), check: fz.check, hit: fz.marker, steps: fz.steps, futureBars: undefined, fmt, closes: lenFreeze, anchorClose: freezeB.anchorClose }).sentence
  assert.match(nf2, /^選んだ代表経路では、/, 'one differing close is not a price freeze')
  // Exact-N: compact threshold sentence with the flat boundary in full-width parentheses.
  const exactN = analyzeSolverGoal(freezeB, { kind: 'direction', period: 3, bar: 1, direction: 'up' })
  const exactSentence = solverInsight({ analysis: exactN, ctx: ctxFor(freezeB), check: null, hit: null, steps: null, futureBars: undefined, fmt }).sentence
  assert.match(exactSentence, /^次の営業日に3日線を上向きにするには、終値が[\d.]+円を上回る必要があります（[\d.]+円なら横ばい）。$/, exactSentence)
}

// ---------------------------------------------------------------------------
// 3. Current already the target: T+0 excluded; up/flat/down and reversal stay distinct.
{
  const goal = within(3, 'up')
  const analysis = analyzeSolverGoal(UP, goal)
  assert.equal(analysis.currentlyTarget, true)
  // x1=12 < 13 down, x2=13 < 14 down, x3=14 < 15 down → never up although T+0 is up.
  const miss = markerFor(UP, goal, pad([12, 13, 14]))
  assert.equal(miss.check.hitK, null, 'T+0 is not a hit')
  assert.equal(miss.marker, null)
  assert.match(priceCondition(analysis, ctxFor(UP)).headline, /T\+0 は数えません/)

  // Reaching "up" is not a reversal to up when the retained direction is already up.
  const stayUp = pad([16, 17, 18])
  assert.equal(checkGoal(UP, within(3, 'up'), stayUp).hitK, 1)
  const reversal: SolverGoal = { kind: 'reversal', period: 3, within: 5, to: 'up' }
  assert.equal(checkGoal(UP, reversal, stayUp).hitK, null, 'staying up is not an up reversal')
  // down first (x1=12), then up (x2=15 > 14): sign change at T+2 from a down-then-up retained path.
  const turn = markerFor(UP, reversal, pad([12, 15, 16, 17, 18]))
  assert.equal(turn.marker?.k, 2)
  assert.equal(turn.marker?.kind, 'reversal')
  assert.equal(turn.marker?.hitDirection, 'up')
  assert.equal(turn.marker?.priorNonFlat, 'down')
  assert.match(turn.marker!.lines.join(' '), /転換前の向き 下向き/)
  assert.match(turn.marker!.label, /転換/)
  const flat = markerFor(UP, within(4, 'flat'), pad([13, 15, 16, 17]))
  assert.equal(flat.marker?.hitDirection, 'flat')
  assert.equal(flat.marker?.k, 1, 'x1 = 13 = leaving close → exactly flat')
}

// ---------------------------------------------------------------------------
// 4. Path dependency: SMA3/5 with horizon > period and T+20.
{
  const long = base([10, 11, 12, 13, 14, 15], 20)
  const goal = within(20, 'down')
  const analysis = analyzeSolverGoal(long, goal)
  assert.equal(hasRelativeRequirements(analysis), true)
  const closes = Array.from({ length: 20 }, (_, i) => 20 + i)
  const instances = relativeInstances(analysis, ctxFor(long), closes)
  const t4 = instances.find((item) => item.k === 4)!
  assert.equal(t4.otherK, 1, 'SMA3: T+4 drops the assumed T+1 close')
  assert.equal(instances.find((item) => item.k === 20)!.otherK, 17, 'T+20 drops the assumed T+17 close')
  assert.match(t4.text, /4営業日後 \(T\+4\) の終値が、仮定した次の営業日 \(T\+1\) の終値より低いこと/)
  assert.match(t4.text, /T\+4 = 23円、T\+1 = 20円/, 'the earlier assumed close is shown')
  assert.equal(instances.some((item) => item.k <= 3), false, 'k <= N stays a confirmed-price threshold')

  const rule = pathDependencyRule(3, '1D')
  assert.match(rule, /SMA_N\(T\+k\) − SMA_N\(T\+k−1\) = \[P\(T\+k\) − P\(T\+k−N\)\] \/ N/)
  assert.match(rule, /k ≤ 3/)
  assert.match(rule, /4営業日後以降/)
  assert.match(rule, /固定の境界価格は存在せず/)

  const structure = conditionStructureText(analysis, '1D')
  assert.match(structure, /論理和・OR/)
  assert.doesNotMatch(structure, /互いに独立で/, 'no independence claim with relative requirements')
  assert.match(structure, /独立に扱えません/)
  assert.match(structure, /4営業日後以降の条件は、窓から抜ける仮定した終値/)
  assert.equal(uniquenessText(analysis, '1D'), structure, 'panel export delegates to the dynamic helper')

  const maintain = analyzeSolverGoal(long, { kind: 'maintain', period: 3, through: 20, direction: 'up' })
  const maintainText = conditionStructureText(maintain, '1D')
  assert.match(maintainText, /論理積・AND/)
  assert.doesNotMatch(maintainText, /互いに独立で/)

  // SMA5, N=3 ≤ period: only confirmed thresholds → independence is true and may be said.
  const small = analyzeSolverGoal(base([9, 10, 11, 12, 13, 14, 15, 16]), within(3, 'down', 5))
  assert.equal(hasRelativeRequirements(small), false)
  assert.match(conditionStructureText(small, '1D'), /足ごとの条件は互いに独立/)
  const smallMaintain = analyzeSolverGoal(base([9, 10, 11, 12, 13, 14, 15, 16]), { kind: 'maintain', period: 5, through: 3, direction: 'down' })
  assert.match(conditionStructureText(smallMaintain, '1D'), /互いに独立/)

  // SMA5 with horizon 8: relative from T+6.
  const five = analyzeSolverGoal(base([5, 6, 7, 8, 9, 10, 11, 12], 8), within(8, 'down', 5))
  assert.equal(relativeInstances(five, ctxFor(UP, 5), null).map((item) => item.k).join(','), '6,7,8')

  // Condition view: relative bars are phrased against the earlier assumed close, never a single boundary.
  const view = priceCondition(analysis, ctxFor(long))
  assert.equal(view.pathDependent, true)
  assert.ok(view.lines.some((line) => /^4営業日後なら、終値が仮定した次の営業日の終値より低ければ/.test(line)))
  assert.ok(view.lines.some((line) => /次の営業日なら、終値が13円を下回れば/.test(line)), 'confirmed bars keep their own date-specific threshold')
}

// ---------------------------------------------------------------------------
// 5. No "最も緩い条件"; strict / equal / tick boundary wording stays exact.
{
  const analysis = analyzeSolverGoal(UP, within(3, 'down'))
  const view = priceCondition(analysis, ctxFor(UP))
  const all = [view.headline, ...view.lines].join(' ')
  assert.doesNotMatch(all, /最も緩い|最も楽|最も簡単|起こりやすい条件/)
  assert.match(view.headline, /価格の高低で起こりやすさは比べられません/)
  assert.ok(view.lines.some((line) => line.startsWith('次の営業日なら、終値が13円を下回れば')))
  assert.ok(view.lines.some((line) => line.startsWith('3営業日後なら、終値が15円を下回れば')))

  const reversalView = priceCondition(analyzeSolverGoal(base([15, 14, 13, 12, 11, 10]), { kind: 'reversal', period: 3, within: 3, to: 'up' }), ctxFor(base([15, 14, 13, 12, 11, 10])))
  assert.doesNotMatch([reversalView.headline, ...reversalView.lines].join(' '), /最も緩い/)

  const strictUp = priceCondition(analyzeSolverGoal(UP, { kind: 'direction', period: 3, bar: 1, direction: 'up' }), ctxFor(UP)).headline
  assert.match(strictUp, /13円を上回れば/)
  assert.match(strictUp, /ちょうど13円なら横ばい/)
  const eq = priceCondition(analyzeSolverGoal(UP, { kind: 'direction', period: 3, bar: 1, direction: 'flat' }), ctxFor(UP)).headline
  assert.match(eq, /ちょうど13円で/)
  const tick = priceCondition(analyzeSolverGoal(UP, { kind: 'direction', period: 3, bar: 1, direction: 'up' }, { min: null, max: null, tick: 0.5 }), ctxFor(UP))
  assert.ok(tick.lines.some((line) => line.includes('刻みを考慮すると最小13.5円')))

  // Exact number survives: 12.345678 is not rounded away in the sentence.
  const fine = base([10, 11, 12.345678, 13, 14, 15])
  const insight = solverInsight({ analysis: analyzeSolverGoal(fine, { kind: 'direction', period: 3, bar: 1, direction: 'up' }), ctx: ctxFor(fine), check: null, hit: null, steps: null, futureBars: undefined, fmt })
  assert.match(insight.sentence, /13円を上回る必要があります（13円なら横ばい）/)
  const fineThree = base([10, 11, 12.345678, 13.123457, 14, 15])
  const fineInsight = solverInsight({ analysis: analyzeSolverGoal(fineThree, { kind: 'direction', period: 3, bar: 1, direction: 'down' }), ctx: ctxFor(fineThree), check: null, hit: null, steps: null, futureBars: undefined, fmt })
  assert.match(fineInsight.sentence, /13\.123457円を下回る必要/)
  assert.equal(fineInsight.figures.find((item) => item.id === 'boundary')?.value.includes('13.123457円'), true)
}

// ---------------------------------------------------------------------------
// 6. Glossary / reading notes distinguish the scopes.
{
  const glossary = scopeGlossary(within(5, 'up'), '1D')
  assert.deepEqual(glossary.map((item) => item.id), ['direction', 'within', 'maintain', 'reversal'])
  assert.deepEqual(glossary.filter((item) => item.active).map((item) => item.id), ['within'])
  assert.match(glossary[0].term, /T\+5 のみ/)
  assert.match(glossary[1].term, /T\+1〜T\+5 の論理和/)
  assert.match(glossary[1].definition, /T\+0 は含めず/)
  assert.match(glossary[2].term, /論理積/)
  assert.match(glossary[3].definition, /「一度でも」とは別の条件/)
  const notes = readingNotes(analyzeSolverGoal(UP, within(3, 'down'))).join(' ')
  assert.match(notes, /数学的な成立可能性/)
  assert.match(notes, /唯一の解ではありません/)
  assert.match(notes, /向き.*水準.*別の条件/)
  assert.match(notes, /どの足が起こりやすいかは分かりません/)
}

// ---------------------------------------------------------------------------
// 7. Marker ↔ representative path ↔ chart model ↔ rendered markup.
{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  const build = (horizon: number) => computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon, analysisDate: fixture.analysisDate }) as SmaLabAvailable
  const result = build(20)
  const fb = forwardBase(result)
  const fmtP = priceFormatter(1)
  const fmtE = exactFormatter(1)
  const modelFor = (goal: SolverGoal): SolverViewModel => {
    const analysis = analyzeSolverGoal(fb, goal)
    const paths = Object.fromEntries(PATH_ASSUMPTIONS.map((item) => [item.id, representativePath(fb, analysis, item.id, 0.1)])) as SolverViewModel['paths']
    return { goal, analysis, paths, scenarioCheck: null, freezeCheck: checkGoal(fb, goal, priceFreezePath(fb.anchorClose, fb.horizon), priceDomain({ min: null, max: null, tick: null })), comparison: null }
  }
  const goal: SolverGoal = { kind: 'within', period: 5, within: 10, direction: 'down' }
  const model = modelFor(goal)
  for (const assumption of ['hold', 'constant', 'linear', 'geometric'] as const) {
    const draft = { ...DEFAULT_SOLVER_DRAFT, assumption }
    const path = model.paths[assumption]
    const hit = solverFirstHit({ result, base: fb, model, draft, fmt: fmtP, exact: fmtE, market: 'JP' })
    if (path.status !== 'found' || path.check?.hitK == null) { assert.equal(hit, null); continue }
    const steps = smaSteps(fb, path.closes!, 5)
    const k = path.check.hitK
    assert.equal(hit?.k, k, `${assumption}: marker bar = path's first hit`)
    assert.equal(hit?.close, path.closes![k - 1], `${assumption}: marker close = path close`)
    assert.equal(hit?.sma, steps[k - 1].sma, `${assumption}: marker SMA = path SMA`)
    assert.equal(hit?.period, result.projection.bars[k - 1].lastSession === result.projection.bars[k - 1].firstSession ? result.projection.bars[k - 1].lastSession : `${result.projection.bars[k - 1].firstSession}〜${result.projection.bars[k - 1].lastSession}`)
    assert.equal(hit?.priorDirection, k === 1 ? anchorDirection(fb, 5)?.direction : path.check.directions[k - 2])
    const highlight = hitHighlight(hit!)
    const chart = buildSmaLabChartModel(result, [5], { highlights: [highlight] })
    assert.equal(chart.highlights.length, 1)
    assert.equal(chart.highlights[0].price, path.closes![k - 1])
    assert.equal(chart.highlights[0].time, chart.slots.find((slot) => slot.future?.k === k)!.time)
    assert.deepEqual(chart.highlights[0].lines, hit!.lines, 'chart popover repeats the panel facts')
    assert.match(highlight.tag!, new RegExp(`初到達 T\\+${k} ・ `))
    assert.ok(hit!.lines.some((line) => line.includes('選択中の代表経路') || line.includes('すべての経路で最も早い到達という意味ではありません')))
    assert.ok(hit!.lines.join(' ').includes(hit!.period), 'date/period present')
    assert.ok(hit!.lines.join(' ').includes(fmtE(path.closes![k - 1])), 'assumed close present')
  }

  // Recompute when the inputs change: another goal / N gives a different marker.
  const a = solverFirstHit({ result, base: fb, model: modelFor({ ...goal, within: 3 }), draft: DEFAULT_SOLVER_DRAFT, fmt: fmtP, exact: fmtE, market: 'JP' })
  const b = solverFirstHit({ result, base: fb, model: modelFor({ kind: 'within', period: 5, within: 10, direction: 'up' }), draft: DEFAULT_SOLVER_DRAFT, fmt: fmtP, exact: fmtE, market: 'JP' })
  assert.ok(a == null || a.k <= 3, 'marker never beyond the selected N')
  assert.ok(b == null || b.hitDirection === 'up')

  // Rendered marker: real button, accessible name, text tag, popover only when open.
  const hit = solverFirstHit({ result, base: fb, model: modelFor({ kind: 'within', period: 5, within: 10, direction: 'up' }), draft: { ...DEFAULT_SOLVER_DRAFT, assumption: 'hold' }, fmt: fmtP, exact: fmtE, market: 'JP' })
    ?? solverFirstHit({ result, base: fb, model, draft: { ...DEFAULT_SOLVER_DRAFT, assumption: 'hold' }, fmt: fmtP, exact: fmtE, market: 'JP' })
  assert.ok(hit, 'fixture produces a hold-path hit')
  const highlight = hitHighlight(hit)
  const chart = buildSmaLabChartModel(result, [5], { highlights: [highlight] })
  const props = { id: 'x', marker: chart.highlights[0], pos: { x: 120, y: 80, width: 330, height: 260 }, onHover: noop, onFocus: noop, onToggle: noop, onClose: noop }
  const closed = renderToStaticMarkup(createElement(FirstHitMarkerView, { ...props, open: false }))
  assert.match(closed, /<button type="button"/)
  assert.match(closed, /aria-label="この例の経路の最初の到達/)
  assert.match(closed, /data-sma-hit-tag/)
  assert.doesNotMatch(closed, /role="tooltip"/)
  const open = renderToStaticMarkup(createElement(FirstHitMarkerView, { ...props, open: true }))
  assert.match(open, /role="tooltip"/)
  assert.match(text(open), /仮定した終値/)
  assert.match(text(open), /直前の向き/)
  assert.match(text(open), /すべての経路で最も早い到達という意味ではありません/)
  // 390px: popover never wider than the pane, button reaches 40px.
  const narrow = renderToStaticMarkup(createElement(FirstHitMarkerView, { ...props, pos: { ...props.pos, width: 300 }, open: true }))
  assert.match(narrow, /width:2[0-9]{2}px/)
  assert.match(narrow, /size-10/)

  // Result panel: Layer 1 sentence + Layer 2 figures visible; Layer 3 is a collapsed <details>.
  const draft = { ...DEFAULT_SOLVER_DRAFT, assumption: 'hold' as const }
  const conclusion = renderToStaticMarkup(createElement(SolverConclusion, { result, base: fb, model, draft, fmt: fmtP, exact: fmtE, market: 'JP' }))
  assert.match(conclusion, /data-solver-insight/)
  assert.match(conclusion, /data-solver-figures/)
  assert.match(conclusion, /<details class="group" data-solver-layer3="true">/, 'collapsed by default')
  assert.ok(conclusion.indexOf('data-solver-figures') < conclusion.indexOf('data-solver-layer3'), 'insight before detail')
  assert.match(conclusion, /data-solver-kind-tag="within"/, 'advanced rows are kept')
  assert.match(conclusion, /data-solver-hit-scope|data-solver-hit="none"/)
  const details = renderToStaticMarkup(createElement(SolverDetails, { result, base: fb, model, draft, fmt: fmtP, exact: fmtE, market: 'JP', onDraftChange: noop, onCopyToScenario: noop }))
  assert.match(details, /data-solver-path-dependency/)
  assert.match(details, /data-solver-relative-list/, 'SMA5 with a 10-bar horizon has path-dependent bars')
  assert.match(details, /data-solver-scope-glossary/)
  assert.match(details, /data-solver-reading-notes/)
  assert.match(text(details), /仮定した終値/)
  for (const markup of [conclusion, details]) {
    assert.doesNotMatch(text(markup), /最も緩い/)
    assert.doesNotMatch(text(markup), /各足の条件は独立で、到達後/)
  }
}

// ---------------------------------------------------------------------------
// 8. Source guard: forbidden claims never reappear in user-facing code.
{
  for (const file of ['lib/sma-dynamics-solver-copy.ts', 'lib/sma-dynamics-insight.ts', 'components/stock/sma-dynamics/SmaSolverPanel.tsx', 'components/stock/sma-dynamics/SmaDynamicsView.tsx', 'components/stock/sma-dynamics/SmaDynamicsChart.tsx']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /最も緩い/, `${file}: no "最も緩い" claim`)
    assert.doesNotMatch(source, /各足の条件は独立(で|しており)/, `${file}: no unconditional independence claim`)
  }
}

console.log('SMA Dynamics Phase 2.3 insight-first tests passed.')
