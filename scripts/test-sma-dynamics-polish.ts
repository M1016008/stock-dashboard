// SMA Dynamics Lab Phase 2.3 final polish: N=1 equivalence copy, exact SMA delta formula,
// mode-aware header copy. Fixture/synthetic only; no network.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSmaDynamicsFixtures, findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import { computeSmaLab, priceFreezePath, type SmaLabAvailable } from '@/lib/sma-dynamics-lab'
import { analyzeSolverGoal, anchorDirection, checkGoal, DEFAULT_SOLVER_DRAFT, forwardBase, PATH_ASSUMPTIONS, representativePath, type ForwardBase, type SolverGoal } from '@/lib/sma-dynamics-scenario'
import { SolverConclusion, SolverDetails, type SolverViewModel } from '@/components/stock/sma-dynamics/SmaSolverPanel'
import { exactFormatter } from '@/components/stock/sma-dynamics/SmaSimulationParts'
import { priceFormatter } from '@/components/stock/sma-dynamics/SmaDynamicsPanels'
import {
  conditionStructureText,
  firstHitMarker,
  pathDependencyRule,
  readingNotes,
  scopeGlossary,
  solverInsight,
  SMA_DELTA_BEGINNER,
  SMA_DELTA_FORMULA,
} from '@/lib/sma-dynamics-insight'
import {
  describeRepresentativeHit,
  goalCondition,
  goalKindTag,
  goalTitle,
  priceCondition,
  scopeHelp,
  singleBarScopeNote,
  withinExplanation,
  type WordingContext,
} from '@/lib/sma-dynamics-solver-copy'
import {
  SMA_ANCHOR_CLOSE_LABEL,
  SMA_DYNAMICS_DEFAULT_SETTINGS,
  SMA_MODE_SUBTITLE,
  SmaDynamicsView,
  SolverChartCaption,
  type SmaDynamicsSettings,
} from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'
import { SolverScopePicker } from '@/components/stock/sma-dynamics/SmaSolverSteps'

const exact = (value: number | null | undefined) => (value == null ? '—' : String(Number(value.toFixed(6))))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const base = (closes: number[], horizon = 8): ForwardBase => ({ confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose: closes.at(-1)!, horizon })
const UP = base([10, 11, 12, 13, 14, 15])
const ctx = (b: ForwardBase): WordingContext => ({ timeframe: '1D', current: anchorDirection(b, 3)?.direction ?? null, unit: '円', exact })
const exactN = (n: number): SolverGoal => ({ kind: 'direction', period: 3, bar: n, direction: 'up' })
const within = (n: number): SolverGoal => ({ kind: 'within', period: 3, within: n, direction: 'up' })
const through = (n: number): SolverGoal => ({ kind: 'maintain', period: 3, through: n, direction: 'up' })

const NOTE = '対象は次の1営業日だけです。この日に条件を満たせば成立します。'
const MISLEADING = /外れ|のちに|あとで|その後|最後の足|最短|最も早|一度でも|ずっと|別の条件|とは限りません|保証/

