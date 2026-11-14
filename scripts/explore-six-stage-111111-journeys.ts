// 探索「111111 からの旅」(2026-11-13 オーナー承認の計画)。判定 (差がある・ない) はしない。
// 日本株・Discovery (〜2022-12-30)。読み取りはすべて immutable、書き込みは出力フォルダだけ (write-once)。
//
// 6 桁の状態は、Discovery の元データから今の計算 (buildSnapshotCalculations) で日ごとに作り直し、
// E039 の「状態が変わった」記録 (length=2 ENTRY) と銘柄ごとに完全に一致することを確かめてから使う。1 件でも違えば止める。
// 作り直す理由: E039 には途切れのない区間 (block) の終わりの日が無く、戻らずに終わった旅の終わりの日と理由が分からないため。
//
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx scripts/explore-six-stage-111111-journeys.ts analyze --out=<dir>
//   npx tsx scripts/explore-six-stage-111111-journeys.ts render --out=<dir>
import fs from 'node:fs'
import path from 'node:path'
import { SIX_STAGE_REAL_RESEARCH_ROOT } from '@/lib/research/six-stage-real-data-contract'
import { EVENT_PATH_DISCOVERY_CUTOFF } from '@/lib/research/six-stage-event-path-research'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import {
  GAP_LIMIT, SPLIT_EXCLUDED, assertInputs, assertOutputDirectory, interpolated, loadCalendar, openImmutable, writeOnce,
} from './analyze-six-stage-transitions-prereg'
import { renderJourneysReport } from './lib/six-stage-journeys-report'

const FOUNDATION = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5', 'E039-JP-scale-consistent-phase1b0-foundation')
const EVENTS_PATH = path.join(FOUNDATION, 'events.sqlite')
const SOURCE_PATH = path.join(SIX_STAGE_REAL_RESEARCH_ROOT,
  'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete', 'jp-discovery-ohlcv.sqlite')
const RESULT_ROOT = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'explore-111111-journeys-20261113')
const HOME = '111111'
const PATH_DAYS = 60         // 型ごとの値動きを描く日数 (出た日 = 0)
const STEPS = 4              // 流れの図の歩数
const MIN_BRANCH_SHARE = 0.01
const TOP_TYPES = 20
const KM_MAX_DAYS = 750
const DAY_BINS = [1, 2, 3, 5, 10, 20, 40, 60, 120, 250] as const   // 上限 (この値以下)。最後の棚は 251 日以上
const QS = [0.1, 0.25, 0.5, 0.75, 0.9] as const
type Outcome = 'RETURNED' | 'BREAK' | 'DATA_END' | 'TRADING_END'
type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number }
type Journey = { outcome: Outcome; days: number; states: string[]; worstCount: number; worstCode: string;
  maxDrawdown: number | null; returnAtBack: number | null; path: number[]; exitDate: string }

const outputDirectory = () => assertOutputDirectory(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? '', RESULT_ROOT)
const round = (value: number) => Math.round(value * 1e5) / 1e5
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0

// 分位点 (線形補間) の要約。0 件は { n: 0 }。
function quantiles(values: number[]): { n: number; q10?: number; q25?: number; q50?: number; q75?: number; q90?: number } {
  if (values.length === 0) return { n: 0 }
  const sorted = Float64Array.from(values).sort()
  const [q10, q25, q50, q75, q90] = QS.map((p) => round(interpolated(sorted, p)))
  return { n: values.length, q10, q25, q50, q75, q90 }
}

// 日ごとの 6 桁 (決まらない日・値段が正しくない日は null)。E039 (V5 census) と同じ決め方。
function stageCodes(bars: readonly Bar[]): (string | null)[] {
  const byDate = new Map(buildSnapshotCalculations(bars as never, { includeWarmup: true }).map((row) => [row.date, row]))
  return bars.map((bar) => {
    const row = byDate.get(bar.date)
    if (!row || ![bar.open, bar.high, bar.low, bar.close].every(positive)) return null
    const code = [row.daily_a_stage, row.daily_b_stage, row.weekly_a_stage, row.weekly_b_stage, row.monthly_a_stage, row.monthly_b_stage].join('')
    return /^[1-6]{6}$/.test(code) ? code : null
  })
}

