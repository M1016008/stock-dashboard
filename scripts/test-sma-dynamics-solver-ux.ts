// SMA Dynamics Lab Phase 2.2: direction-neutral inverse-solver UX contract.
// Deterministic, fixture/synthetic only: wording, timing sync, current direction,
// boundary honesty, and rendered markup. The Phase 2 solver math is only consumed here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSmaDynamicsFixtures } from '@/lib/sma-dynamics-fixtures'
import { computeSmaLab, smaLabMaxHorizonBars } from '@/lib/sma-dynamics-lab'
import { buildSmaLabChartModel } from '@/lib/sma-dynamics-chart-model'
import {
  analyzeSolverGoal,
  anchorDirection,
  anchorSmaValue,
  applySolverDraftPatch,
  DEFAULT_SOLVER_DRAFT,
  type ForwardBase,
  type SmaDirection,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import {
  compareDirections,
  describeCurrentDirection,
  describeTiming,
  goalCondition,
  goalTitle,
  priceCondition,
  smaLineName,
  solverBoundaries,
  solverDirectionHint,
  spanLabel,
  timingDate,
  timingLabel,
  withinLabel,
  type WordingContext,
} from '@/lib/sma-dynamics-solver-copy'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, SmaDynamicsView } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { CurrentDirectionCard, SolverDirectionPicker, SolverKindPicker, SolverTimingPicker } from '@/components/stock/sma-dynamics/SmaSolverSteps'
import { uniquenessText } from '@/components/stock/sma-dynamics/SmaSolverPanel'
import { SMA_PURPOSES } from '@/components/stock/sma-dynamics/SmaGuidedControls'

const exact = (value: number | null | undefined) => (value == null ? '—' : String(Number(value.toFixed(6))))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

function base(closes: number[], horizon = 8): ForwardBase {
  return { confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose: closes.at(-1)!, horizon }
}
const ctxFor = (b: ForwardBase, period: number, timeframe: WordingContext['timeframe'] = '1D'): WordingContext => ({
  timeframe, current: anchorDirection(b, period)?.direction ?? null, unit: '円', exact,
})

// ---------------------------------------------------------------------------
// 1. Mode names are direction-neutral; no "上向きにするには" anywhere user-facing.
{
  assert.deepEqual(SMA_PURPOSES.map((item) => item.label), ['株価が変わらなかったら？', '株価を自由に動かしてみる', 'SMAの向きを調べる'])
  assert.deepEqual(SMA_PURPOSES.map((item) => item.id), ['freeze', 'scenario', 'solver'], 'internal mode ids unchanged')
  assert.match(SMA_PURPOSES[2].hint, /上向き・横ばい・下向きにするための株価を調べます/)
  for (const file of ['SmaGuidedControls', 'SmaSolverPanel', 'SmaSolverSteps', 'SmaDynamicsView']) {
    const source = readFileSync(`components/stock/sma-dynamics/${file}.tsx`, 'utf8')
    assert.doesNotMatch(source, /上向きにするには|T\+3 = 3本先/, `${file}: no up-biased title or fixed T+3 help`)
  }
}

// ---------------------------------------------------------------------------
// 2. Timing labels for every timeframe follow the selected timeframe.
{
  const expected: Record<string, [string, string, string]> = {
    '1D': ['次の営業日', '3営業日後', '5営業日後'],
    '2D': ['次の2営業日足', '3本後', '5本後'],
    '3D': ['次の3営業日足', '3本後', '5本後'],
    '5D': ['次の5営業日足', '3本後', '5本後'],
    '1W': ['次の週足', '3週後', '5週後'],
    '2W': ['次の2週足', '3本後', '5本後'],
    '1M': ['次の月足', '3か月後', '5か月後'],
    '3M': ['次の四半期足', '3本後', '5本後'],
    '3W': ['次の3週足', '3本後', '5本後'],
    '2M': ['次の2か月足', '3本後', '5本後'],
    '6M': ['次の半年足', '3本後', '5本後'],
    '1Y': ['次の年足', '3年後', '5年後'],
    '2Y': ['次の2年足', '3本後', '5本後'],
    '3Y': ['次の3年足', '3本後', '5本後'],
    '5Y': ['次の5年足', '3本後', '5本後'],
  }
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const [one, three, five] = expected[timeframe.id]
    assert.deepEqual([1, 3, 5].map((k) => timingLabel(timeframe.id, k)), [one, three, five], `${timeframe.id}: timing labels`)
    assert.match(withinLabel(timeframe.id, 3), /以内$/)
    assert.match(spanLabel(timeframe.id, 5), /^今後5/)
  }
}

