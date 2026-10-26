// SMA Dynamics Lab Phase 2: deterministic forward-scenario and inverse-solver QA.
import assert from 'node:assert/strict'
import { buildSmaDynamicsFixtures } from '@/lib/sma-dynamics-fixtures'
import { computeSmaLab, priceFreezePath, SMA_LAB_PERIODS } from '@/lib/sma-dynamics-lab'
import {
  NO_CONSTRAINTS,
  analyzeSolverGoal,
  anchorDirection,
  checkGoal,
  convertScenarioUnit,
  directionOf,
  emptyScenario,
  evaluateScenario,
  forwardBase,
  freshSimulationState,
  isDisplayFlat,
  parseNumericText,
  presetFreeze,
  priceDomain,
  representativePath,
  scenarioCellClose,
  scopeSimulationState,
  setScenarioInput,
  smaSteps,
  type ForwardBase,
  type SolverGoal,
} from '@/lib/sma-dynamics-scenario'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'

function near(actual: number | null, expected: number, label: string, tolerance = 1e-10) {
  assert.notEqual(actual, null, `${label}: value is unavailable`)
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`)
}

function base(horizon = 8): ForwardBase {
  return {
    confirmedCloses: [10, 11, 12, 13, 14, 15],
    anchorIndex: 5,
    anchorClose: 15,
    horizon,
  }
}

// Numeric entry accepts the documented forms but never fabricates an invalid value.
assert.equal(parseNumericText('１２３．５％'), 123.5)
assert.equal(parseNumericText(' 1,234.5 '), 1234.5)
assert.equal(parseNumericText(''), null)
assert.equal(parseNumericText('12円'), 'invalid')
assert.equal(scenarioCellClose(base(), 'price', '0').status, 'non_positive')

// Mode B: blanks and invalid values stay missing; they are not silently forward-filled.
{
  let draft = emptyScenario(3, 'price')
  draft = setScenarioInput(draft, 1, '16')
  draft = setScenarioInput(draft, 3, 'oops')
  const result = evaluateScenario({ ...base(), horizon: 3 }, draft)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.closes, [16, null, null])
  assert.deepEqual(result.missingK, [2])
  assert.deepEqual(result.invalidK, [3])
  near(result.sma[3][0], 15, 'scenario SMA3 T+1')
  assert.equal(result.sma[3][1], null, 'missing T+2 invalidates its rolling window')
  assert.equal(result.sma[3][2], null, 'invalid T+3 remains unavailable')

  const pct = convertScenarioUnit({ ...base(), horizon: 3 }, { unit: 'price', inputs: ['16.5', '', '15'] }, 'pct')
  assert.deepEqual(pct.inputs, ['10', '', '0'])
  assert.equal(evaluateScenario({ ...base(), horizon: 3 }, pct).closes[0], 16.5)
}

// Price Freeze is exactly Mode B with every future close fixed to the anchor close,
// across every supported timeframe and every computable SMA.
{
  const fixture = buildSmaDynamicsFixtures().find((item) => item.id === 'jp-rising')!
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: timeframe.id, horizon: 5 })
    assert.equal(result.status, 'available', `${timeframe.id}: fixture available`)
    if (result.status !== 'available') continue
    const fb = forwardBase(result)
    const scenario = evaluateScenario(fb, presetFreeze(fb, emptyScenario(fb.horizon, 'price')))
    assert.deepEqual(scenario.closes, priceFreezePath(result.asOf.close, 5), `${timeframe.id}: frozen closes`)
    for (const period of SMA_LAB_PERIODS) {
      assert.deepEqual(scenario.sma[period], result.projection.sma[period], `${timeframe.id}: SMA${period} freeze equivalence`)
    }
  }
}

// Once K exceeds the SMA period, the outgoing value is an earlier assumed close.
{
  const closes = [16, 17, 18, 20, 19]
  const steps = smaSteps({ ...base(), horizon: closes.length }, closes, 3)
  assert.deepEqual(steps[3].outgoingSource, { kind: 'future', k: 1 })
  assert.equal(steps[3].outgoing, 16)
  assert.equal(steps[3].direction, 'up')
  near(steps[3].delta, (20 - 16) / 3, 'K > N delta')
  assert.deepEqual(steps[4].outgoingSource, { kind: 'future', k: 2 })
}

// Exact direction and the display-only flat tolerance are deliberately separate.
assert.equal(directionOf(100.00001, 100), 'up')
assert.equal(isDisplayFlat(0.00001, 100), true)
assert.equal(directionOf(100, 100), 'flat')

// Mode C: one-bar direction thresholds, tick handling and impossible domains.
{
  const up: SolverGoal = { kind: 'direction', period: 3, bar: 1, direction: 'up' }
  const analysis = analyzeSolverGoal(base(), up, { min: null, max: null, tick: 0.5 })
  assert.equal(analysis.status, 'feasible')
  assert.deepEqual(analysis.primary, { k: 1, op: '>', value: 13, bound: { value: 13.5, attained: true } })
  assert.equal(checkGoal(base(), up, [13.5]).satisfied, true)
  assert.equal(checkGoal(base(), up, [13]).satisfied, false)

  const exactFlat: SolverGoal = { kind: 'direction', period: 3, bar: 1, direction: 'flat' }
  assert.equal(analyzeSolverGoal(base(), exactFlat, { min: null, max: null, tick: 0.5 }).status, 'feasible')
  const tickMiss = analyzeSolverGoal(base(), exactFlat, { min: null, max: null, tick: 2 })
  assert.equal(tickMiss.status, 'infeasible')
  assert.equal(tickMiss.issue, 'tick_excludes_equality')

  const boundedDown = analyzeSolverGoal(base(), { kind: 'direction', period: 3, bar: 1, direction: 'down' }, { min: 13, max: 20, tick: 0.5 })
  assert.equal(boundedDown.status, 'infeasible')
  assert.equal(boundedDown.issue, 'bound_excludes_threshold')

  const relative = analyzeSolverGoal(base(), { kind: 'direction', period: 3, bar: 4, direction: 'up' }, { min: 10, max: 10, tick: 1 })
  assert.equal(relative.status, 'infeasible')
  assert.equal(relative.issue, 'needs_two_prices')
}

// Reversal means a turn from the confirmed opposite direction, not merely a target sign.
{
  const fb = base()
  assert.equal(anchorDirection(fb, 3)?.direction, 'up')
  const turnDown: SolverGoal = { kind: 'reversal', period: 3, within: 2, to: 'down' }
  assert.equal(analyzeSolverGoal(fb, turnDown).status, 'feasible')
  assert.deepEqual(checkGoal(fb, turnDown, [13, 13]).hitK, 2)
  assert.equal(checkGoal(fb, turnDown, [13, 13]).satisfied, true)
  // Phase 2.3: staying up is not an up reversal, but down -> up inside the window is (two bars needed).
  const alreadyUp = analyzeSolverGoal(fb, { kind: 'reversal', period: 3, within: 2, to: 'up' })
  assert.equal(alreadyUp.status, 'feasible')
  assert.equal(alreadyUp.combinator, 'sequence')
  assert.deepEqual(alreadyUp.sequencePlan, { firstK: 1, secondK: 2 })
  const tooShort = analyzeSolverGoal(fb, { kind: 'reversal', period: 3, within: 1, to: 'up' })
  assert.equal(tooShort.status, 'infeasible')
  assert.equal(tooShort.issue, 'reversal_needs_two_bars')
}

// Maintain constraints form exact chains when future closes themselves leave the window.
{
  const goal: SolverGoal = { kind: 'maintain', period: 3, through: 5, direction: 'down' }
  const path = [12, 13, 14, 11, 12]
  assert.equal(analyzeSolverGoal(base(), goal).status, 'feasible')
  assert.equal(checkGoal(base(), goal, path).satisfied, true)
  assert.equal(checkGoal(base(), goal, [12, 13, 14, 12, 12]).satisfied, false)
}

// Level versus the anchor SMA is a sum condition and is not confused with slope.
{
  const levelUp: SolverGoal = { kind: 'level', period: 3, bar: 2, relation: 'up' }
  const analysis = analyzeSolverGoal(base(), levelUp)
  assert.equal(analysis.status, 'feasible')
  assert.deepEqual(analysis.sum && { fromK: analysis.sum.fromK, toK: analysis.sum.toK, sum: analysis.sum.sum }, { fromK: 1, toK: 2, sum: 27 })
  const path = [13.5, 14]
  assert.equal(checkGoal(base(), levelUp, path).satisfied, true)
  assert.equal(smaSteps(base(), path, 3)[1].direction, 'flat', 'T+2 slope is flat while its level is above the anchor')
  assert.equal(checkGoal(base(), { kind: 'level', period: 3, bar: 2, relation: 'flat' }, [13, 14]).satisfied, true)
}

// Representative paths are examples under named assumptions, include a failing
// comparison, and are never presented when the exact constraint is impossible.
{
  const fb = { ...base(), horizon: 3 }
  const goal: SolverGoal = { kind: 'direction', period: 3, bar: 1, direction: 'down' }
  const analysis = analyzeSolverGoal(fb, goal, NO_CONSTRAINTS)
  for (const assumption of ['hold', 'constant', 'linear', 'geometric'] as const) {
    const path = representativePath(fb, analysis, assumption, 0.5)
    assert.equal(path.status, 'found', `${assumption}: representative path found`)
    assert.equal(path.check?.satisfied, true, `${assumption}: path meets the exact goal`)
    if (path.failing) assert.equal(path.failing.check.satisfied, false, `${assumption}: failing comparison really fails`)
  }
  const impossible = analyzeSolverGoal(fb, goal, { min: 13, max: 13, tick: 1 })
  assert.equal(impossible.status, 'infeasible')
  assert.equal(representativePath(fb, impossible, 'hold', 1).status, 'skipped')
}

// Security/date identity changes discard drafts; matching identity preserves them.
{
  const first = freshSimulationState('JP|6098|2026-10-16')
  first.scenarios['1D|2026-10-16'] = { unit: 'price', inputs: ['100'] }
  assert.equal(scopeSimulationState(first, first.identity), first)
  const next = scopeSimulationState(first, 'US|AAPL|2026-10-16')
  assert.deepEqual(next.scenarios, {})
  assert.notEqual(next, first)
}

// Domain sanity: positivity remains enforced even without explicit constraints.
assert.equal(priceDomain(NO_CONSTRAINTS).loOpen, true)
assert.equal(checkGoal(base(), { kind: 'direction', period: 3, bar: 1, direction: 'down' }, [-1], priceDomain(NO_CONSTRAINTS)).inDomain, false)

// Exhaustive small-grid oracle: symbolic feasibility must agree with concrete
// enumeration for every goal family, including K > N relative constraints.
{
  const fb = { ...base(), horizon: 4 }
  const constraints = { min: 11, max: 15, tick: 1 }
  const domain = priceDomain(constraints)
  const values = [11, 12, 13, 14, 15]
  const paths: number[][] = []
  for (const a of values) for (const b of values) for (const c of values) for (const d of values) paths.push([a, b, c, d])
  const goals: SolverGoal[] = []
  for (const direction of ['up', 'flat', 'down'] as const) {
    for (let bar = 1; bar <= 4; bar += 1) goals.push({ kind: 'direction', period: 3, bar, direction })
    for (let through = 1; through <= 4; through += 1) goals.push({ kind: 'maintain', period: 3, through, direction })
    for (let bar = 1; bar <= 4; bar += 1) goals.push({ kind: 'level', period: 3, bar, relation: direction })
    for (let within = 1; within <= 4; within += 1) goals.push({ kind: 'within', period: 3, within, direction })
  }
  for (const to of ['up', 'down'] as const) {
    for (let within = 1; within <= 4; within += 1) goals.push({ kind: 'reversal', period: 3, within, to })
  }
  for (const goal of goals) {
    const symbolic = analyzeSolverGoal(fb, goal, constraints)
    const concrete = paths.some((path) => {
      const check = checkGoal(fb, goal, path, domain)
      return check.satisfied && check.inDomain
    })
    assert.equal(symbolic.status === 'feasible', concrete, `symbolic feasibility agrees: ${JSON.stringify(goal)} (${symbolic.status}/${symbolic.issue})`)
  }
}

console.log('SMA Dynamics Phase 2 scenario and inverse-solver tests passed.')