// 連続した日の並び [from..to] を、同じ状態ごとにまとめる。
function collapse(codes: readonly (string | null)[], from: number, to: number): string[] {
  const out: string[] = []
  for (let i = from; i <= to; i += 1) if (codes[i] !== out.at(-1)) out.push(codes[i]!)
  return out
}

function analyzeTicker(bars: readonly Bar[], codes: readonly (string | null)[], hasGap: (a: number, b: number) => boolean,
  dailyA: Map<string, { n: number; days: number[]; returns: number[] }>, journeys: Journey[], counts: Record<string, number>): void {
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const last = bars.length - 1
  for (let s = 0; s <= last; s += 1) {
    if (codes[s] == null) continue
    let e = s
    while (e < last && codes[e + 1] != null) e += 1
    // ① 日A の桁だけの滞在と遷移。
    let p = s
    for (let i = s + 1; i <= e; i += 1) {
      if (codes[i]![0] === codes[i - 1]![0]) continue
      const key = `${codes[i - 1]![0]}>${codes[i]![0]}`
      if (hasGap(p, i)) bump('dailyA.excludedGap')
      else {
        const edge = dailyA.get(key) ?? { n: 0, days: [], returns: [] }
        edge.n += 1
        if (p === s) bump('dailyA.leftCensoredStays')
        else { edge.days.push(i - p); edge.returns.push(bars[i].close / bars[p].close - 1) }
        dailyA.set(key, edge)
      }
      p = i
    }
    // ② 111111 を出た日 (i) から、同じ区間の中で初めて 111111 に戻った日 (j) まで。
    for (let i = s + 1; i <= e; i += 1) {
      if (!(codes[i - 1] === HOME && codes[i] !== HOME)) continue
      let j = i + 1
      while (j <= e && codes[j] !== HOME) j += 1
      const returned = j <= e
      const end = returned ? j : e
      const outcome: Outcome = returned ? 'RETURNED' : e < last ? 'BREAK' : bars[e].date === EVENT_PATH_DISCOVERY_CUTOFF ? 'DATA_END' : 'TRADING_END'
      if (hasGap(i - 1, end)) { bump(`journeys.excludedGap.${outcome}`); i = end; continue }
      const lastState = returned ? j - 1 : e
      let worstCount = -1; let worstCode = ''
      for (let k = i; k <= lastState; k += 1) {
        const fours = [...codes[k]!].filter((digit) => digit === '4').length
        if (fours > worstCount) { worstCount = fours; worstCode = codes[k]! }
      }
      const base = bars[i].close
      let low = Infinity
      for (let k = i + 1; k <= end; k += 1) low = Math.min(low, bars[k].low)
      const pricePath: number[] = []
      for (let d = 0; d <= PATH_DAYS && i + d <= last && positive(bars[i + d].close) && !hasGap(i, i + d); d += 1) pricePath.push(bars[i + d].close / base - 1)
      journeys.push({ outcome, days: end - i, states: collapse(codes, i, lastState), worstCount, worstCode,
        maxDrawdown: Number.isFinite(low) ? low / base - 1 : null, returnAtBack: returned ? bars[j].close / base - 1 : null,
        path: pricePath, exitDate: bars[i].date })
      i = end
    }
    s = e
  }
}

// 型: 途中の状態が 6 個以上なら、最初の 3 つ → …(省いた数)… → 最後の 2 つ。
function journeyType(states: readonly string[]): string {
  return (states.length > 5 ? [...states.slice(0, 3), `…(${states.length - 5})…`, ...states.slice(-2)] : states).join('→')
}