// Selected k drives label, date and caption: T+1 never shows a T+3 explanation, and vice versa.
{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: timeframe.id, horizon: Math.min(10, smaLabMaxHorizonBars(timeframe.id)) })
    if (result.status !== 'available') continue
    const bars = result.projection.bars
    for (const k of [1, 3, 5]) {
      const markup = renderToStaticMarkup(createElement(SolverTimingPicker, { timeframe: timeframe.id, kind: 'direction', value: k, maxK: 10, futureBars: bars, onPick: () => undefined }))
      const visible = text(markup)
      assert.ok(visible.includes(`T+${k}`), `${timeframe.id} k=${k}: caption names T+${k}`)
      for (const other of [1, 3, 5].filter((value) => value !== k)) {
        assert.ok(!new RegExp(`\\(T\\+${other}\\) =`).test(visible), `${timeframe.id} k=${k}: no stale T+${other} caption`)
      }
      assert.ok(visible.includes(bars[k - 1].lastSession), `${timeframe.id} k=${k}: confirmation date from the calendar projection`)
      assert.equal(timingDate(bars, k)!.iso, bars[k - 1].lastSession)
      assert.ok(describeTiming(timeframe.id, k, bars).includes(timingLabel(timeframe.id, k)))
      assert.match(markup, new RegExp(`aria-pressed="true"[^>]*data-timing-k="${k}"`), `${timeframe.id}: selected quick timing is pressed`)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Current direction: the 3 states + unavailable, from unrounded values.
{
  const matrix: Array<[string, number[], SmaDirection]> = [
    ['up', [10, 11, 12, 13, 14, 15], 'up'],
    ['down', [15, 14, 13, 12, 11, 10], 'down'],
    ['flat', [10, 11, 12, 13, 14, 12], 'flat'],
  ]
  for (const [label, closes, expected] of matrix) {
    const b = base(closes)
    const state = describeCurrentDirection({ period: 3, timeframe: '1D', anchorSma: anchorSmaValue(b, 3), anchor: anchorDirection(b, 3), exact })
    assert.equal(state.state, expected, label)
    assert.ok(state.headline.includes(`現在の3日線：${{ up: '上向き', flat: '横ばい', down: '下向き' }[expected]}`), `${label}: headline`)
  }
  // A change far below display precision is still an exact "up" (never rounded to flat).
  const tiny = base([100, 100, 100, 100, 100.0000001])
  const tinyState = describeCurrentDirection({ period: 3, timeframe: '1D', anchorSma: anchorSmaValue(tiny, 3), anchor: anchorDirection(tiny, 3), exact })
  assert.equal(tinyState.state, 'up')
  assert.equal(tinyState.nearFlat, true)
  // Insufficient history (SMA exists, direction needs N+1 bars): explicit, no guess.
  const short = base([10, 11, 12])
  const unknown = describeCurrentDirection({ period: 3, timeframe: '1D', anchorSma: anchorSmaValue(short, 3), anchor: anchorDirection(short, 3), exact })
  assert.equal(unknown.state, 'unavailable')
  assert.match(unknown.headline, /現在の向きは判定できません/)
  assert.match(unknown.detail, /推測で補完していません/)
  const none = describeCurrentDirection({ period: 5, timeframe: '1W', anchorSma: null, anchor: null, exact })
  assert.equal(none.state, 'unavailable')
  assert.match(none.headline, /週足SMA5/)
  const card = renderToStaticMarkup(createElement(CurrentDirectionCard, { state: unknown }))
  assert.match(card, /data-sma-current-direction="unavailable"/)
  const upCard = renderToStaticMarkup(createElement(CurrentDirectionCard, { state: describeCurrentDirection({ period: 3, timeframe: '1D', anchorSma: 14, anchor: anchorDirection(base(matrix[0][1]), 3), exact }) }))
  assert.ok(upCard.includes('↑') && upCard.includes('上向き'), 'arrow + text, not colour alone')
}

// ---------------------------------------------------------------------------
// 4. Wording: direction goal never claims continuity; 続ける only for an enforced maintain.
{
  const upBase = base([10, 11, 12, 13, 14, 15])
  const downBase = base([15, 14, 13, 12, 11, 10])
  for (const [b, currentWord] of [[upBase, '上向き'], [downBase, '下向き']] as const) {
    const ctx = ctxFor(b, 3)
    for (const direction of ['up', 'flat', 'down'] as const) {
      const goal: SolverGoal = { kind: 'direction', period: 3, bar: 3, direction }
      const condition = goalCondition(goal, ctx)
      assert.ok(condition.includes('3営業日後の時点で3日線が'), `${currentWord}→${direction}: neutral phrasing`)
      assert.doesNotMatch(condition, /続ける|維持/, 'single-bar direction does not claim continuity')
      assert.ok(goalTitle(goal, ctx).includes({ up: '上向き', flat: '横ばい', down: '下向き' }[direction]))
    }
    for (const direction of ['up', 'flat', 'down'] as const) {
      const goal: SolverGoal = { kind: 'maintain', period: 3, through: 5, direction }
      const phrase = goalCondition(goal, ctx)
      const same = (direction === 'up' && currentWord === '上向き') || (direction === 'down' && currentWord === '下向き')
      assert.equal(/続ける/.test(phrase), same, `${currentWord}→maintain ${direction}: 続ける only when it really is the current direction`)
    }
  }
  // Unknown current direction never produces 続ける.
  assert.doesNotMatch(goalCondition({ kind: 'maintain', period: 3, through: 5, direction: 'up' }, { ...ctxFor(upBase, 3), current: null }), /続ける/)
  assert.match(goalCondition({ kind: 'reversal', period: 3, within: 3, to: 'down' }, ctxFor(upBase, 3)), /3営業日以内に3日線が下向きへ転換 \(符号反転\) する条件/)
  assert.match(goalCondition({ kind: 'level', period: 3, bar: 3, relation: 'up' }, ctxFor(upBase, 3)), /基準日の3日線より高くなる条件/)
}

// ---------------------------------------------------------------------------
// 5. Price conditions are derived from the solver (no hard-coded numbers) and keep strictness.
{
  const b = base([10, 11, 12, 13, 14, 15])
  const ctx = ctxFor(b, 3)
  // T+1 outgoing close for SMA3 is confirmedCloses[anchor+1-3] = 13.
  const threshold = 13
  for (const [direction, phrase] of [['up', '13円を上回れば'], ['down', '13円を下回れば'], ['flat', 'ちょうど13円で']] as const) {
    const analysis = analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction })
    const view = priceCondition(analysis, ctx)
    assert.equal(view.kind, 'one')
    assert.ok(view.headline.includes(phrase), `${direction}: ${view.headline}`)
    assert.ok(view.headline.includes('次の営業日なら'), 'timing in words, not T+1')
    assert.ok(view.headline.includes(`3日線は${{ up: '上向き', flat: '横ばい', down: '下向き' }[direction]}になります`))
    if (direction !== 'flat') assert.ok(view.headline.includes(`ちょうど${threshold}円なら横ばいです。`), `${direction}: equality is flat, strict inequality`)
    assert.equal(view.pathDependent, false)
  }
  // Tick: boundary qualifier reflects the grid-aware minimum, not the raw threshold.
  const tick = analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction: 'up' }, { min: null, max: null, tick: 0.5 })
  assert.ok(priceCondition(tick, ctx).lines.some((line) => line.includes('刻みを考慮すると最小13.5円')))
  // Tick that excludes equality: infeasible wording, no number pretended.
  const flatMiss = analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction: 'flat' }, { min: null, max: null, tick: 2 })
  const flatView = priceCondition(flatMiss, ctx)
  assert.equal(flatView.kind, 'none')
  assert.match(flatView.headline, /刻みに乗らない/)
  // Out-of-bounds: nothing satisfies.
  const bounded = analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction: 'down' }, { min: 13, max: 20, tick: 0.5 })
  assert.match(priceCondition(bounded, ctx).headline, /この目標を満たす終値はありません/)
  // Multiple solutions: the representative path is flagged as an example in the UI source.
  const panel = readFileSync('components/stock/sma-dynamics/SmaSolverPanel.tsx', 'utf8')
  assert.match(panel, /この株価推移は一例/)
  assert.match(panel, /ほかにも条件を満たす動き方があります/)
}