// ---------------------------------------------------------------------------
// 1. N=1: exact / within / maintain collapse to one single-bar question.
{
  assert.equal(singleBarScopeNote('1D'), NOTE)
  const expectedUnit = {
    '1D': '営業日', '2D': '本', '3D': '本', '5D': '本', '1W': '週', '2W': '本', '3W': '本',
    '1M': 'か月', '2M': '本', '3M': '本', '6M': '本', '1Y': '年', '2Y': '本', '3Y': '本', '5Y': '本',
  } as const
  for (const tf of SMA_LAB_TIMEFRAMES) {
    const note = singleBarScopeNote(tf.id)
    if (tf.id === '1D') assert.equal(note, NOTE)
    else {
      assert.equal(note, `対象は次の1${expectedUnit[tf.id]}だけです。この足で条件を満たせば成立します。`, tf.id)
      assert.doesNotMatch(note, /この足に/, `${tf.id}: natural particle`)
      assert.doesNotMatch(note, /この日/, `${tf.id}: no day wording`)
    }
    assert.equal(scopeHelp('within', tf.id, 1), note, `${tf.id}: scope help`)
    assert.ok(withinExplanation(tf.id, 1).startsWith(note), `${tf.id}: within explanation`)
  }
  assert.equal(SMA_LAB_TIMEFRAMES.length, 15)
  assert.equal(SMA_LAB_TIMEFRAMES.filter((tf) => tf.core).length, 8, 'the eight specified timeframes stay the core set')
  const c = ctx(UP)

  // Price condition and title are identical in meaning across the three scopes.
  const conds = [exactN(1), within(1), through(1)].map((goal) => priceCondition(analyzeSolverGoal(UP, goal), c))
  assert.equal(conds[1].headline, conds[0].headline)
  assert.equal(conds[2].headline, conds[0].headline)
  assert.equal(conds[1].kind, 'one')
  assert.deepEqual(conds[1].lines, conds[0].lines)
  assert.equal(goalTitle(within(1), c), goalTitle(through(1), c))
  assert.doesNotMatch(goalTitle(within(1), c), /一度でも|以内/)
  assert.doesNotMatch(goalCondition(within(1), c), /一度でも|以内/)
  assert.doesNotMatch(goalCondition(through(1), c), /ずっと|今後/)

  // Scope help, within explanation, structure sentence, glossary.
  assert.equal(scopeHelp('within', '1D', 1), NOTE)
  assert.equal(scopeHelp('maintain', '1D', 1), NOTE)
  assert.match(scopeHelp('within', '1D', 2), /あとで向きが崩れても一度到達していれば成立/)
  assert.ok(withinExplanation('1D', 1).startsWith(NOTE))
  assert.doesNotMatch(withinExplanation('1D', 1), MISLEADING)
  for (const goal of [within(1), through(1)]) {
    const structure = conditionStructureText(analyzeSolverGoal(UP, goal), '1D')
    assert.ok(structure.startsWith(NOTE), structure)
    assert.doesNotMatch(structure, MISLEADING)
    assert.doesNotMatch(structure, /論理和|論理積/)
    const glossary = scopeGlossary(goal, '1D')
    for (const id of ['within', 'maintain'] as const) {
      const item = glossary.find((entry) => entry.id === id)!
      assert.ok(item.definition.startsWith(NOTE), item.definition)
      assert.doesNotMatch(item.definition, /とは限りません|外れても/)
    }
  }
  assert.match(readingNotes(analyzeSolverGoal(UP, within(2))).join(''), /どの足が起こりやすいか/)
  assert.doesNotMatch(readingNotes(analyzeSolverGoal(UP, within(1))).join(''), /どの足が起こりやすいか/)

  // Representative hit and Layer-1 sentence carry no aftermath language at N=1.
  const goal = within(1)
  const analysis = analyzeSolverGoal(UP, goal)
  const check = checkGoal(UP, goal, [20])
  assert.equal(check.hitK, 1)
  const hit = describeRepresentativeHit({ goal, check, ctx: c, futureBars: undefined, smaAtHit: 13, closeAtHit: 20, fmt: exact, retained: null })!
  const hitText = [hit.headline, ...hit.lines].join(' ')
  assert.match(hitText, /次の営業日.*初めて/)
  assert.ok(hitText.includes(NOTE))
  assert.doesNotMatch(hitText, /外れ|のちに|あとで|その後|最後の足|最短|最も早|別の条件|とは限りません|保証|ではなくなり|T\+1 の時点では/)

  const steps = [{ k: 1, incoming: 20, sma: 13, outgoing: 12, delta: 1, direction: 'up', displayFlat: false, levelChange: 1 }] as never
  const marker = firstHitMarker({ goal, check, steps, closes: [20], ctx: c, futureBars: undefined, currentDirection: 'up', retained: null, fmt: exact })!
  assert.ok(marker.lines.includes(NOTE))
  assert.doesNotMatch(marker.lines.join(' '), /最後の足|すべての経路|最も早い|最短/)
  const insight = solverInsight({ analysis, ctx: c, check, hit: marker, steps, futureBars: undefined, fmt: exact, closes: [20], anchorClose: 15 })
  assert.ok(insight.sentence.includes(NOTE))
  assert.doesNotMatch(insight.sentence, /その後|最後の足|再び|外れ|のちに/)

  // Maintain N=1 insight sentence.
  const mAnalysis = analyzeSolverGoal(UP, through(1))
  const mInsight = solverInsight({ analysis: mAnalysis, ctx: c, check: null, hit: null, steps: null, futureBars: undefined, fmt: exact })
  assert.ok(mInsight.sentence.includes(NOTE))
  assert.doesNotMatch(mInsight.sentence, /今後1|すべての足/)

  // Rendered scope help.
  const picker = text(renderToStaticMarkup(createElement(SolverScopePicker, { timeframe: '1D', kind: 'within', n: 1, onPick: () => undefined })))
  assert.ok(picker.includes(NOTE))
}

