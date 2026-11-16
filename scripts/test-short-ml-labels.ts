import assert from 'node:assert/strict'
import { calculateStageFromThreeMa } from '@/lib/stage-classification'
import { TARGETS, labelCode, labelTarget, onMarket, rebuild, resample, sma, states, weekKey, type RawBar } from '@/lib/research/short-ml-labels'

const target = (id: string) => TARGETS.find((t) => t.id === id)!
type S = { state: number | null; g1?: number | null; g2?: number | null; row?: boolean; gone?: boolean }
const steps = (list: S[]) => list.map((s) => ({ state: s.state, g1: s.g1 ?? null, g2: s.g2 ?? null, row: s.row ?? true, gone: s.gone ?? false }))
const days = (n: number) => Array.from({ length: n }, (_, i) => `d${String(i).padStart(2, '0')}`)
const run = (id: string, list: S[]) => labelTarget('X', target(id), steps(list), days(list.length), list.length - 1)

// First hit, any path: 1 → 2 → 3 within 10 counts; the decision step needs a row and a state in `from`.
const path = [1, 2, 2, 3, 2, 3, 4, 4, 4, 4, 4, 4].map((state) => ({ state }))
const t1a = run('T1a', path)
assert.deepEqual(t1a.filter((l) => l.date === 'd00').map((l) => [l.label, l.hitOffset, l.labelEnd]), [[1, 3, 'd10']])
assert.equal(run('T1a', [{ state: 1, row: false }, ...path.slice(1)]).some((l) => l.date === 'd00'), false)
// A window past the boundary is censored (no label): 12 steps, horizon 10 → decisions only at d00 and d01.
assert.deepEqual(t1a.map((l) => l.date), ['d00', 'd01'])
// T3: the first arrival at 3 must come straight from 2. 1 → 3 directly (skipping 2) is "not reached".
assert.equal(run('T3', [{ state: 1 }, { state: 3 }, { state: 2 }, { state: 3 }, ...Array(8).fill({ state: 3 })])[0].label, 0)
assert.deepEqual(run('T3', [{ state: 2 }, { state: 3 }, ...Array(10).fill({ state: 4 })]).map((l) => [l.date, l.label, l.hitOffset]), [['d00', 1, 1]])
// A tie step (state null) inside the window is "not the destination" and counting continues.
assert.equal(run('T2a', [{ state: 3 }, { state: null }, { state: 4 }, ...Array(8).fill({ state: 4 })])[0].hitOffset, 2)
// Delisting: steps after the last row are gone and never the destination.
const gone = run('T1a', [{ state: 1 }, { state: 1 }, ...Array(9).fill({ state: null, row: false, gone: true })])
assert.deepEqual([gone[0].label, gone[0].delistedInWindow], [0, true])
// T2b: five steps in 4 with both gaps not narrowing; a missing row or a narrowing gap gives 0.
const widen = [{ state: 4, g1: 0.01, g2: 0.02 }, ...[1, 2, 3, 4, 5].map((k) => ({ state: 4, g1: 0.01 + k / 1000, g2: 0.02 }))]
assert.deepEqual(run('T2b', widen).map((l) => [l.label, l.hitOffset]), [[1, 5]])
assert.equal(run('T2b', widen.map((s, i) => (i === 3 ? { ...s, g2: 0.019 } : s)))[0].label, 0)
assert.equal(run('T2b', widen.map((s, i) => (i === 2 ? { ...s, row: false } : s)))[0].label, 0)
// T2c: 3 or 4 with g1 not narrowing (g2 not needed).
assert.equal(run('T2c', [{ state: 3, g1: 0.01 }, { state: 3, g1: 0.01 }, { state: 4, g1: 0.02, g2: -1 }, { state: 4, g1: 0.03 }, { state: 3, g1: 0.03 }, { state: 4, g1: 0.04 }])[0].label, 1)

// onMarket: a missing step keeps the state (suspension); a delisted code is gone after its last trading day.
const laid = onMarket({ keys: ['a', 'c'], c: [1, 1] }, [[1, 1], [1, 1], [1, 1]], [2, 3], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'c')
assert.deepEqual(laid.map((s) => [s.state, s.row, s.gone]), [[2, true, false], [2, false, false], [3, true, false], [null, false, true]])
assert.deepEqual(onMarket({ keys: ['a', 'b'], c: [1, 1] }, [[1, 1], [1, 1], [1, 1]], [2, null], ['a', 'b'], ['a', 'b'], null, true).map((s) => s.state), [2, 2])
// A step without a row is never the destination, even with a carried state.
assert.equal(run('T2a', [{ state: 3 }, { state: 4, row: false }, ...Array(9).fill({ state: 3 })])[0].label, 0)