// Path-dependent (relative) conditions: no fixed price, no boundary line.
{
  const b = base([10, 11, 12, 13, 14, 15])
  const ctx = ctxFor(b, 3)
  const goal: SolverGoal = { kind: 'direction', period: 3, bar: 5, direction: 'up' }
  const analysis = analyzeSolverGoal(b, goal)
  const view = priceCondition(analysis, ctx)
  assert.equal(view.kind, 'dependent')
  assert.equal(view.pathDependent, true)
  assert.match(view.headline, /5営業日後なら、終値が仮定した2営業日後の終値より高ければ/)
  assert.match(view.lines.join(' '), /単独の価格水準では示せません/)
  assert.deepEqual(solverBoundaries(analysis, ctx), [], 'no horizontal line for a path-dependent condition')
  const rows = compareDirections({ base: b, period: 3, bar: 5, constraints: { min: null, max: null, tick: null }, ctx })
  assert.ok(rows.every((row) => row.dependent && /固定の価格はありません/.test(row.text)), 'comparison gives no fixed number for path-dependent bars')
}

// ---------------------------------------------------------------------------
// 6. Three directions side by side agree with the solver.
{
  const b = base([10, 11, 12, 13, 14, 15])
  const ctx = ctxFor(b, 3)
  const rows = compareDirections({ base: b, period: 3, bar: 1, constraints: { min: null, max: null, tick: null }, ctx })
  assert.deepEqual(rows.map((row) => row.direction), ['up', 'flat', 'down'])
  assert.ok(rows[0].text.includes('13円を上回る') && rows[1].text.includes('ちょうど13円') && rows[2].text.includes('13円を下回る'))
  const tickRows = compareDirections({ base: b, period: 3, bar: 1, constraints: { min: null, max: null, tick: 2 }, ctx })
  assert.equal(tickRows[1].status, 'infeasible', 'tick 2 cannot hit 13 exactly')
  assert.equal(tickRows[0].status, 'feasible')
}

