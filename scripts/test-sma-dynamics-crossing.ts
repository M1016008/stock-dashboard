// SMA Dynamics Lab: touch / cross inverse solver and SMA shape geometry.
// The solver is checked against an independent forward recomputation (evaluateCrossingGoal)
// on deterministic synthetic histories. No database, API or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeSmaLab, projectSmaPath, type SmaLabAvailable } from '@/lib/sma-dynamics-lab'
import { findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import { forwardBase, projectAllSma, type ForwardBase } from '@/lib/sma-dynamics-scenario'
import {
  analyzeCrossingGoal,
  affineGap,
  crossingExamplePath,
  crossingGoalPeriods,
  evaluateCrossingGoal,
  holdPrior,
  smaOver,
  type CrossingGoal,
} from '@/lib/sma-dynamics-crossing'
import { domainMinAbove, gridFloor, isOnGrid, parseConstraints, priceDomain, priceGrid } from '@/lib/sma-dynamics-scenario'
import {
  adjacentPairs,
  analyzeShape,
  buildShapeTimeline,
  classifyCurvature,
  classifySlope,
  describeCross,
  describeShape,
  findCrosses,
  gapSeries,
  lastStrictSide,
  slopeSeries,
  snapshotAt,
} from '@/lib/sma-dynamics-geometry'

// Deterministic generator (LCG) so every run sees the same histories.
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function baseFrom(closes: number[], horizon: number, anchorClose = closes[closes.length - 1]): ForwardBase {
  return { confirmedCloses: closes, anchorIndex: closes.length - 1, anchorClose, horizon }
}

function walk(seed: number, length: number, start = 100, vol = 0.02): number[] {
  const next = rng(seed)
  const out: number[] = []
  let price = start
  for (let i = 0; i < length; i += 1) {
    price = Math.max(1, price * (1 + (next() - 0.5) * 2 * vol))
    out.push(Math.round(price * 100) / 100)
  }
  return out
}

// ---------------------------------------------------------------------------
// Geometry: slope, curvature, classification
{
  assert.equal(classifySlope(0.0099), 'flat')
  assert.equal(classifySlope(0.02), 'up')
  assert.equal(classifySlope(-0.02), 'down')
  assert.equal(classifyCurvature(0.004), 'steady')
  assert.equal(classifyCurvature(0.5), 'bending_up')
  assert.equal(classifyCurvature(-0.5), 'bending_down')

  const points = slopeSeries([100, 101, 103, 106, null, 107, 107.5])
  assert.equal(points[0].slopePct, null)
  assert.ok(Math.abs(points[1].slopePct! - 1) < 1e-12)
  assert.ok(Math.abs(points[2].slopePct! - (2 / 101) * 100) < 1e-12)
  assert.ok(points[2].curvaturePct! > 0, 'accelerating rise bends upward')
  assert.equal(points[2].shape, 'rising_faster')
  assert.equal(points[4].slopePct, null, 'a missing value never gets a slope')
  assert.equal(points[5].slopePct, null, 'and the bar after it has no slope either')
  assert.equal(points[6].slopePct === null, false)
  assert.equal(points[6].curvaturePct, null, 'curvature needs two consecutive slopes')
  assert.equal(describeShape(points[2]), '上向き・勢いが増す')
  const decel = slopeSeries([100, 102, 103, 103.5])
  assert.equal(decel[3].shape, 'rising_slower')
  const down = slopeSeries([100, 99, 97, 94])
  assert.equal(down[3].shape, 'falling_faster')
  const falling = slopeSeries([100, 97, 95, 94])
  assert.equal(falling[3].shape, 'falling_slower')
  const constant = slopeSeries([100, 101, 102.01, 103.0301])
  assert.equal(describeShape(constant[3]), '上向き・傾きは一定')
}

// Geometry: gaps, convergence / divergence, crosses
{
  const a = [10, 11, 12, 13, 12, 11, 10, 9]
  const b = [11, 11, 11, 11, 11, 11, 11, 11]
  const gaps = gapSeries(a, b)
  assert.equal(gaps[0].side, -1)
  assert.equal(gaps[1].side, 0, 'exact tie is a touch')
  assert.equal(gaps[2].side, 1)
  assert.equal(gaps[3].trend, 'diverging')
  assert.equal(gaps[4].trend, 'converging')
  const crosses = findCrosses(gaps, 3, 5, 25)
  assert.deepEqual(crosses.map((event) => [event.direction, event.index, event.touchIndex, event.phase]), [['up', 2, 1, 'past'], ['down', 6, 5, 'future']])
  // Touch and bounce back is not a cross.
  assert.deepEqual(findCrosses(gapSeries([10, 11, 10], [11, 11, 11]), 2, 5, 25), [])
  // A tie at the very start has no side before it, so leaving it is not a cross.
  assert.deepEqual(findCrosses(gapSeries([11, 12, 13], [11, 11, 11]), 2, 5, 25), [])
  // A missing value ends the chain.
  assert.deepEqual(findCrosses(gapSeries([10, null, 12], [11, 11, 11]), 2, 5, 25), [])
  assert.equal(lastStrictSide(gaps, 1), -1, 'skips the tie to the last strict side')
  assert.equal(lastStrictSide(gapSeries([null], [1]), 0), null)
  assert.deepEqual(adjacentPairs([25, 5, 75]), [[5, 25], [25, 75]])
  assert.equal(describeCross({ subject: 5, reference: 25, direction: 'up' }), 'SMA5 が SMA25 を上に抜ける')
  assert.equal(describeCross({ subject: 'close', reference: 25, direction: 'down' }), '終値 が SMA25 を下に抜ける')
}

// Geometry on a real lab result: aligned with the lab's own SMA lines.
{
  const fixture = findSmaDynamicsFixture('jp-rising')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 10, analysisDate: fixture.analysisDate, periods: [7, 120] })
  assert.equal(result.status, 'available')
  const available = result as SmaLabAvailable
  const base = forwardBase(available)
  const periods = [5, 7, 25]
  const closes = available.projection.bars.map((bar) => bar.close)
  const timeline = buildShapeTimeline(available, base, closes, projectAllSma(base, closes), periods)
  assert.equal(timeline.closes.length, base.confirmedCloses.length + 10)
  for (const period of periods) {
    assert.equal(timeline.sma[period].length, timeline.closes.length)
    // The timeline equals the lab's own confirmed line and its projection, bar for bar.
    assert.deepEqual(timeline.sma[period].slice(0, base.anchorIndex + 1), available.sma[period].slice(0, base.anchorIndex + 1))
    assert.deepEqual(timeline.sma[period].slice(base.anchorIndex + 1), available.projection.sma[period])
    assert.deepEqual(timeline.sma[period], smaOver(timeline.closes, period), `SMA${period} recomputed from closes matches the lab`)
  }
  const analysis = analyzeShape(timeline, periods)
  assert.deepEqual(analysis.pairs.map((pair) => [pair.shorter, pair.longer]), [[5, 7], [7, 25]])
  assert.equal(analysis.closes.length, 3)
  assert.equal(analysis.band.length, timeline.closes.length)
  const snap = snapshotAt(analysis, timeline, base.anchorIndex)
  assert.equal(snap.length, 3)
  assert.ok(snap.every((row) => row.sma != null && row.slopePct != null))
  // A rising fixture: short SMAs sit above long ones at the as-of bar.
  assert.equal(analysis.order[base.anchorIndex].kind, 'bullish')
  assert.deepEqual(analysis.order[base.anchorIndex].ranking, [5, 7, 25])
  // Under price freeze the family converges toward the frozen close.
  const end = analysis.band[analysis.band.length - 1]
  const mid = analysis.band[base.anchorIndex]
  assert.ok(end.widthPct! < mid.widthPct!, 'frozen price narrows the SMA band')
  assert.equal(end.trend, 'converging')
  // A single SMA has no band and no pairs.
  const single = analyzeShape(timeline, [5])
  assert.equal(single.pairs.length, 0)
  assert.equal(single.band.every((point) => point.widthPct === null), true)
}