function pathBands(paths: readonly number[][]): { n: number[]; q25: number[]; q50: number[]; q75: number[] } {
  const bands = { n: [] as number[], q25: [] as number[], q50: [] as number[], q75: [] as number[] }
  for (let d = 0; d <= PATH_DAYS; d += 1) {
    const sorted = Float64Array.from(paths.filter((p) => p.length > d).map((p) => p[d])).sort()
    bands.n.push(sorted.length)
    for (const [key, p] of [['q25', 0.25], ['q50', 0.5], ['q75', 0.75]] as const) bands[key].push(sorted.length ? round(interpolated(sorted, p)) : NaN)
  }
  return bands
}

// 戻らずに終わった旅も入れた「まだ戻っていない割合」(Kaplan–Meier)。日数 t は出た日からの売買の日数。
function kaplanMeier(all: readonly Journey[]): { t: number[]; survival: number[]; atRisk: number[] } {
  const out = { t: [] as number[], survival: [] as number[], atRisk: [] as number[] }
  const times = Float64Array.from(all.map((j) => j.days)).sort()
  const events = new Map<number, number>()
  for (const j of all) if (j.outcome === 'RETURNED') events.set(j.days, (events.get(j.days) ?? 0) + 1)
  let survival = 1; let k = 0
  for (let t = 1; t <= KM_MAX_DAYS; t += 1) {
    while (k < times.length && times[k] < t) k += 1
    const atRisk = times.length - k
    if (atRisk === 0) break
    survival *= 1 - (events.get(t) ?? 0) / atRisk
    out.t.push(t); out.survival.push(round(survival)); out.atRisk.push(atRisk)
  }
  return out
}

// 出た後の 1〜4 歩目。戻った・終わった旅はそこで止める。各歩で 1% 未満の状態は「その他」(終わりの印はまとめない)。
function sankey(all: readonly Journey[]): { steps: Record<string, number>[]; links: [number, string, string, number][] } {
  const terminal: Record<Outcome, string> = { RETURNED: '戻った', BREAK: '途切れ', DATA_END: 'データの終わり', TRADING_END: '売買の終わり' }
  const routes = all.map((j) => {
    const route = [HOME, ...j.states.slice(0, STEPS)]
    if (j.states.length < STEPS) route.push(terminal[j.outcome])
    return route
  })
  const steps: Record<string, number>[] = []
  for (let k = 1; k <= STEPS; k += 1) {
    const raw: Record<string, number> = {}
    for (const route of routes) if (route[k] != null) raw[route[k]] = (raw[route[k]] ?? 0) + 1
    const keep = (node: string) => !/^[1-6]{6}$/.test(node) || raw[node] / all.length >= MIN_BRANCH_SHARE
    for (const route of routes) if (route[k] != null && !keep(route[k])) route[k] = 'その他'
    const merged: Record<string, number> = {}
    for (const route of routes) if (route[k] != null) merged[route[k]] = (merged[route[k]] ?? 0) + 1
    steps.push(merged)
  }
  const links = new Map<string, number>()
  for (const route of routes) for (let k = 1; k < route.length && k <= STEPS; k += 1) {
    const key = `${k - 1}\t${route[k - 1]}\t${route[k]}`
    links.set(key, (links.get(key) ?? 0) + 1)
  }
  return { steps, links: [...links].map(([key, n]) => { const [k, from, to] = key.split('\t'); return [Number(k), from, to, n] }) }
}