// ---------------------------------------------------------------------------
// 7. Chart boundaries: exact level per bar only; never one line for a multi-bar condition.
{
  const b = base([10, 11, 12, 13, 14, 15])
  const ctx = ctxFor(b, 3)
  const single = solverBoundaries(analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction: 'up' }), ctx)
  assert.equal(single.length, 1)
  assert.equal(single[0].price, 13)
  assert.equal(single[0].k, 1)
  assert.deepEqual([single[0].above, single[0].below], ['up', 'down'], 'above/below directions stated')
  assert.match(single[0].label, /次の営業日の境界 13 \(上↑ 同値→ 下↓\)/)
  const maintain = solverBoundaries(analyzeSolverGoal(b, { kind: 'maintain', period: 3, through: 3, direction: 'down' }), ctx)
  assert.deepEqual(maintain.map((item) => [item.k, item.price]), [[1, 13], [2, 14], [3, 15]], 'one marker per bar, each with its own price')
  const infeasible = analyzeSolverGoal(b, { kind: 'direction', period: 3, bar: 1, direction: 'down' }, { min: 13, max: 20, tick: 0.5 })
  assert.deepEqual(solverBoundaries(infeasible, ctx), [])
  const levelMany = solverBoundaries(analyzeSolverGoal(b, { kind: 'level', period: 3, bar: 3, relation: 'up' }), ctx)
  assert.deepEqual(levelMany, [], 'a mean condition is not a horizontal price boundary')
}

{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 5 })
  assert.equal(result.status, 'available')
  if (result.status === 'available') {
    const model = buildSmaLabChartModel(result, [5], { boundaries: [{ price: 100, label: 'bar', k: 3 }, { price: 90, label: 'all' }] })
    const [perBar, whole] = model.boundaries
    assert.ok(perBar.segment && perBar.segment.from < perBar.segment.to, 'per-bar boundary is a short segment ending on its bar')
    assert.equal(perBar.segment!.to, model.slots[model.anchorSlot + 3].time)
    assert.equal(whole.segment, null, 'a level without k stays a full-width line')
  }
}