// ---------------------------------------------------------------------------
// Solver: the affine gap is exact
{
  const closes = walk(11, 80)
  const before = closes
  const goalClose = { subject: { kind: 'close' as const }, reference: 25 }
  const goalSma = { subject: { kind: 'sma' as const, period: 5 }, reference: 25 }
  for (const goal of [goalClose, goalSma]) {
    const affine = affineGap(goal, before)!
    for (const x of [50, 99.5, 130]) {
      const series = [...before, x]
      const subject = goal.subject.kind === 'close' ? x : smaOver(series, goal.subject.period).at(-1)!
      const reference = smaOver(series, goal.reference).at(-1)!
      assert.ok(Math.abs(affine.c0 + affine.c1 * x - (subject - reference)) < 1e-9, 'affine gap equals the directly computed gap')
    }
  }
  assert.equal(affineGap(goalClose, closes.slice(0, 10)), null, 'short window -> unavailable')
  assert.equal(affineGap(goalClose, [...closes.slice(0, 70), null, ...closes.slice(71)]), null, 'unusable close in the window -> unavailable')
}

// Solver vs forward recomputation over many histories, goals, bars and constraint sets.
{
  let checked = 0
  let feasibleBars = 0
  let naturalHits = 0
  for (let seed = 1; seed <= 24; seed += 1) {
    const history = walk(seed * 7, 90 + (seed % 5) * 10, 80 + seed, 0.015 + (seed % 4) * 0.005)
    const base = baseFrom(history, 6)
    const priors = [holdPrior(base, base.horizon)]
    for (const prior of priors) {
      for (const subject of [{ kind: 'close' as const }, { kind: 'sma' as const, period: 5 }, { kind: 'sma' as const, period: 13 }]) {
        for (const reference of [25, 50]) {
          if (subject.kind === 'sma' && subject.period === reference) continue
          const goals: CrossingGoal[] = [
            { kind: 'cross', subject, reference, within: 6, direction: 'up' },
            { kind: 'cross', subject, reference, within: 6, direction: 'down' },
            { kind: 'relation', subject, reference, bar: 3, relation: 'above' },
            { kind: 'relation', subject, reference, bar: 3, relation: 'below' },
            { kind: 'touch', subject, reference, bar: 2 },
          ]
          for (const goal of goals) {
            for (const constraints of [{ min: null, max: null, tick: null }, { min: null, max: null, tick: 0.01 }]) {
              const analysis = analyzeCrossingGoal(base, goal, prior, constraints)
              if (analysis.natural) {
                naturalHits += 1
                const check = evaluateCrossingGoal(base, goal, prior)
                assert.equal(check.met, true, 'natural hit really holds on the prior path')
              }
              for (const bar of analysis.bars) {
                if (bar.status !== 'feasible') continue
                feasibleBars += 1
                const x = bar.bound!.value
                const stepBeyond = bar.bound!.attained ? x : bar.op === '>' ? x + 1e-3 : x - 1e-3
                const path = [...prior.slice(0, bar.k - 1), stepBeyond, ...prior.slice(bar.k)]
                const outcome = evaluateCrossingGoal(base, goal, path)
                if (goal.kind === 'touch') {
                  // Equality: the boundary price itself touches (to float tolerance).
                  const gap = outcome.gapPct[bar.k - 1]
                  assert.ok(gap != null && Math.abs(gap) < 1e-6, `touch gap ~0 (seed ${seed}) got ${gap}`)
                } else if (goal.kind === 'cross') {
                  assert.ok(outcome.met, `cross met at bar ${bar.k} (seed ${seed})`)
                  assert.ok(outcome.hitK != null && outcome.hitK <= bar.k, 'a cross is found by bar k')
                } else {
                  assert.ok(outcome.met, `relation met (seed ${seed})`)
                }
                // The first value on the wrong side must NOT satisfy a strict relation / cross.
                if (goal.kind !== 'touch') {
                  const wrong = bar.op === '>' ? bar.threshold! - 1e-3 : bar.threshold! + 1e-3
                  const wrongPath = [...prior.slice(0, bar.k - 1), wrong, ...prior.slice(bar.k)]
                  const wrongOutcome = evaluateCrossingGoal(base, goal, wrongPath)
                  if (goal.kind === 'relation') assert.equal(wrongOutcome.met, false, `wrong side fails (seed ${seed}, bar ${bar.k})`)
                  else assert.ok(wrongOutcome.hitK !== bar.k, 'wrong side does not cross at this bar')
                }
                checked += 1
              }
            }
          }
        }
      }
    }
  }
  assert.ok(feasibleBars > 400 && checked === feasibleBars, `solver exercised broadly (${feasibleBars} feasible bars, ${naturalHits} natural)`)
}

