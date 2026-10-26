// SMA Dynamics Lab Phase 2.3: direction scopes (exact N / within N / throughout N), the reversal
// event with a flat bridge, 20-bar horizons on every timeframe. Deterministic, fixture/synthetic only.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSmaDynamicsFixtures } from '@/lib/sma-dynamics-fixtures'
import { buildSmaLabChartModel } from '@/lib/sma-dynamics-chart-model'
import { computeSmaLab, priceFreezePath, SMA_LAB_PERIODS, smaLabHorizonOptions, smaLabMaxHorizonBars, SMA_LAB_SOLVER_MAX_BARS, type SmaLabAvailable } from '@/lib/sma-dynamics-lab'
import {
  analyzeSolverGoal,
  anchorDirection,
  applySolverDraftPatch,
  checkGoal,
  DEFAULT_SOLVER_DRAFT,
  firstReversal,
  forwardBase,
  goalBars,
  goalFromDraft,
  priceDomain,
  representativePath,
  retainedDirection,
  PATH_ASSUMPTIONS,
  type ForwardBase,
  type PriceConstraints,
  type SmaDirection,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import {
  describeRepresentativeHit,
  goalCondition,
  goalTitle,
  priceCondition,
  REPRESENTATIVE_HIT_NOTE,
  REVERSAL_DEFINITION,
  SOLVER_QUICK_TIMINGS,
  solverBoundaries,
  type WordingContext,
} from '@/lib/sma-dynamics-solver-copy'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, SmaDynamicsView } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { SolverDirectionPicker, SolverKindPicker, SolverScopePicker, SolverTimingPicker } from '@/components/stock/sma-dynamics/SmaSolverSteps'
import { SolverConclusion, SolverDetails, type SolverViewModel } from '@/components/stock/sma-dynamics/SmaSolverPanel'
import { exactFormatter } from '@/components/stock/sma-dynamics/SmaSimulationParts'
import { priceFormatter } from '@/components/stock/sma-dynamics/SmaDynamicsPanels'

const exact = (value: number | null | undefined) => (value == null ? '—' : String(Number(value.toFixed(6))))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const noop = () => undefined

function base(closes: number[], horizon = 8): ForwardBase {
  return { confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose: closes.at(-1)!, horizon }
}
const ctx = (b: ForwardBase): WordingContext => ({ timeframe: '1D', current: anchorDirection(b, 3)?.direction ?? null, unit: '円', exact })

// Up-trending history: SMA3 slope is up. Leaving closes for T+1..T+3 are 13, 14, 15.
const UP = base([10, 11, 12, 13, 14, 15])
const DOWN = base([15, 14, 13, 12, 11, 10])
const within = (n: number, direction: SmaDirection, period: 3 = 3): SolverGoal => ({ kind: 'within', period, within: n, direction })
const exactN = (n: number, direction: SmaDirection): SolverGoal => ({ kind: 'direction', period: 3, bar: n, direction })
const through = (n: number, direction: SmaDirection): SolverGoal => ({ kind: 'maintain', period: 3, through: n, direction })
const reversal = (n: number, turn: 'up' | 'down'): SolverGoal => ({ kind: 'reversal', period: 3, within: n, to: turn });