// ---------------------------------------------------------------------------
// 8. Controls: 3 equal direction buttons, advanced kinds labelled, constraints kept.
{
  const picker = (draft = DEFAULT_SOLVER_DRAFT) => renderToStaticMarkup(createElement(SolverDirectionPicker, { draft, onDraftChange: () => undefined }))
  for (const direction of ['up', 'flat', 'down'] as const) {
    const markup = picker({ ...DEFAULT_SOLVER_DRAFT, direction })
    const buttons = markup.match(/<button[^>]*>/g) ?? []
    assert.equal(buttons.length, 3, 'three direction choices')
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.match(markup, new RegExp(`aria-pressed="true"[^>]*data-direction="${direction}"`), `${direction} selectable`)
    for (const arrow of ['↑', '→', '↓']) assert.ok(markup.includes(arrow))
    for (const word of ['上向き', '横ばい', '下向き']) assert.ok(markup.includes(word))
    assert.ok(markup.includes('✓'), 'selection marked by a check, not colour alone')
    const sizes = new Set(buttons.map((tag) => (tag.match(/class="([^"]*)"/)![1].match(/min-h-\[52px\]/) ? 'same' : 'diff')))
    assert.deepEqual([...sizes], ['same'], 'identical size for every direction')
  }
  const level = text(picker({ ...DEFAULT_SOLVER_DRAFT, kind: 'level' }))
  assert.ok(level.includes('基準日より高い') && level.includes('基準日と同じ') && level.includes('基準日より低い'))
  const reversal = text(picker({ ...DEFAULT_SOLVER_DRAFT, kind: 'reversal' }))
  assert.ok(reversal.includes('上向きへ転換') && reversal.includes('下向きへ転換'))

  const kinds = renderToStaticMarkup(createElement(SolverKindPicker, { draft: DEFAULT_SOLVER_DRAFT, onDraftChange: () => undefined }))
  for (const label of ['向きの転換 (符号反転)', '基準日との水準比較', '上級']) assert.ok(kinds.includes(label), `kind picker: ${label}`)
  assert.doesNotMatch(kinds, /<details[^>]* open/, 'beginner default keeps the advanced kinds closed')
  const open = renderToStaticMarkup(createElement(SolverKindPicker, { draft: { ...DEFAULT_SOLVER_DRAFT, kind: 'reversal' }, onDraftChange: () => undefined }))
  assert.match(open, /<details[^>]* open/, 'a selected advanced goal stays visible')
}

// ---------------------------------------------------------------------------
// 9. Rendered solver: current direction, steps, result order, all timeframes.
{
  const fixtures = buildSmaDynamicsFixtures()
  const render = (id: string, timeframe: string) => {
    const fixture = fixtures.find((item) => item.id === id)!
    return renderToStaticMarkup(createElement(SmaDynamicsView, {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows },
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: 'solver', timeframe: timeframe as never },
    }))
  }
  for (const id of ['jp-rising', 'us-falling', 'jp-sideways']) {
    for (const timeframe of SMA_LAB_TIMEFRAMES) {
      const markup = render(id, timeframe.id)
      const visible = text(markup)
      assert.match(markup, /data-sma-current-direction="(up|flat|down|unavailable)"/, `${id}/${timeframe.id}: current direction shown`)
      assert.ok(visible.includes('どの移動平均線？') && visible.includes('どの範囲で？') && visible.includes('どう動いてほしい？') && visible.includes('結果を見る'), `${id}/${timeframe.id}: 4-step flow`)
      assert.ok(visible.includes(timingLabel(timeframe.id, 1)), `${id}/${timeframe.id}: timing in the timeframe's words`)
      assert.ok(!visible.includes('T+3 = 3本先'), 'no fixed T+3 help while T+1 is selected')
      assert.match(markup, /data-sma-solver-directions/)
      assert.doesNotMatch(visible, /移動平均線を上向きにするには/)
      const order = ['data-solver-goal-title', 'data-solver-price-condition', 'SMAの変化', '代表的な経路'].map((needle) => markup.indexOf(needle))
      if (order.every((index) => index >= 0)) assert.deepEqual([...order].sort((a, b) => a - b), order, `${id}/${timeframe.id}: goal → price → SMA change → path`)
    }
  }
  const rising = render('jp-rising', '1D')
  assert.match(rising, /data-sma-current-direction="up"/, 'rising fixture: SMA5 currently up')
  assert.match(rising, /data-solver-direction-comparison/, 'three-direction comparison for a single-bar goal')
  assert.match(rising, /data-compare-direction="up"[\s\S]*data-compare-direction="flat"[\s\S]*data-compare-direction="down"/)
  const short = render('jp-short-history', '3M')
  assert.match(short, /data-sma-current-direction="unavailable"/, 'short history on 3M: explicit unavailable state')
  assert.ok(/現在の向きは判定できません|計算できません/.test(text(short)))
  for (const mode of ['freeze', 'scenario'] as const) {
    const fixture = fixtures.find((item) => item.id === 'jp-rising')!
    const markup = renderToStaticMarkup(createElement(SmaDynamicsView, {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows },
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: mode },
    }))
    assert.doesNotMatch(markup, /data-sma-current-direction|data-sma-solver-directions/, `${mode}: solver controls stay out of other modes`)
  }
}