function summarizeJourneys(journeys: Journey[]) {
  const returned = journeys.filter((j) => j.outcome === 'RETURNED')
  const outcomes = Object.fromEntries((['RETURNED', 'BREAK', 'DATA_END', 'TRADING_END'] as const).map((o) => [o, journeys.filter((j) => j.outcome === o).length]))
  const histogram = [...DAY_BINS, Infinity].map((upper, b) => returned.filter((j) => j.days <= upper && (b === 0 || j.days > DAY_BINS[b - 1])).length)
  const worst = (list: Journey[]) => [0, 1, 2, 3, 4, 5, 6].map((c) => list.filter((j) => j.worstCount === c).length)
  const worstCodes = new Map<string, number>()
  for (const j of journeys) worstCodes.set(j.worstCode, (worstCodes.get(j.worstCode) ?? 0) + 1)
  const drawdowns = (list: Journey[]) => quantiles(list.flatMap((j) => (j.maxDrawdown == null ? [] : [j.maxDrawdown])))
  const types = new Map<string, Journey[]>()
  for (const j of returned) { const key = journeyType(j.states); if (!types.has(key)) types.set(key, []); types.get(key)!.push(j) }
  const topTypes = [...types].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_TYPES)
  const byYear: Record<string, number> = {}
  for (const j of journeys) byYear[j.exitDate.slice(0, 4)] = (byYear[j.exitDate.slice(0, 4)] ?? 0) + 1
  return {
    total: journeys.length, outcomes, byYear,
    firstExit: journeys.reduce((m, j) => (j.exitDate < m ? j.exitDate : m), '9999'),
    lastExit: journeys.reduce((m, j) => (j.exitDate > m ? j.exitDate : m), ''),
    daysToReturn: { quantiles: quantiles(returned.map((j) => j.days)), bins: DAY_BINS, histogram },
    kaplanMeier: kaplanMeier(journeys),
    worst: { all: worst(journeys), returned: worst(returned),
      top: [...worstCodes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10) },
    maxDrawdown: { returned: drawdowns(returned), notReturned: drawdowns(journeys.filter((j) => j.outcome !== 'RETURNED')), all: drawdowns(journeys) },
    returnAtBack: quantiles(returned.map((j) => j.returnAtBack!)),
    types: { distinct: types.size, coveredByTop: topTypes.reduce((n, [, list]) => n + list.length, 0),
      top: topTypes.map(([key, list]) => ({ key, n: list.length, days: quantiles(list.map((j) => j.days)),
        returnAtBack: quantiles(list.map((j) => j.returnAtBack!)), path: pathBands(list.map((j) => j.path)) })) },
    paths: { returned: pathBands(returned.map((j) => j.path)), all: pathBands(journeys.map((j) => j.path)) },
    sankey: sankey(journeys),
  }
}

