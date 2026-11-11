import assert from 'node:assert/strict'
import { evaluateEventPricePath, type EventPriceBar } from '@/lib/research/six-stage-event-path-research'
import {
  RESULT_ROOT,
  assertOutputDirectory,
  interpolated,
  permutationBaseline,
  previousMonth,
  selectTickerEvents,
  type EventInput,
  type Summary,
} from './analyze-six-stage-transitions-prereg'

// 営業日 60 日の市場の暦と、その銘柄の株価 (終値 100, 101, 102, ...)。
const calendar = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2015, 0, 5 + i)).toISOString().slice(0, 10))
const calendarIndex = new Map(calendar.map((date, i) => [date, i]))
const bar = (date: string, close: number): EventPriceBar => ({ date, open: close - 0.5, high: close + 1, low: close - 1, close })
const bars = calendar.map((date, i) => bar(date, 100 + i))

// 終値で買う: 買値は翌営業日の終値、1 日目はその次の行。
const evaluation = evaluateEventPricePath(bars, 0, 'NEXT_CLOSE')
assert.equal(evaluation.entryPrice, 101)
assert.equal(evaluation.dailyExcursions[0].closeReturn, 102 / 101 - 1)
const h5 = evaluation.completedHorizons.find((row) => row.horizonSessions === 5)!
assert.equal(h5.closeReturn, 106 / 101 - 1)
assert.equal(h5.mfe, 107 / 101 - 1)
assert.equal(h5.highestDay, 5)
// 既定 (始値で買う) は変わらない。
assert.equal(evaluateEventPricePath(bars, 0).entryOpen, 100.5)
assert.equal(evaluateEventPricePath(bars, 0).entryPrice, undefined)

const counts: Record<string, number> = {}
const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
const event = (signalDate: string, sequenceKey: string): EventInput => ({ length: sequenceKey.split('>').length, sequenceKey, signalDate, dwellB: 3 })

// 重複: 同じ型・同じ遷移の中で 20 行以内は 2 件目を数えない。別の型・遷移は消さない。
const kept = selectTickerEvents(bars, [
  event(calendar[0], '111111>211111>111111'),
  event(calendar[5], '111111>311111>111111'),   // 同じ X→Y→X 型、5 行後 → 数えない
  event(calendar[5], '111111>211111>311111'),   // X→Y→Z 型 → 数える
  event(calendar[21], '111111>411111>111111'),  // 21 行後 → 数える
  event(calendar[3], '111111>211111'),          // 研究 2
  event(calendar[10], '111111>211111'),         // 同じ遷移、7 行後 → 数えない
  event(calendar[10], '211111>311111'),         // 別の遷移 → 数える
], calendarIndex, bump)
assert.deepEqual(kept.map((row) => `${row.groupKey}@${row.signalRow}`).sort(),
  ['111111>211111@3', '211111>311111@10', 'XYX@0', 'XYX@21', 'XYZ@5'].sort())
assert.equal(counts['s1.dedupDropped'], 1)
assert.equal(counts['s2.dedupDropped'], 1)

// 空白: 買う日までの空白と、買った日から 20 行後までの空白 (10 営業日を超える) は除く。除外が重複より先。
const gapped = [...bars.slice(0, 3), ...bars.slice(14)]  // 行 2 と 3 の間に 11 営業日の空白
const gapCounts: Record<string, number> = {}
const gapKept = selectTickerEvents(gapped, [
  event(gapped[2].date, '111111>211111'),   // 買う日 (行 3) までに空白 → 除く
  event(gapped[0].date, '211111>311111'),   // 結果の期間に空白 → 除く
  event(gapped[3].date, '111111>211111'),   // 空白の後 → 数える (除外が先なので重複にならない)
], calendarIndex, (key) => { gapCounts[key] = (gapCounts[key] ?? 0) + 1 })
assert.equal(gapCounts['s2.excludedEntryGap'], 1)
assert.equal(gapCounts['s2.excludedOutcomeGap'], 1)
assert.deepEqual(gapKept.map((row) => row.signalRow), [3])

// 区分は前月末、分位点は既存コードと同じ線形補間。
assert.equal(previousMonth('2017-01-16'), '2016-12')
assert.equal(previousMonth('2017-03-01'), '2017-02')
assert.equal(interpolated([1, 2, 3, 4], 0.5), 2.5)
assert.equal(interpolated([1, 2, 3, 4], 0.9), 3.7)

// 偶然との比較: 同じ入力・同じ種なら同じ結果。結びつきが強いほど期待値を上回る。
const summary = (median: number, win: number): Summary => ({ n: 100, winLong: win, winShort: 1 - win, mean: median, median,
  q10: 0, q25: 0, q75: 0, q90: 0, mfeMedian: 0, mfeQ90: 0, mfeMax: 0, maeMedian: 0, hiDayMedian: 0, loDayMedian: 0 })
const explore = Array.from({ length: 40 }, (_, i) => summary(i < 10 ? 0.02 : -0.01, i < 10 ? 0.6 : 0.4))
const confirm = Array.from({ length: 40 }, (_, i) => summary(i < 10 ? 0.01 : -0.01, i < 10 ? 0.55 : 0.4))
const first = permutationBaseline(explore, confirm, 'LONG', 10)
assert.deepEqual(first, permutationBaseline(explore, confirm, 'LONG', 10))
assert.ok(first.expected > 1 && first.expected < 4)
assert.ok(first.probabilityAtLeastObserved < 0.01)

// 出力先: 研究フォルダの専用フォルダか OWC の外だけ。封印 C の入力のフォルダは拒む。
assert.equal(assertOutputDirectory(`${RESULT_ROOT}/run-1`), `${RESULT_ROOT}/run-1`)
assert.equal(assertOutputDirectory('/private/tmp/x'), '/private/tmp/x')
assert.throws(() => assertOutputDirectory('/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage/v5/E039-JP-scale-consistent-phase1b0-foundation'))
assert.throws(() => assertOutputDirectory(`${RESULT_ROOT}/../v5`))
assert.throws(() => assertOutputDirectory('relative/dir'))

console.log('six-stage transitions prereg tests: PASS')