// Concrete hand-checked case: flat history, price steps up through SMA.
{
  // 30 closes of 100, then 90: SMA5 = 98, SMA25 = 99.6 (the close is below both).
  const history = [...Array<number>(29).fill(100), 90]
  const base = baseFrom(history, 5)
  const goal: CrossingGoal = { kind: 'cross', subject: { kind: 'close' }, reference: 5, within: 1, direction: 'up' }
  const analysis = analyzeCrossingGoal(base, goal, [90, 90, 90, 90, 90])
  // x must exceed the mean of the 4 other window closes: (100+100+100+90)/4 = 97.5
  assert.equal(analysis.bars[0].threshold, 97.5)
  assert.equal(analysis.bars[0].op, '>')
  assert.equal(analysis.bars[0].bound?.attained, false, 'continuous price: strict boundary is an infimum')
  assert.equal(analysis.status, 'feasible')
  assert.equal(analysis.recommended?.k, 1)
  // With a 0.5 tick the first admissible close is 98.
  const ticked = analyzeCrossingGoal(base, goal, [90, 90, 90, 90, 90], { min: null, max: null, tick: 0.5 })
  assert.equal(ticked.bars[0].bound?.value, 98)
  assert.equal(ticked.bars[0].bound?.attained, true)
  // A ceiling below the boundary makes it infeasible.
  const capped = analyzeCrossingGoal(base, goal, [90, 90, 90, 90, 90], { min: null, max: 95, tick: null })
  assert.equal(capped.status, 'infeasible')
  assert.equal(capped.issue, 'bound_excludes_threshold')
  // Touch exactly at 97.5 on a 0.5 grid is attained; on a 1.0 grid it is not.
  const touch: CrossingGoal = { kind: 'touch', subject: { kind: 'close' }, reference: 5, bar: 1 }
  const touchHalf = analyzeCrossingGoal(base, touch, [90, 90, 90, 90, 90], { min: null, max: null, tick: 0.5 })
  assert.equal(touchHalf.bars[0].status, 'feasible')
  assert.equal(touchHalf.bars[0].bound?.value, 97.5)
  const touchWhole = analyzeCrossingGoal(base, touch, [90, 90, 90, 90, 90], { min: null, max: null, tick: 1 })
  assert.equal(touchWhole.bars[0].status, 'infeasible')
  assert.equal(touchWhole.bars[0].issue, 'tick_excludes_equality')
  assert.deepEqual(touchWhole.bars[0].neighbours, { below: 97, above: 98 })
  // A path that naturally hits still has to obey the explicit domain. It must
  // not override the correctly-infeasible solved bar.
  const naturalTouch: CrossingGoal = { kind: 'touch', subject: { kind: 'close' }, reference: 5, bar: 1 }
  const naturalCapped = analyzeCrossingGoal(base, naturalTouch, [100], { min: null, max: 90, tick: null })
  assert.equal(naturalCapped.natural, null)
  assert.equal(naturalCapped.status, 'infeasible')
  const naturalOffGrid = analyzeCrossingGoal(base, naturalTouch, [100], { min: null, max: null, tick: 3 })
  assert.equal(naturalOffGrid.natural, null)
  assert.equal(naturalOffGrid.status, 'infeasible')
  // Already above: an up-cross is ruled out by the side before.
  const aboveBase = baseFrom([...Array<number>(29).fill(100), 110], 3)
  const ruledOut = analyzeCrossingGoal(aboveBase, { kind: 'cross', subject: { kind: 'close' }, reference: 5, within: 1, direction: 'up' }, [110, 110, 110])
  assert.equal(ruledOut.status, 'precondition_failed')
  assert.equal(ruledOut.issue, 'already_on_target_side')
  // The example path steps beyond a strict boundary and holds there.
  const example = crossingExamplePath(base, analysis.bars[0], [90, 90, 90, 90, 90], 0.1, analysis.domain)!
  assert.equal(example[0], 97.6)
  assert.deepEqual(example, [97.6, 97.6, 97.6, 97.6, 97.6])
  assert.equal(evaluateCrossingGoal(base, goal, example).met, true)

  // Large quotients do not relax the tick test: a half-tick remains off-grid.
  const tiny = priceGrid(0.0000001)!
  assert.equal(isOnGrid(tiny, 97.5), true)
  assert.equal(isOnGrid(tiny, 97.50000005), false)
  assert.equal(priceGrid(0.000000000001)?.stepUnits, 1)
  assert.equal(isOnGrid(priceGrid(0.000000000001)!, 1000), true)
  assert.equal(isOnGrid(priceGrid(0.000000000001)!, 1000.0000000000005), false)
  assert.equal(Number.isNaN(gridFloor(priceGrid(0.000000000001)!, 10000)), true)
  assert.equal(domainMinAbove(priceDomain({ min: null, max: null, tick: 0.000000000001 }), 10000), null)
  assert.equal(priceGrid(0.0000000000001), null)
  assert.deepEqual(parseConstraints({ minText: '', maxText: '', tickText: '0.0000000000001' }).errors, ['tick'])

  // A display-sized step must not escape a tight continuous domain. Pick an
  // interior value between the strict threshold and the cap instead.
  const tight = analyzeCrossingGoal(base, goal, [90, 90, 90, 90, 90], { min: null, max: 97.55, tick: null })
  const tightExample = crossingExamplePath(base, tight.bars[0], [90, 90, 90, 90, 90], 0.1, tight.domain)!
  assert.ok(tightExample[0] > 97.5 && tightExample[0] < 97.55)
  assert.equal(evaluateCrossingGoal(base, goal, tightExample).met, true)
}