async function analyze(out: string): Promise<void> {
  const inputs = assertInputs()
  const foundation = JSON.parse(fs.readFileSync(path.join(FOUNDATION, 'manifest.json'), 'utf8'))
  const source = openImmutable(SOURCE_PATH)
  const eventsDb = openImmutable(EVENTS_PATH)
  const calendar = loadCalendar(source)
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]))
  const tickers = source.prepare('SELECT DISTINCT ticker FROM ohlcv_daily WHERE date<=? ORDER BY ticker').all(EVENT_PATH_DISCOVERY_CUTOFF).map((row) => String(row.ticker))
  if (tickers.length !== foundation.processedTickers) throw new Error(`ticker count ${tickers.length} != E039 ${foundation.processedTickers}`)
  const prices = source.prepare('SELECT date,open,high,low,close,volume FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date')
  const entries = eventsDb.prepare(`SELECT block_id,sequence_key,signal_date FROM events WHERE ticker=? AND event_type='ENTRY' AND length=2 ORDER BY regime_id_c`)
  const check = { rows: 0, validStageRows: 0, validBlocks: 0, regimes: 0, stateChanges: 0 }
  const counts: Record<string, number> = {}
  const dailyA = new Map<string, { n: number; days: number[]; returns: number[] }>()
  const journeys: Journey[] = []
  for (const ticker of tickers) {
    const bars = prices.all(ticker, EVENT_PATH_DISCOVERY_CUTOFF) as unknown as Bar[]
    const codes = stageCodes(bars)
    // E039 と同じ数え方で、状態の変化 (区間の番号・6 桁・日付) を作り、E039 の記録と突き合わせる。
    const changes: string[] = []
    let block = 0
    check.rows += bars.length
    codes.forEach((code, i) => {
      if (code == null) { block += 1; return }
      check.validStageRows += 1
      if (i === 0 || codes[i - 1] == null) { check.validBlocks += 1; check.regimes += 1 }
      else if (codes[i - 1] !== code) { check.regimes += 1; check.stateChanges += 1; changes.push(`${block}|${codes[i - 1]}>${code}|${bars[i].date}`) }
    })
    const recorded = entries.all(ticker).map((row) => `${row.block_id}|${row.sequence_key}|${row.signal_date}`)
    if (recorded.length !== changes.length || recorded.some((key, i) => key !== changes[i])) {
      const at = recorded.findIndex((key, i) => key !== changes[i])
      throw new Error(`E039 mismatch ${ticker}: recomputed ${changes.length}, recorded ${recorded.length}, first difference ${changes[at]} vs ${recorded[at]}`)
    }
    if (SPLIT_EXCLUDED.has(ticker)) { counts.excludedSplitTickers = (counts.excludedSplitTickers ?? 0) + 1; continue }
    const gapBefore = new Int32Array(bars.length)   // gapBefore[k] = 行 0..k の間の、10 営業日を超える空白の数
    for (let k = 1; k < bars.length; k += 1) {
      gapBefore[k] = gapBefore[k - 1] + (calendarIndex.get(bars[k].date)! - calendarIndex.get(bars[k - 1].date)! - 1 > GAP_LIMIT ? 1 : 0)
    }
    analyzeTicker(bars, codes, (a, b) => gapBefore[b] - gapBefore[a] > 0, dailyA, journeys, counts)
  }
  const expected = foundation.diagnostics
  for (const key of Object.keys(check) as (keyof typeof check)[]) {
    if (check[key] !== expected[key]) throw new Error(`E039 diagnostics mismatch ${key}: recomputed ${check[key]} vs ${expected[key]}`)
  }
  const result = {
    kind: 'EXPLORATION', title: '111111 からの旅 (探索)', market: 'JP', cutoff: EVENT_PATH_DISCOVERY_CUTOFF,
    inputs: { ...inputs, foundationManifest: path.join(FOUNDATION, 'manifest.json') },
    verification: { ...check, tickers: tickers.length, note: '日ごとの 6 桁を作り直し、E039 の状態の変化 (区間の番号・6 桁・日付) と全銘柄で完全に一致した。件数も E039 の記録と一致した。' },
    rules: { gapLimitBusinessDays: GAP_LIMIT, pathDays: PATH_DAYS, steps: STEPS, minBranchShare: MIN_BRANCH_SHARE, topTypes: TOP_TYPES, kmMaxDays: KM_MAX_DAYS },
    counts,
    dailyA: [...dailyA].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, edge]) => {
      const days = quantiles(edge.days)
      return { key, n: edge.n, measured: edge.days.length, meanDays: edge.days.length ? round(edge.days.reduce((a, b) => a + b, 0) / edge.days.length) : null,
        medianDays: days.q50 ?? null, medianReturn: quantiles(edge.returns).q50 ?? null }
    }),
    journeys: summarizeJourneys(journeys),
  }
  fs.mkdirSync(out, { recursive: true })
  writeOnce(path.join(out, 'result.json'), `${JSON.stringify(result)}\n`)
  console.log(`journeys ${journeys.length}, returned ${result.journeys.outcomes.RETURNED}, dailyA edges ${result.dailyA.length}`)
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  const out = outputDirectory()
  if (command === 'analyze') await analyze(out)
  else if (command === 'render') {
    const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'))
    writeOnce(path.join(out, 'report.html'), renderJourneysReport(result))
  } else throw new Error('usage: analyze|render --out=<dir>')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
