import { calculateStageFromThreeMa } from '@/lib/stage-classification'
import { calendarWeekStart } from '@/lib/timeframes'

// Labels for the short-side transition ML (PLAN_SHORT_TRANSITION_ML_20261116.md, sections 2 and 5).
//
// Prices: J-Quants Adj* values are not used. With C(s) = product of AdjFactor(e) for e ≤ s, the price of day s as seen on day d
// is raw(s) × C(d) / C(s). Every quantity used here (the order of moving averages, gap ÷ close, returns) is a ratio taken on one
// day d, so the common C(d) cancels and the single series x(s) = raw(s) / C(s) gives the same answer as rebuilding the history
// on each day d. x(s) only uses factors up to s, so nothing after s is read. Volume is the mirror image: vo(s) × C(s).

export type RawBar = { date: string; o: number | null; h: number | null; l: number | null; c: number | null; vo: number | null; f: number | null }
export type Series = { dates: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

/** Traded rows (close present) as x(s) = raw(s) / C(s). A missing or non-positive AdjFactor stops (the quality gate checks it too). */
export function rebuild(rows: RawBar[]): Series {
  const out: Series = { dates: [], o: [], h: [], l: [], c: [], v: [] }
  let cumulative = 1
  for (const row of rows) {
    if (row.f === null || !(row.f > 0)) throw new Error(`ADJ_FACTOR_MISSING:${row.date}`)
    cumulative *= row.f
    if (row.c === null) continue
    out.dates.push(row.date)
    out.o.push(row.o! / cumulative); out.h.push(row.h! / cumulative); out.l.push(row.l! / cumulative); out.c.push(row.c / cumulative)
    out.v.push((row.vo ?? 0) * cumulative)
  }
  return out
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  values.forEach((value, i) => {
    sum += value
    if (i >= period) sum -= values[i - period]
    out.push(i >= period - 1 ? sum / period : null)
  })
  return out
}

/** Bars of a series grouped by key (weekly: Monday of the week; monthly: YYYY-MM). Open = first, close = last. */
export function resample(series: Series, key: (date: string) => string): Series & { keys: string[] } {
  const out: Series & { keys: string[] } = { keys: [], dates: [], o: [], h: [], l: [], c: [], v: [] }
  series.dates.forEach((date, i) => {
    const k = key(date)
    const last = out.keys.length - 1
    if (out.keys[last] !== k) {
      out.keys.push(k); out.dates.push(date); out.o.push(series.o[i]); out.h.push(series.h[i]); out.l.push(series.l[i]); out.c.push(series.c[i]); out.v.push(series.v[i])
    } else {
      out.dates[last] = date; out.h[last] = Math.max(out.h[last], series.h[i]); out.l[last] = Math.min(out.l[last], series.l[i])
      out.c[last] = series.c[i]; out.v[last] += series.v[i]
    }
  })
  return out
}
export const weekKey = calendarWeekStart
export const monthKey = (date: string) => date.slice(0, 7)

/** States (1..6, or null when undetermined: warm-up or a tie) and the three moving averages. */
export function states(closes: number[], periods: readonly [number, number, number]) {
  const [a, b, c] = periods.map((p) => sma(closes, p))
  return { state: closes.map((_, i) => calculateStageFromThreeMa(a[i], b[i], c[i])), ma: [a, b, c] as const }
}

export type Target = { id: string; frame: 'D' | 'W' | 'M'; from: readonly number[]; horizon: number; kind: 'hit' | 'direct23' | 'widen4' | 'widen34'; to?: readonly number[] }
export const TARGETS: readonly Target[] = [
  { id: 'T1a', frame: 'D', from: [1, 2, 6], to: [3], horizon: 10, kind: 'hit' },
  { id: 'T1b', frame: 'D', from: [1, 2, 6], to: [4], horizon: 20, kind: 'hit' },
  { id: 'T2a', frame: 'D', from: [3], to: [4], horizon: 10, kind: 'hit' },
  { id: 'T2b', frame: 'D', from: [4], horizon: 5, kind: 'widen4' },
  { id: 'T2c', frame: 'D', from: [3], horizon: 5, kind: 'widen34' },
  { id: 'T3', frame: 'D', from: [1, 2], horizon: 10, kind: 'direct23' },
  { id: 'T4w', frame: 'W', from: [1, 2, 6], to: [3, 4], horizon: 4, kind: 'hit' },
  { id: 'T4m', frame: 'M', from: [1, 2, 6], to: [3, 4], horizon: 2, kind: 'hit' },
]
export const PERIODS = { D: [5, 25, 75], W: [5, 13, 25], M: [3, 5, 10] } as const

/** One step of the market calendar for a code: its state, the two gaps, and whether it had a row (traded) on that step. */
type Step = { state: number | null; g1: number | null; g2: number | null; row: boolean; gone: boolean }
export type Label = { code: string; date: string; target: string; label: 0 | 1; hitOffset: number | null; labelEnd: string; delistedInWindow: boolean }

/**
 * Lays a code's bars on the market steps (trading days, or the market's weeks/months). A step without a row keeps the last state
 * (suspension = no change). For a delisted code, every step that ends after its last trading day is "gone": never a decision and
 * never the destination (a week or month that the delisting cuts is not a completed bar).
 * carryTies (research-only variant): a tie row keeps the previous state instead of being undetermined.
 */
export function onMarket(code: { keys: string[]; c: number[] }, ma: readonly (number | null)[][], state: (number | null)[], marketKeys: string[],
  stepEnd: string[], lastTrade: string | null, carryTies = false): Step[] {
  const index = new Map(code.keys.map((k, i) => [k, i]))
  let current: number | null = null
  return marketKeys.map((k, step) => {
    if (lastTrade !== null && stepEnd[step] > lastTrade) return { state: null, g1: null, g2: null, row: false, gone: true }
    const i = index.get(k)
    if (i === undefined) return { state: current, g1: null, g2: null, row: false, gone: false }
    current = state[i] ?? (carryTies ? current : null)
    const gap = (hi: number | null, lo: number | null) => (hi === null || lo === null ? null : (hi - lo) / code.c[i])
    return { state: current, g1: gap(ma[1][i], ma[0][i]), g2: gap(ma[2][i], ma[1][i]), row: true, gone: false }
  })
}

/**
 * Labels for one code and one target on the market steps. Decision steps are those where the code has a row and a determined
 * state in `from`. The window is the next `horizon` steps; a window that goes past `lastStep` (the data or fold boundary) is censored
 * (no label). `stepEnd` gives the last trading day of each step (the day itself for daily steps).
 */
export function labelTarget(code: string, target: Target, steps: Step[], stepEnd: string[], lastStep: number): Label[] {
  const out: Label[] = []
  for (let t = 0; t + target.horizon <= lastStep; t += 1) {
    const now = steps[t]
    if (!now.row || now.state === null || !target.from.includes(now.state)) continue
    const window = steps.slice(t + 1, t + 1 + target.horizon)
    let hit: number | null = null
    if (target.kind === 'hit') {
      const j = window.findIndex((s) => s.row && s.state !== null && target.to!.includes(s.state))
      hit = j < 0 ? null : j
    } else if (target.kind === 'direct23') {
      // The first arrival at 3 counts only when the step before it was 2 (the step before the first window step is t itself).
      const j = window.findIndex((s) => s.row && s.state === 3)
      const before = j <= 0 ? now : window[j - 1]
      hit = j >= 0 && before.state === 2 ? j : null
    } else {
      // Every step must have a row, stay in the allowed states, and keep the gaps from narrowing (a missing gap fails).
      let previous = now
      const allowed = target.kind === 'widen4' ? [4] : [3, 4]
      const ok = window.every((s) => {
        const pass = s.row && s.state !== null && allowed.includes(s.state) && s.g1 !== null && previous.g1 !== null && s.g1 >= previous.g1
          && (target.kind === 'widen34' || (s.g2 !== null && previous.g2 !== null && s.g2 >= previous.g2))
        previous = s
        return pass
      })
      hit = ok ? target.horizon - 1 : null
    }
    out.push({ code, date: stepEnd[t], target: target.id, label: hit === null ? 0 : 1, hitOffset: hit === null ? null : hit + 1,
      labelEnd: stepEnd[t + target.horizon], delistedInWindow: window.some((s) => s.gone) })
  }
  return out
}

/**
 * All targets for one code. marketDays: the market's trading days from the fixed exchange calendar, going past the boundary
 * `lastDay`; only the first day after lastDay is used, to know whether lastDay ends its week or month (no prices are read after it).
 * Without a day after lastDay, the last week and month are taken as not complete.
 * Weekly and monthly decision days are the last market day of each step, so only completed bars are used.
 * delisted: the code's last row is its delisting, confirmed by the month-end listings. When it cannot be confirmed, the caller
 * passes the code's last row as lastDay instead, so the windows after it are censored.
 */
export function labelCode(code: string, rows: RawBar[], marketDays: string[], lastDay: string, delisted: boolean, carryTies = false): Label[] {
  const series = rebuild(rows.filter((r) => r.date <= lastDay))
  const lastTrade = delisted ? series.dates.at(-1) ?? null : null
  const out: Label[] = []
  for (const frame of ['D', 'W', 'M'] as const) {
    const key = frame === 'D' ? (d: string) => d : frame === 'W' ? weekKey : monthKey
    const bars = frame === 'D' ? { ...series, keys: series.dates } : resample(series, key)
    const { state, ma } = states(bars.c, PERIODS[frame])
    const marketKeys: string[] = [], stepEnd: string[] = []
    for (const day of marketDays) {
      if (day > lastDay) break
      const k = key(day)
      if (marketKeys.at(-1) === k) stepEnd[stepEnd.length - 1] = day
      else { marketKeys.push(k); stepEnd.push(day) }
    }
    const steps = onMarket(bars, ma as unknown as (number | null)[][], state, marketKeys, stepEnd, lastTrade, carryTies)
    // A week or month that the boundary cuts is not complete, so it is never a decision step nor counted.
    const next = marketDays.find((day) => day > lastDay)
    const complete = frame !== 'D' && (next === undefined || key(next) === marketKeys.at(-1)) ? marketKeys.length - 2 : marketKeys.length - 1
    for (const target of TARGETS.filter((x) => x.frame === frame)) out.push(...labelTarget(code, target, steps, stepEnd, complete))
  }
  return out
}