// Rebuilding: one series x(s) = raw / C(s) gives the same states as rebuilding the history on every day d with factors ≤ d.
const raw: RawBar[] = []
let price = 1000
for (let i = 0; i < 160; i += 1) {
  price *= 1 + Math.sin(i / 7) / 40
  const split = i === 90 ? 0.5 : 1
  if (split !== 1) price *= split
  raw.push({ date: `2020-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, o: price, h: price, l: price, c: price, vo: 100, f: split })
}
const series = rebuild(raw)
const fast = states(series.c, [5, 25, 75]).state
for (const d of [80, 90, 91, 120, 159]) {
  const asOf = raw.slice(0, d + 1).map((r) => r.c!).map((c, s) => c * raw.slice(s + 1, d + 1).reduce((p, r) => p * r.f!, 1))
  const [a, b, c] = [5, 25, 75].map((p) => sma(asOf, p)[d])
  assert.equal(fast[d], calculateStageFromThreeMa(a, b, c), `state on day ${d}`)
}
assert.ok(Math.abs(series.c[90] / series.c[89] - (raw[90].c! / (raw[89].c! * 0.5))) < 1e-12, 'returns across the split are continuous')
assert.throws(() => rebuild([{ ...raw[0], f: null }]), /ADJ_FACTOR_MISSING/)
assert.equal(rebuild([{ ...raw[0], c: null }]).dates.length, 0)   // no trade: not a row of the series
// Weekly bars: Monday-start weeks; open first, close last.
const week = resample({ dates: ['2022-11-21', '2022-11-25', '2022-11-28'], o: [1, 2, 3], h: [5, 6, 7], l: [1, 1, 1], c: [4, 5, 6], v: [1, 1, 1] }, weekKey)
assert.deepEqual([week.keys, week.o, week.c, week.h], [['2022-11-21', '2022-11-28'], [1, 3], [5, 6], [6, 7]])

// End to end on real weekdays (2016-01 .. 2020-12), a long rise and fall so weekly and monthly states move.
const weekdays: string[] = []
for (let d = new Date('2016-01-04T00:00:00Z'); d <= new Date('2020-12-31T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() % 6 !== 0) weekdays.push(d.toISOString().slice(0, 10))
}
const wave: RawBar[] = weekdays.map((date, i) => { const p = 1000 * (1.6 + Math.sin(i / 90)); return { date, o: p, h: p, l: p, c: p, vo: 100, f: 1 } })
const nextDay = (day: string) => weekdays[weekdays.indexOf(day) + 1]
const lastDay = '2020-06-17'   // a Wednesday: its week and month are cut by the boundary
const labels = labelCode('1301', wave, weekdays, lastDay, false)
for (const [id, key, horizon] of [['T4w', weekKey, 4], ['T4m', (d: string) => d.slice(0, 7), 2]] as const) {
  const list = labels.filter((l) => l.target === id)
  assert.ok(list.length > 5 && list.some((l) => l.label === 1) && list.some((l) => l.label === 0), `${id} has both outcomes`)
  for (const l of list) {
    assert.notEqual(key(nextDay(l.date)), key(l.date), `${id} decides only at the last market day of a step`)
    assert.ok(l.labelEnd < '2020-06-01' || id === 'T4w', `${id} never uses the cut month`)
    assert.ok(key(l.labelEnd) !== key(lastDay) && l.labelEnd <= lastDay, `${id} never uses the cut step`)
    const ends = weekdays.filter((d) => key(nextDay(d) ?? '2099-12-31') !== key(d))
    assert.equal(ends[ends.indexOf(l.date) + horizon], l.labelEnd, `${id} window is ${horizon} steps`)
  }
}
assert.ok(['T1a', 'T1b', 'T2a', 'T3'].every((id) => labels.some((l) => l.target === id)))
// Delisted on a Wednesday: that week is gone (no decision there, never the destination); a window over it is marked.
// (Without delisting, the 2018-11-09 decision reaches 3/4 in its third week; delisted on 2018-11-21 it does not.)
assert.deepEqual(labelCode('1301', wave, weekdays, '2020-12-30', false).filter((l) => l.target === 'T4w' && l.date === '2018-11-09').map((l) => l.label), [1])
const delisted = labelCode('1301', wave.filter((r) => r.date <= '2018-11-21'), weekdays, '2020-12-30', true)
const weekly = delisted.filter((l) => l.target === 'T4w')
assert.ok(weekly.every((l) => l.date < '2018-11-19'))
assert.deepEqual(weekly.filter((l) => l.date === '2018-11-09').map((l) => [l.label, l.delistedInWindow]), [[0, true]])
assert.ok(delisted.filter((l) => l.target === 'T1a').every((l) => l.date <= '2018-11-21'))
assert.deepEqual(labelCode('9999', [], weekdays, lastDay, false), [])   // no rows, no labels
console.log('short-ml-labels tests passed')