// Natural crossings under price freeze, and unavailable inputs.
{
  // Close far below SMA5, then held flat: the SMA converges onto the close, so the close ends up above it
  // without any move (SMA falls toward 90 while the close stays 90 -> equal -> never strictly above).
  const history = [...Array<number>(29).fill(100), 90]
  const base = baseFrom(history, 6)
  const hold = holdPrior(base, 6)
  const natural = analyzeCrossingGoal(base, { kind: 'cross', subject: { kind: 'close' }, reference: 5, within: 6, direction: 'up' }, hold)
  assert.equal(natural.natural, null, 'converging onto an equal price is a touch, not a cross')
  // A short SMA overtakes a longer one by itself when a dip rolls out of the short window.
  const dip = [...Array<number>(20).fill(100), 120, 120, 120, 120, 120]
  const dipBase = baseFrom(dip, 4)
  const rolling = analyzeCrossingGoal(dipBase, { kind: 'cross', subject: { kind: 'sma', period: 5 }, reference: 20, within: 4, direction: 'down' }, holdPrior(dipBase, 4))
  assert.ok(rolling.status === 'feasible' || rolling.status === 'precondition_failed')
  // Too little history for SMA300.
  const short = baseFrom(walk(3, 40), 3)
  const unavailable = analyzeCrossingGoal(short, { kind: 'cross', subject: { kind: 'close' }, reference: 300, within: 3, direction: 'up' }, holdPrior(short, 3))
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.issue, 'sma_unavailable')
  // The same line cannot be compared with itself; a bar beyond the horizon is rejected.
  assert.equal(analyzeCrossingGoal(short, { kind: 'cross', subject: { kind: 'sma', period: 5 }, reference: 5, within: 2, direction: 'up' }, holdPrior(short, 3)).issue, 'same_line')
  assert.equal(analyzeCrossingGoal(short, { kind: 'touch', subject: { kind: 'close' }, reference: 5, bar: 9 }, holdPrior(short, 3)).issue, 'bar_out_of_range')
  // A hole in the prior path blocks every later bar.
  const holey = analyzeCrossingGoal(short, { kind: 'cross', subject: { kind: 'close' }, reference: 5, within: 3, direction: 'up' }, [short.anchorClose, null, short.anchorClose])
  assert.equal(holey.bars[2].issue, 'prior_missing')
  assert.deepEqual(crossingGoalPeriods({ kind: 'cross', subject: { kind: 'sma', period: 50 }, reference: 5, within: 1, direction: 'up' }), [5, 50])
}

// Custom periods (3..300) project exactly like the presets.
{
  const closes = walk(5, 400, 100, 0.01)
  const base = baseFrom(closes, 5)
  const future = [101, 102, 103, 104, 105]
  for (const period of [3, 7, 99, 217, 300]) {
    const series = projectSmaPath(base.confirmedCloses, future, period)
    const direct = smaOver([...closes, ...future], period).slice(closes.length)
    assert.deepEqual(series, direct, `SMA${period} projection equals direct recomputation`)
  }
}

// Source contract: pure modules, no I/O, no randomness.
{
  for (const file of ['lib/sma-dynamics-geometry.ts', 'lib/sma-dynamics-crossing.ts']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /fetch\(|@\/lib\/db|@\/lib\/queries|Math\.random|Date\.now|new Date\(\)|process\.env/, `${file} is pure`)
  }
}

console.log('test-sma-dynamics-crossing: ok')