// ---------------------------------------------------------------------------
// 2. N>=2 keeps the differentiated wording.
{
  const c = ctx(UP)
  assert.match(goalTitle(within(2), c), /2営業日以内に一度でも/)
  assert.match(goalTitle(through(2), c), /今後2営業日、すべての足/)
  const w = conditionStructureText(analyzeSolverGoal(UP, within(2)), '1D')
  assert.match(w, /論理和・OR/)
  assert.match(w, /到達後に外れても成立は変わりません/)
  assert.match(conditionStructureText(analyzeSolverGoal(UP, through(2)), '1D'), /論理積・AND/)
  const glossary = scopeGlossary(within(3), '1D')
  assert.match(glossary.find((g) => g.id === 'within')!.definition, /到達後に外れても成立のまま/)
  assert.match(glossary.find((g) => g.id === 'maintain')!.definition, /1本でも外れれば不成立/)
  assert.match(withinExplanation('1D', 3), /あとで向きが崩れても、一度到達していれば成立/)
  assert.notEqual(priceCondition(analyzeSolverGoal(UP, within(2)), c).kind, 'one')

  const goal = within(3)
  const check = checkGoal(UP, goal, [20, 10, 9])
  const hit = describeRepresentativeHit({ goal, check, ctx: c, futureBars: undefined, smaAtHit: null, closeAtHit: null, fmt: exact, retained: null })!
  assert.match(hit.lines.join(' '), /成立のままです/)
  assert.match(hit.lines.join(' '), /別の条件です/)

  // Reversal and level are never merged into the N=1 equivalence.
  const rev: SolverGoal = { kind: 'reversal', period: 3, within: 1, to: 'down' }
  assert.match(goalTitle(rev, c), /転換/)
  assert.doesNotMatch(conditionStructureText(analyzeSolverGoal(UP, rev), '1D'), /^対象は次の1営業日だけです/)
  assert.match(goalTitle({ kind: 'level', period: 3, bar: 1, relation: 'up' }, c), /基準日の/)
}

// ---------------------------------------------------------------------------
// 3. Exact SMA delta formula and beginner explanation; k<=N vs k>N distinction intact.
{
  assert.equal(SMA_DELTA_FORMULA, 'SMA_N(T+k) − SMA_N(T+k−1) = [P(T+k) − P(T+k−N)] / N')
  assert.equal(SMA_DELTA_BEGINNER, '移動平均線は、新しく加わる株価と、計算から外れる古い株価の差によって動きます。')
  const rule = pathDependencyRule(5, '1D')
  assert.ok(rule.startsWith(SMA_DELTA_FORMULA))
  assert.match(rule, /N はSMAの窓の本数/)
  assert.match(rule, /P は選んだ時間軸の確定終値/)
  assert.match(rule, /k は基準足\(T\)から数えた足の本数/)
  assert.doesNotMatch(rule, /基準日\(T\)/)
  assert.match(rule, /k ≤ 5 の間、窓から抜ける P\(T\+k−5\) は確定済みの過去終値/)
  assert.match(rule, /k > 5 \(6営業日後以降\)/)
  assert.match(rule, /固定の境界価格は存在せず/)
  assert.doesNotMatch(rule, /SMAの変化 \(T\+k\)|÷/)
  assert.match(pathDependencyRule(3, '1W'), /k > 3 \(4週後以降\)/)
}

// ---------------------------------------------------------------------------
// 4. Mode-aware header copy, shared price label, mode sync (static render of each mode).
{
  assert.deepEqual(SMA_MODE_SUBTITLE, {
    freeze: '株価が今のままなら、移動平均線はどう動く？',
    scenario: 'これからの株価を自由に変えて、移動平均線の動きを確かめよう',
    solver: '移動平均線を希望する向きにするための株価条件を調べよう',
  })
  assert.equal(SMA_ANCHOR_CLOSE_LABEL, '基準日の終値')
  const fixture = findSmaDynamicsFixture('jp-rising')!
  const render = (analysis: SmaDynamicsSettings['analysis']) => renderToStaticMarkup(createElement(SmaDynamicsView, {
    security: { market: 'JP', ticker: 'FXJ1', name: '合成' },
    analysisDate: null,
    load: { status: 'ready', rows: fixture.rows },
    dataSource: { label: 'テスト', priceBasis: '合成データ' },
    initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis },
  }))
  const premiseOf = (markup: string) => /data-sma-dynamics-premise="true" data-mode="(\w+)"/.exec(markup)?.[1]
  for (const mode of ['freeze', 'scenario', 'solver'] as const) {
    const markup = render(mode)
    const visible = text(markup)
    assert.match(markup, new RegExp(`data-sma-dynamics-subtitle="true" data-mode="${mode}"`))
    assert.ok(visible.includes(SMA_MODE_SUBTITLE[mode]), `${mode}: subtitle`)
    for (const other of (['freeze', 'scenario', 'solver'] as const).filter((m) => m !== mode)) assert.ok(!visible.includes(SMA_MODE_SUBTITLE[other]), `${mode}: no ${other} subtitle`)
    assert.match(visible, /基準日 \d{4}-\d{2}-\d{2} ・ 基準日の終値 /, `${mode}: shared price label`)
    assert.ok(!visible.includes('固定終値'), `${mode}: no 固定終値 anywhere`)
    assert.equal(premiseOf(markup), mode, `${mode}: premise synced`)
    assert.match(markup, new RegExp(`data-sma-steps="${mode}"`))
  }
  const pressed = (markup: string) => /aria-pressed="true"[^>]*data-mode="(\w+)"|data-mode="(\w+)"[^>]*aria-pressed="true"/.exec(markup)
  for (const mode of ['freeze', 'scenario', 'solver'] as const) {
    const m = pressed(render(mode))!
    assert.equal(m[1] ?? m[2], mode, `${mode}: selected purpose`)
  }
  // Solver-specific price wording stays out of the header; scenario/solver terms live in their panels.
  assert.match(text(render('scenario')), /仮定/)
  assert.match(text(render('solver')), /仮定した終値|条件を満たす/)
}