// ---------------------------------------------------------------------------
// 1. Exact N, within N, throughout N are three different questions on the same path.
{
  const b = base([10, 11, 12, 13, 14, 15], 5)
  // Slopes on this path (out = 13, 14, 15, x1, x2): down, down, up, flat, down.
  const hit3 = [10, 10, 16, 10, 9]
  const slopes = checkGoal(b, within(5, 'up'), hit3).directions
  assert.deepEqual(slopes, ['down', 'down', 'up', 'flat', 'down'])
  // hit at T+3 but not still true at T+5
  const w = checkGoal(b, within(5, 'up'), hit3)
  assert.equal(w.satisfied, true)
  assert.equal(w.hitK, 3, 'first hit of this path is T+3')
  assert.equal(w.aftermath?.holdsAtEnd, false, 'not true at T+5')
  assert.equal(w.aftermath?.heldThrough, false)
  assert.equal(w.aftermath?.lostK, 4, 'lost at T+4')
  assert.equal(w.aftermath?.lostTo, 'flat')
  assert.equal(w.aftermath?.oppositeK, 5, 'later reversed to down at T+5')
  assert.equal(checkGoal(b, exactN(5, 'up'), hit3).satisfied, false, 'exact N=5 differs from within 5')
  assert.equal(checkGoal(b, exactN(3, 'up'), hit3).satisfied, true)
  assert.equal(checkGoal(b, through(5, 'up'), hit3).satisfied, false)
  assert.equal(checkGoal(b, within(2, 'up'), hit3).satisfied, false, 'within 2 does not reach T+3')
  assert.equal(checkGoal(b, within(2, 'up'), hit3).hitK, null)

  // hit only at T+5 (x4 = x1, x5 > x2)
  const only5 = [10, 10, 10, 10, 11]
  assert.deepEqual(checkGoal(b, within(5, 'up'), only5).directions, ['down', 'down', 'down', 'flat', 'up'])
  const c5 = checkGoal(b, within(5, 'up'), only5)
  assert.equal(c5.hitK, 5)
  assert.equal(c5.aftermath?.holdsAtEnd, true)
  assert.equal(c5.aftermath?.heldThrough, true, 'single trailing bar')
  assert.equal(checkGoal(b, within(4, 'up'), only5).satisfied, false)
  assert.equal(checkGoal(b, exactN(5, 'up'), only5).satisfied, true)

  // hit at T+1, then lost
  const first = [14, 14, 14, 14, 14]
  const c1 = checkGoal(b, within(3, 'up'), first)
  assert.deepEqual(c1.directions, ['up', 'flat', 'down'])
  assert.equal(c1.hitK, 1)
  assert.equal(c1.aftermath?.lostK, 2)
  assert.equal(c1.aftermath?.oppositeK, 3)
  assert.equal(c1.aftermath?.holdsAtEnd, false)
  assert.equal(checkGoal(b, exactN(3, 'up'), first).satisfied, false, 'exact vs within: same path, different answer')
  assert.equal(checkGoal(b, within(3, 'up'), first).satisfied, true)
  assert.equal(checkGoal(b, through(3, 'up'), first).satisfied, false)

  // throughout: every bar must match
  const rising = [16, 17, 18, 19, 20]
  assert.equal(checkGoal(b, through(5, 'up'), rising).satisfied, true)
  assert.equal(checkGoal(b, through(5, 'up'), [16, 17, 18, 19, 14]).satisfied, false)
  assert.deepEqual(checkGoal(b, through(5, 'up'), [16, 17, 18, 19, 14]).failedK, [5])
  assert.equal(checkGoal(b, within(5, 'up'), [16, 17, 18, 19, 14]).satisfied, true)

  // never hit: a path that stays down; and a bound that excludes the target on every bar of N
  assert.equal(checkGoal(b, within(3, 'up'), [10, 10, 10]).satisfied, false)
  assert.equal(checkGoal(b, within(3, 'up'), [10, 10, 10]).hitK, null)
  const capped = analyzeSolverGoal(b, within(3, 'up'), { min: null, max: 12, tick: null })
  assert.equal(capped.status, 'infeasible')
  assert.equal(capped.issue, 'bound_excludes_threshold')
  // five bars: T+4/T+5 compare with assumed closes, so two prices inside the bound are enough
  assert.equal(analyzeSolverGoal(b, within(5, 'up'), { min: null, max: 12, tick: null }).status, 'feasible')
  assert.equal(analyzeSolverGoal(b, within(5, 'up'), { min: 10, max: 10, tick: 1 }).status, 'infeasible', 'one admissible price: no strict rise')
}