// ---------------------------------------------------------------------------
// 9b. Reversal entry, step-3 hint, single-bar level wording.
{
  const D = DEFAULT_SOLVER_DRAFT
  const enter = (to: 'up' | 'down', current: SmaDirection | null) => applySolverDraftPatch({ ...D, to }, { kind: 'reversal' }, current)
  assert.equal(enter('up', 'up').to, 'down', 'current up: target down')
  assert.equal(enter('down', 'down').to, 'up', 'current down: target up')
  assert.equal(enter('up', 'flat').to, 'up', 'flat: no invented direction, selection kept')
  assert.equal(enter('down', 'flat').to, 'down')
  assert.equal(enter('down', null).to, 'down', 'unavailable: selection kept')
  // Not repeatedly overwritten: unrelated updates and re-clicking reversal keep the user's choice.
  const inReversal = { ...D, kind: 'reversal' as const, to: 'up' as const }
  assert.equal(applySolverDraftPatch(inReversal, { within: 5 }, 'up').to, 'up')
  assert.equal(applySolverDraftPatch(inReversal, { kind: 'reversal' }, 'up').to, 'up')
  assert.equal(applySolverDraftPatch(inReversal, { period: 5 }, 'up').to, 'up')
  assert.equal(applySolverDraftPatch(D, { kind: 'reversal', to: 'up' }, 'up').to, 'up', 'explicit to wins')
  // The entered default is a real condition, not a precondition failure.
  const upB = base([10, 11, 12, 13, 14, 15]), downB = base([15, 14, 13, 12, 11, 10])
  for (const [b, cur] of [[upB, 'up'], [downB, 'down']] as const) {
    const to = enter('up', cur).to
    assert.equal(analyzeSolverGoal(b, { kind: 'reversal', period: 3, within: 3, to }).status, 'feasible', `${cur}: reversal entry is solvable`)
  }
  assert.notEqual(solverDirectionHint('reversal'), '3つは対等です')
  assert.match(solverDirectionHint('reversal'), /2択/)
  for (const kind of ['direction', 'maintain', 'level'] as const) assert.equal(solverDirectionHint(kind), '3つは対等です')

  const one = analyzeSolverGoal(upB, { kind: 'level', period: 3, bar: 1, relation: 'up' })
  assert.equal(one.sum?.count, 1)
  const oneText = uniquenessText(one, '1D')
  assert.doesNotMatch(oneText, /〜|平均|配分/, 'single bar: no range, mean or allocation wording')
  assert.match(oneText, /終値だけが条件/)
  const many = analyzeSolverGoal(upB, { kind: 'level', period: 3, bar: 3, relation: 'up' })
  assert.match(uniquenessText(many, '1D'), /〜.*平均.*配分/, 'multi-bar keeps mean/allocation wording')
}

// ---------------------------------------------------------------------------
// 10. Names
{
  assert.equal(smaLineName(5, '1D'), '5日線')
  assert.equal(smaLineName(25, '1W'), '週足SMA25')
  assert.equal(smaLineName(75, '3M'), '四半期足SMA75')
}

console.log('SMA Dynamics Phase 2.2 solver UX tests passed.')