// ---------------------------------------------------------------------------
// 5. Rendered components: N=1 has no first/earliest/within-N wording; N>=2 and reversal keep it.
{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 20, analysisDate: fixture.analysisDate }) as SmaLabAvailable
  const fb = forwardBase(result)
  const fmt = priceFormatter(1)
  const fmtExact = exactFormatter(1)
  const noop = () => undefined
  const FORBIDDEN = /全経路で最も早い|最初に到達する足|N本以内に一度でも|N本ずっと|1営業日以内に一度でも|今後1営業日/
  const render = (goal: SolverGoal) => {
    const analysis = analyzeSolverGoal(fb, goal)
    const paths = Object.fromEntries(PATH_ASSUMPTIONS.map((item) => [item.id, representativePath(fb, analysis, item.id, 0.1)])) as SolverViewModel['paths']
    const model: SolverViewModel = { goal, analysis, paths, scenarioCheck: null, freezeCheck: checkGoal(fb, goal, priceFreezePath(fb.anchorClose, fb.horizon)), comparison: null }
    const draft = { ...DEFAULT_SOLVER_DRAFT, assumption: 'hold' as const }
    const conclusion = renderToStaticMarkup(createElement(SolverConclusion, { result, base: fb, model, draft, fmt, exact: fmtExact, market: 'JP' }))
    const details = renderToStaticMarkup(createElement(SolverDetails, { result, base: fb, model, draft, fmt, exact: fmtExact, market: 'JP', onDraftChange: noop, onCopyToScenario: noop }))
    const caption = renderToStaticMarkup(createElement(SolverChartCaption, { model, boundaries: [], wording: { timeframe: '1D', current: analysis.anchorDirection?.direction ?? null, unit: '円', exact: fmtExact }, hasHighlight: true }))
    return { conclusion, details, caption }
  }
  for (const direction of ['up', 'down'] as const) {
    for (const goal of [
      { kind: 'within', period: 5, within: 1, direction },
      { kind: 'maintain', period: 5, through: 1, direction },
    ] as SolverGoal[]) {
      const r = render(goal)
      for (const [label, markup] of Object.entries(r)) {
        const visible = text(markup)
        assert.doesNotMatch(visible, FORBIDDEN, `${goal.kind} ${direction} ${label}`)
      }
      assert.match(r.conclusion, /data-solver-kind-tag="(within|maintain)"[^>]*>次の1本だけ</, 'kind badge')
      assert.ok(text(r.details).includes('次の1本だけ'), 'details tag')
      assert.doesNotMatch(r.conclusion, /data-solver-hit-scope/)
      assert.ok(text(r.caption).includes('◎ = 次の1本で条件を確認する地点です。ホバー・フォーカス・タップで日付、仮定終値、SMA、向きを表示します。'))
      assert.ok(text(r.conclusion).includes(NOTE), 'single-bar note present')
    }
  }
  const w = render({ kind: 'within', period: 5, within: 5, direction: 'down' })
  assert.match(w.conclusion, /data-solver-hit-scope/)
  assert.match(text(w.conclusion), /全経路で最も早い到達ではありません/)
  assert.match(text(w.caption), /最初に到達する足です/)
  assert.match(text(w.caption), /全経路で最も早い足ではありません/)
  assert.match(w.conclusion, /data-solver-kind-tag="within"[^>]*>N本以内に一度でも</)
  assert.match(text(w.details), /N本以内に一度でも/)
  const m = render({ kind: 'maintain', period: 5, through: 5, direction: 'up' })
  assert.match(m.conclusion, /data-solver-kind-tag="maintain"[^>]*>N本ずっと</)
  const rev = render({ kind: 'reversal', period: 5, within: 1, to: 'down' })
  assert.match(text(rev.caption), /転換する足です/)
  assert.match(text(rev.conclusion), /向きの転換/)
  assert.equal(goalKindTag({ kind: 'direction', period: 5, bar: 1, direction: 'up' }), 'N本後の時点だけ')
}

console.log('sma-dynamics polish: ok')