// ---------------------------------------------------------------------------
// 2. T+0 never counts; "currently already the target" is not a hit.
{
  const b = base([10, 11, 12, 13, 14, 15], 5)
  const a = analyzeSolverGoal(b, within(3, 'up'))
  assert.equal(a.anchorDirection?.direction, 'up')
  assert.equal(a.currentlyTarget, true)
  assert.equal(checkGoal(b, within(3, 'up'), [10, 10, 10]).satisfied, false, 'already up at T+0 but T+1..T+3 never up')
  assert.equal(analyzeSolverGoal(b, within(3, 'down')).currentlyTarget, false)
  assert.equal(analyzeSolverGoal(b, within(1, 'up')).primary?.k, 1)
  // within 1 is exact 1
  for (const closes of [[10], [14], [13], [20]]) {
    for (const d of ['up', 'flat', 'down'] as const) {
      assert.equal(checkGoal(b, within(1, d), closes).satisfied, checkGoal(b, exactN(1, d), closes).satisfied)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Reversal: a sign change through a neutral flat bridge, not "target reached".
{
  const b = base([10, 11, 12, 13, 14, 15], 6)
  assert.deepEqual(retainedDirection(b, 3), { state: 'known', direction: 'up' })
  // remaining up is NOT an up reversal
  assert.equal(checkGoal(b, reversal(3, 'up'), [16, 17, 18]).satisfied, false)
  assert.equal(checkGoal(b, reversal(3, 'up'), [16, 17, 18]).hitK, null)
  // but it is a within-up hit
  assert.equal(checkGoal(b, within(3, 'up'), [16, 17, 18]).hitK, 1)
  // up -> down is a down reversal
  assert.equal(checkGoal(b, reversal(3, 'down'), [10, 10, 10]).hitK, 1)
  // up -> flat -> flat -> down: the flats are a bridge
  assert.deepEqual(checkGoal(b, reversal(3, 'down'), [13, 14, 14]).directions, ['flat', 'flat', 'down'])
  assert.equal(checkGoal(b, reversal(3, 'down'), [13, 14, 14]).hitK, 3)
  // up -> down -> up : the later up is a real reversal (T+1 up, T+2 down, T+3 up)
  assert.deepEqual(checkGoal(b, reversal(3, 'up'), [14, 13, 16]).directions, ['up', 'down', 'up'])
  assert.equal(checkGoal(b, reversal(3, 'up'), [14, 13, 16]).hitK, 3)
  // up -> down -> flat -> up : bridged
  const bridged = checkGoal(b, reversal(4, 'up'), [14, 13, 15, 15])
  assert.deepEqual(bridged.directions, ['up', 'down', 'flat', 'up'])
  assert.equal(bridged.hitK, 4)
  // flat in between does not turn "up, flat, up" into a reversal
  assert.equal(checkGoal(b, reversal(3, 'up'), [14, 14, 16]).satisfied, false)
  // history: last non-flat before a flat anchor is looked up
  const flatNow = base([20, 18, 16, 16, 17, 16], 4)
  assert.deepEqual(retainedDirection(flatNow, 3), { state: 'known', direction: 'down' })
  assert.equal(analyzeSolverGoal(flatNow, reversal(1, 'up')).status, 'feasible', 'retained down: one up bar is the reversal')
  // never any non-flat slope: no retained direction, so an opposite bar must come first
  const allFlat = base([10, 10, 10, 10, 10, 10], 4)
  assert.deepEqual(retainedDirection(allFlat, 3), { state: 'known', direction: null })
  assert.equal(analyzeSolverGoal(allFlat, reversal(1, 'up')).issue, 'reversal_needs_two_bars')
  assert.equal(analyzeSolverGoal(allFlat, reversal(2, 'up')).status, 'feasible')
  assert.equal(checkGoal(allFlat, reversal(2, 'up'), [11, 12]).satisfied, false, 'first non-flat has no prior direction')
  assert.equal(checkGoal(allFlat, reversal(2, 'up'), [9, 12]).satisfied, true)
  // both directions are available from a down trend too
  assert.equal(analyzeSolverGoal(DOWN, reversal(1, 'up')).status, 'feasible')
  assert.equal(analyzeSolverGoal(DOWN, reversal(1, 'down')).issue, 'reversal_needs_two_bars')
  assert.equal(analyzeSolverGoal(DOWN, reversal(2, 'down')).sequencePlan?.firstK, 1)
  assert.equal(analyzeSolverGoal(UP, reversal(1, 'down')).status, 'feasible')
  assert.equal(analyzeSolverGoal(UP, reversal(1, 'down')).combinator, 'any')
  assert.equal(analyzeSolverGoal(UP, reversal(3, 'up')).combinator, 'sequence')
  // unknown history is never guessed
  assert.equal(analyzeSolverGoal(base([10, 11, 12], 4), reversal(2, 'up')).status, 'unavailable')
  assert.equal(analyzeSolverGoal(base([10, 11, 12], 4), reversal(2, 'up')).issue, 'anchor_direction_unknown')
  assert.deepEqual(retainedDirection(base([10, 11, 12], 4), 3), { state: 'unknown' })
  assert.deepEqual(retainedDirection(base([10, 11, 12, 13], 4), 3), { state: 'known', direction: 'up' })
  // pure scan
  assert.deepEqual(firstReversal(['flat', 'down', 'flat', 'up'], 'up', 'up'), { hitK: 4, complete: true })
  assert.deepEqual(firstReversal(['up', 'up'], 'up', 'up'), { hitK: null, complete: true })
  assert.deepEqual(firstReversal(['flat', null, 'up'], 'up', 'down'), { hitK: null, complete: false })
}

// ---------------------------------------------------------------------------
// 4. Analysis agrees with exhaustive search (feasible exactly when some admissible path satisfies the goal).
{
  let seed = 20260101
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const statuses = new Set<string>()
  let cases = 0
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const period = 3
    const length = 6 + Math.floor(rnd() * 4)
    const confirmed = Array.from({ length }, () => 1 + Math.floor(rnd() * 4))
    const horizon = 5
    const lo = 1 + Math.floor(rnd() * 2)
    const hi = lo + Math.floor(rnd() * 3)
    const constraints: PriceConstraints = { min: lo, max: hi, tick: 1 }
    const fb: ForwardBase = { confirmedCloses: confirmed, anchorIndex: length - 1, anchorClose: confirmed[length - 1], horizon }
    const values: number[] = []
    for (let v = lo; v <= hi; v += 1) values.push(v)
    let paths: number[][] = [[]]
    for (let i = 0; i < horizon; i += 1) paths = paths.flatMap((p) => values.map((v) => [...p, v]))
    const goals: SolverGoal[] = []
    for (const d of ['up', 'flat', 'down'] as const) {
      for (let n = 1; n <= horizon; n += 1) goals.push(exactN(n, d), within(n, d), through(n, d), { kind: 'level', period, bar: n, relation: d })
    }
    for (const to of ['up', 'down'] as const) for (let n = 1; n <= horizon; n += 1) goals.push(reversal(n, to))
    const domain = priceDomain(constraints)
    for (const goal of goals) {
      const analysis = analyzeSolverGoal(fb, goal, constraints)
      statuses.add(analysis.status)
      const exists = paths.some((path) => {
        const check = checkGoal(fb, goal, path, domain)
        return check.satisfied && check.inDomain
      })
      cases += 1
      assert.equal(analysis.status === 'feasible', exists, `exhaustive agreement: ${JSON.stringify({ goal, confirmed, constraints })} -> ${analysis.status}/${analysis.issue}`)
    }
  }
  assert.ok(cases > 8000)
  // closed-form analysis never reports an inconclusive state, so "infeasible" is always a proof, never a cutoff
  assert.deepEqual([...statuses].sort(), ['feasible', 'infeasible'])
}

// ---------------------------------------------------------------------------
// 5. Representative paths: hit bar, SMA value at the hit, and no claim of global earliest.
{
  const b = base([10, 11, 12, 13, 14, 15], 8)
  for (const goal of [within(5, 'up'), within(5, 'down'), within(5, 'flat'), reversal(5, 'up'), reversal(5, 'down'), reversal(1, 'down'), through(5, 'down'), exactN(5, 'up')]) {
    const analysis = analyzeSolverGoal(b, goal)
    assert.equal(analysis.status, 'feasible', JSON.stringify(goal))
    for (const item of PATH_ASSUMPTIONS) {
      const path = representativePath(b, analysis, item.id, 0.1)
      if (path.status !== 'found') continue
      assert.equal(path.check?.satisfied, true, `${item.id} ${JSON.stringify(goal)}`)
      if (goal.kind === 'within' || goal.kind === 'reversal') {
        const hit = path.check!.hitK
        assert.ok(hit != null && hit >= 1 && hit <= goalBars(goal))
        // nothing before the reported bar already matched on this path
        if (goal.kind === 'within') assert.ok(path.check!.directions.slice(0, hit - 1).every((d) => d !== goal.direction))
      }
    }
    assert.equal(representativePath(b, analysis, 'hold', 0.1).status, 'found', `hold path exists for ${JSON.stringify(goal)}`)
  }
  // a sequence reversal needs two moved bars; the example hits at the target bar, after an opposite bar
  const seq = representativePath(b, analyzeSolverGoal(b, reversal(3, 'up')), 'hold', 0.1)
  const dirs = seq.check!.directions
  assert.equal(seq.status, 'found')
  assert.ok(dirs.slice(0, seq.check!.hitK! - 1).includes('down'), 'a down bar precedes the up reversal')

  // describeRepresentativeHit separates hit / still-true-at-N / throughout, and never says "earliest possible"
  const goal = within(5, 'up')
  const hold = [10, 10, 16, 10, 9]
  const check = checkGoal(b, goal, hold)
  const hit = describeRepresentativeHit({ goal, check, ctx: ctx(b), futureBars: undefined, smaAtHit: 12.5, closeAtHit: 16, fmt: exact, retained: null })!
  const hitText = [hit.headline, ...hit.lines].join(' ')
  assert.match(hit.headline, /T\+3.*初めて/)
  assert.match(hitText, /12\.5/)
  assert.match(hitText, /16円/)
  assert.match(hitText, /T\+4.*ではなくなり/)
  assert.match(hitText, /T\+5 の時点では上向きではありません/)
  assert.ok(hitText.includes(REPRESENTATIVE_HIT_NOTE))
  assert.doesNotMatch(hitText.replace(REPRESENTATIVE_HIT_NOTE, ''), /最短|最も早|最速|earliest/)
  assert.doesNotMatch(hitText, /ずっと/, 'no "throughout" claim for a hit that was lost')
  const held = describeRepresentativeHit({ goal, check: checkGoal(b, goal, [16, 17, 18, 19, 20]), ctx: ctx(b), futureBars: undefined, smaAtHit: null, closeAtHit: null, fmt: exact, retained: null })!
  assert.match([held.headline, ...held.lines].join(' '), /T\+5 までずっと上向きのまま/)
  const rev = describeRepresentativeHit({ goal: reversal(3, 'up'), check: checkGoal(b, reversal(3, 'up'), [14, 13, 16]), ctx: ctx(b), futureBars: undefined, smaAtHit: null, closeAtHit: null, fmt: exact, retained: { state: 'known', direction: 'up' } })!
  assert.match(rev.headline, /T\+3.*下向きから上向きへ転換/)
  assert.equal(describeRepresentativeHit({ goal: exactN(3, 'up'), check, ctx: ctx(b), futureBars: undefined, smaAtHit: null, closeAtHit: null, fmt: exact, retained: null }), null)
}

// ---------------------------------------------------------------------------
// 6. Wording keeps the three scopes and the reversal event apart.
{
  const c = ctx(UP)
  const titles = [exactN(3, 'up'), within(3, 'up'), through(3, 'up'), reversal(3, 'up')].map((goal) => goalTitle(goal, c))
  assert.equal(new Set(titles).size, 4)
  assert.match(titles[0], /3営業日後の時点で.*上向き/)
  assert.match(titles[1], /3営業日以内に一度でも.*上向き/)
  assert.match(titles[2], /今後3営業日、すべての足で.*上向き/)
  assert.match(titles[3], /転換 \(符号反転\)/)
  for (const [i, title] of titles.entries()) {
    if (i !== 3) assert.doesNotMatch(title, /転換/, 'only the reversal goal talks about 転換')
  }
  assert.doesNotMatch(goalCondition(within(3, 'up'), c), /続ける|ずっと|すべての足|時点で/)
  assert.doesNotMatch(goalCondition(exactN(3, 'up'), c), /一度でも|以内/)
  assert.match(REVERSAL_DEFINITION, /横ばい/)
  assert.match(REVERSAL_DEFINITION, /上向きのままは「上向きへの転換」ではありません/)
  assert.match(REVERSAL_DEFINITION, /上向き→下向き→上向き/)
  const priceWithin = priceCondition(analyzeSolverGoal(UP, within(3, 'up')), c)
  assert.match(priceWithin.headline, /どれか1本でも満たせば到達します \(T\+0 は数えません\)/)
  const priceSeq = priceCondition(analyzeSolverGoal(UP, reversal(3, 'up')), c)
  assert.match(priceSeq.headline, /2段階/)
  const infeasible = priceCondition(analyzeSolverGoal(UP, within(3, 'up'), { min: null, max: 12, tick: null }), c)
  assert.doesNotMatch(infeasible.headline, /打ち切り|探索/)
  // boundary markers stay bounded when N is large
  const wide = base(Array.from({ length: 40 }, (_, i) => 100 + i), 20)
  assert.ok(solverBoundaries(analyzeSolverGoal(wide, { kind: 'within', period: 25, within: 20, direction: 'up' }), { timeframe: '1D', exact, unit: '円' }).length <= 10)
}

// ---------------------------------------------------------------------------
// 7. 20 bars on every timeframe and SMA 3..300; arbitrary N in 1..20; Price Freeze 60 kept.
{
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const options = smaLabHorizonOptions(timeframe.id)
    for (const n of [1, 3, 5, 10, 20].filter((value) => value <= smaLabMaxHorizonBars(timeframe.id))) assert.ok(options.includes(n), `${timeframe.id}: ${n} selectable`)
  }
  assert.ok(smaLabHorizonOptions('1D').includes(60), 'daily Price Freeze 60 stays')
  assert.deepEqual([...SOLVER_QUICK_TIMINGS], [1, 3, 5, 10, 20])
  assert.equal(SMA_LAB_SOLVER_MAX_BARS, 20)

  const fixtures = buildSmaDynamicsFixtures()
  for (const id of ['jp-long-history', 'us-falling', 'jp-rising']) {
    const fixture = fixtures.find((item) => item.id === id)!
    for (const timeframe of SMA_LAB_TIMEFRAMES.filter((item) => smaLabMaxHorizonBars(item.id) >= 20)) {
      const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: timeframe.id, horizon: 20, analysisDate: fixture.analysisDate })
      if (result.status !== 'available') continue
      assert.equal(result.projection.bars.length, 20, `${id}/${timeframe.id}: twenty ${timeframe.id} bars`)
      assert.equal(new Set(result.projection.bars.map((bar) => bar.key)).size, 20, `${id}/${timeframe.id}: twenty distinct buckets`)
      const fb = forwardBase(result)
      assert.equal(fb.horizon, 20)
      assert.deepEqual(fb.confirmedCloses.length > 0, true)
      // Price Freeze and the solver share one projection: the frozen path is the as-of close for all 20 bars
      assert.deepEqual(priceFreezePath(fb.anchorClose, 20), result.projection.bars.map((bar) => bar.close))
      for (const period of [3, 5, 25] as const) {
        if (result.periods.find((item) => item.period === period)?.status !== 'ok') continue
        for (const n of [1, 3, 5, 10, 20]) {
          for (const goal of [exactN(n, 'up'), within(n, 'down'), through(n, 'flat'), { kind: 'reversal', period, within: n, to: 'up' } as SolverGoal]) {
            const g = { ...goal, period } as SolverGoal
            const analysis = analyzeSolverGoal(fb, g)
            if (analysis.status === 'unavailable') {
              // only a reversal can be unavailable here: its prior direction needs period + 1 confirmed bars, never guessed
              assert.equal(g.kind, 'reversal', `${id}/${timeframe.id}/SMA${period}/${g.kind}${n}`)
              assert.equal(analysis.issue, 'anchor_direction_unknown')
              continue
            }
            if (analysis.status !== 'feasible') continue
            const path = representativePath(fb, analysis, 'hold', 0.1)
            assert.equal(path.status, 'found')
            assert.equal(path.check?.satisfied, true)
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. T+10 / T+20 with every lab period, bounds and ticks; performance at 20 bars.
{
  const closes = Array.from({ length: 420 }, (_, i) => Number((1000 + 40 * Math.sin(i / 7) + 25 * Math.cos(i / 3) + i * 0.3).toFixed(1)))
  const fb: ForwardBase = { confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose: closes.at(-1)!, horizon: 20 }
  const started = performance.now()
  let evaluated = 0
  for (const period of SMA_LAB_PERIODS) {
    for (const n of [10, 20]) {
      for (const d of ['up', 'flat', 'down'] as const) {
        const goals: SolverGoal[] = [
          { kind: 'direction', period, bar: n, direction: d },
          { kind: 'within', period, within: n, direction: d },
          { kind: 'maintain', period, through: n, direction: d },
        ]
        if (d !== 'flat') goals.push({ kind: 'reversal', period, within: n, to: d })
        for (const goal of goals) {
          // Equality needs the leaving close itself on the grid, which these 0.1-decimal closes are not: strict goals only on a tick.
          const tick = d === 'flat' ? null : 0.5
          const analysis = analyzeSolverGoal(fb, goal, { min: null, max: null, tick })
          assert.equal(analysis.status === 'feasible', true, `${JSON.stringify(goal)} -> ${analysis.status}/${analysis.issue}`)
          const hold = representativePath(fb, analysis, 'hold', 0.1)
          assert.equal(hold.status, 'found', JSON.stringify(goal))
          assert.equal(hold.check?.satisfied, true, JSON.stringify(goal))
          if (tick) assert.ok(hold.closes!.every((close) => Math.abs(close * 2 - Math.round(close * 2)) < 1e-9), 'values sit on the 0.5 tick')
          evaluated += 1
        }
      }
    }
  }
  const elapsed = performance.now() - started
  assert.ok(elapsed < 4000, `analysis + hold path for ${evaluated} 20-bar goals took ${elapsed.toFixed(0)}ms`)

  // the heaviest search families (constant / linear / geometric) at 20 bars stay interactive
  const heavy = performance.now()
  for (const goal of [within(20, 'up'), reversal(20, 'up'), through(20, 'down')]) {
    const analysis = analyzeSolverGoal(fb, { ...goal, period: 5 } as SolverGoal)
    for (const item of PATH_ASSUMPTIONS) representativePath(fb, analysis, item.id, 0.1)
  }
  assert.ok(performance.now() - heavy < 3000, `all four assumptions at 20 bars: ${(performance.now() - heavy).toFixed(0)}ms`)

  // bounds and tick: strict inequalities, equality only on the grid, bounds respected
  const small = base([10, 11, 12, 13, 14, 15], 20)
  const bounded = analyzeSolverGoal(small, within(3, 'up'), { min: 13, max: 20, tick: 0.5 })
  assert.equal(bounded.status, 'feasible')
  assert.equal(bounded.primary?.bound?.value, 13.5, 'T+1: lowest admissible price above 13 on a 0.5 tick')
  const flatTick = analyzeSolverGoal(small, within(3, 'flat'), { min: null, max: null, tick: 2 })
  assert.equal(flatTick.status, 'feasible', '14 is on the 2-tick grid for the T+2 flat requirement')
  const flatNone = analyzeSolverGoal(base([10, 11, 12, 13, 15, 17], 3), within(3, 'flat'), { min: null, max: null, tick: 2 })
  assert.equal(flatNone.status, 'infeasible')
  assert.equal(flatNone.issue, 'tick_excludes_equality', 'equality needs 13/15/17 on a 2-tick grid: only odd values; 13, 15, 17 are on-grid? none are even')
  const grid = representativePath(small, bounded, 'hold', 0.1)
  assert.ok(grid.closes!.every((close) => close >= 13 && close <= 20 && Math.abs(close * 2 - Math.round(close * 2)) < 1e-9))
  // multiple solutions: several bars can satisfy a within goal, and no unique price is claimed
  const multi = analyzeSolverGoal(small, within(3, 'up'))
  assert.equal(multi.requirements.filter((item) => item.kind === 'threshold' && item.feasible).length, 3)
}

// ---------------------------------------------------------------------------
// 9. Draft: N is shared by every scope; defaults and advanced goals stay reachable.
{
  const D = DEFAULT_SOLVER_DRAFT
  assert.equal(D.kind, 'direction', 'Phase 2.2 default scope is unchanged')
  const toWithin = applySolverDraftPatch({ ...D, bar: 7 }, { kind: 'within' }, 'up')
  assert.equal(toWithin.within, 7, 'switching scope keeps N')
  const toMaintain = applySolverDraftPatch(toWithin, { kind: 'maintain' }, 'up')
  assert.equal(toMaintain.within, 7)
  assert.equal(applySolverDraftPatch(toMaintain, { kind: 'direction' }, 'up').bar, 7)
  assert.equal(applySolverDraftPatch({ ...D, bar: 7 }, { kind: 'within', within: 12 }, 'up').within, 12, 'explicit N wins')
  assert.deepEqual(goalFromDraft({ ...D, kind: 'within', within: 12, direction: 'down' }, 20, 25), { kind: 'within', period: 25, within: 12, direction: 'down' })
  assert.deepEqual(goalFromDraft({ ...D, kind: 'maintain', within: 30, direction: 'up' }, 20, 25), { kind: 'maintain', period: 25, through: 20, direction: 'up' })
  assert.equal(applySolverDraftPatch({ ...D, to: 'up' }, { kind: 'reversal' }, 'up').to, 'down')
}

// ---------------------------------------------------------------------------
// 10. Rendered UI (shared by JP and US): order SMA -> scope -> direction -> result; scopes separate from advanced goals.
{
  const fixtures = buildSmaDynamicsFixtures()
  for (const id of ['jp-rising', 'us-falling']) {
    const fixture = fixtures.find((item) => item.id === id)!
    for (const timeframe of ['1D', '1W', '3M'] as const) {
      const markup = renderToStaticMarkup(createElement(SmaDynamicsView, {
        security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
        analysisDate: fixture.analysisDate,
        load: { status: 'ready', rows: fixture.rows },
        dataSource: { label: 'テスト', priceBasis: '合成データ' },
        initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: 'solver', timeframe },
      }))
      const order = ['どの移動平均線？', 'data-sma-solver-scope', 'data-sma-solver-timing', 'どう動いてほしい？', '結果を見る'].map((needle) => markup.indexOf(needle))
      assert.ok(order.every((index) => index >= 0), `${id}/${timeframe}: all steps present`)
      assert.deepEqual([...order].sort((a, b) => a - b), order, `${id}/${timeframe}: SMA → scope → N → direction → result`)
      assert.equal((markup.match(/data-solver-scope-option=/g) ?? []).length, 3)
      for (const scope of ['direction', 'within', 'maintain']) assert.match(markup, new RegExp(`data-solver-scope-option="${scope}"`))
      const visible = text(markup)
      assert.ok(visible.includes('一度でも') && visible.includes('すべての足で') && visible.includes('その時点だけ'))
      assert.ok(visible.includes('上級: 転換・水準を調べる'))
      assert.match(markup, /data-timing-k="20"/, '20 bars are a basic choice')
    }
  }
  const picker = (kind: Parameters<typeof SolverScopePicker>[0]['kind']) => renderToStaticMarkup(createElement(SolverScopePicker, { timeframe: '1W', kind, n: 3, onPick: noop }))
  assert.match(picker('within'), /aria-pressed="true"[^>]*data-solver-scope-option="within"/)
  assert.equal((picker('reversal').match(/aria-pressed="true"/g) ?? []).length, 0, 'an advanced goal leaves every scope unpressed')
  assert.match(text(picker('reversal')), /上級の調べ方を選択中/)
  assert.match(text(picker('within')), /3週以内/)
  assert.match(text(picker('within')), /今 \(T\+0\) は数えず|T\+0/)
  const advanced = renderToStaticMarkup(createElement(SolverKindPicker, { draft: { ...DEFAULT_SOLVER_DRAFT, kind: 'reversal' }, onDraftChange: noop }))
  assert.match(advanced, /data-sma-reversal-definition/)
  assert.match(text(advanced), /上向きのままは「上向きへの転換」ではありません/)
  const directions = renderToStaticMarkup(createElement(SolverDirectionPicker, { draft: { ...DEFAULT_SOLVER_DRAFT, kind: 'within' }, onDraftChange: noop }))
  assert.equal((directions.match(/<button/g) ?? []).length, 3, 'within offers the three equal directions')
  const timing = renderToStaticMarkup(createElement(SolverTimingPicker, { timeframe: '1M', kind: 'within', value: 12, maxK: 20, futureBars: undefined, onPick: noop }))
  assert.match(text(timing), /1か月|10か月|20か月/)
  assert.match(timing, /<option value="19">/, 'any N up to 20 is selectable')
}

// ---------------------------------------------------------------------------
// 11. Result panel: hit bar, no conflation of hit / still true / throughout; chart highlight is data-driven.
{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 20, analysisDate: fixture.analysisDate }) as SmaLabAvailable
  const fb = forwardBase(result)
  const fmt = priceFormatter(1)
  const fmtExact = exactFormatter(1)
  const render = (goal: SolverGoal) => {
    const analysis = analyzeSolverGoal(fb, goal)
    const paths = Object.fromEntries(PATH_ASSUMPTIONS.map((item) => [item.id, representativePath(fb, analysis, item.id, 0.1)])) as SolverViewModel['paths']
    const model: SolverViewModel = { goal, analysis, paths, scenarioCheck: null, freezeCheck: checkGoal(fb, goal, priceFreezePath(fb.anchorClose, fb.horizon)), comparison: null }
    const draft = { ...DEFAULT_SOLVER_DRAFT, assumption: 'hold' as const }
    const conclusion = renderToStaticMarkup(createElement(SolverConclusion, { result, base: fb, model, draft, fmt, exact: fmtExact, market: 'JP' }))
    const details = renderToStaticMarkup(createElement(SolverDetails, { result, base: fb, model, draft, fmt, exact: fmtExact, market: 'JP', onDraftChange: noop, onCopyToScenario: noop }))
    return { conclusion, details, model }
  }
  const w = render({ kind: 'within', period: 5, within: 10, direction: 'down' })
  assert.match(w.conclusion, /data-solver-kind-tag="within"/)
  assert.match(text(w.conclusion), /10営業日以内のどこか1本以上で/)
  assert.match(text(w.conclusion), /一度でも|初めて/)
  assert.match(w.conclusion, /data-solver-hit="\d+"/, 'representative first hit is reported')
  assert.ok(text(w.conclusion).includes(REPRESENTATIVE_HIT_NOTE))
  assert.match(text(w.details), /\(T\+0\) の向きは数えず/)
  assert.match(w.details, /data-hit="true"/, 'hit bar highlighted in the path table')
  assert.match(text(w.details), /この例の最初の到達/)
  assert.doesNotMatch(text(w.conclusion).replace(REPRESENTATIVE_HIT_NOTE, ''), /最短|最も早く|最速/, 'only the disclaimer mentions 最短')
  const r = render({ kind: 'reversal', period: 5, within: 10, to: 'up' })
  assert.match(r.conclusion, /data-solver-kind-tag="reversal"/)
  assert.match(text(r.details), /中立の橋|横ばいを中立/)
  assert.match(text(r.conclusion), /転換/)
  const m = render({ kind: 'maintain', period: 5, through: 10, direction: 'up' })
  assert.doesNotMatch(m.conclusion, /data-solver-hit=/, 'throughout has no hit bar')
  assert.match(text(m.conclusion), /すべての足/)

  // chart model carries the highlight on the right future slot and nothing else
  const hitK = w.model.paths.hold.check!.hitK!
  const price = w.model.paths.hold.closes![hitK - 1]
  const chart = buildSmaLabChartModel(result, [5], { highlights: [{ k: hitK, price, label: `T+${hitK}` }] })
  assert.equal(chart.highlights.length, 1)
  assert.equal(chart.highlights[0].time, chart.slots[chart.slots.findIndex((slot) => slot.future?.k === hitK)].time)
  assert.equal(buildSmaLabChartModel(result, [5], {}).highlights.length, 0)
  assert.equal(buildSmaLabChartModel(result, [5], { highlights: [{ k: 99, price: 1, label: 'x' }] }).highlights.length, 0)
}

console.log('SMA Dynamics Phase 2.3 scope / reversal / 20-bar tests passed.')
