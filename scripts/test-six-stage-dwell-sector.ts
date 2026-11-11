import assert from 'node:assert/strict'
import type { EventPriceBar } from '@/lib/research/six-stage-event-path-research'
import {
  MIN_SECTOR_MEMBERS, STRONG_LEVEL, dwellClass, envelope, evidenceLevel, sectorStrength, sortedMedian, transitionGroup,
} from '@/lib/research/six-stage-dwell-sector'
import { bootstrapCohortDifferences, compareTransitionCohorts, quantile, type TransitionComparisonRecord } from '@/lib/research/six-stage-statistics'
import { RESULT_ROOT_AB, twentyDayReturns } from './analyze-six-stage-dwell-sector-prereg'
import { assertOutputDirectory } from './analyze-six-stage-transitions-prereg'
import { renderDwellSectorReport } from './lib/six-stage-dwell-sector-report'

// 遷移の全体の判定: 変化した桁がすべて改善 / すべて悪化 / それ以外は混在。変化しない桁は数えない。
assert.equal(transitionGroup('211111>111111').group, 'IMPROVE')        // 2→1 改善
assert.equal(transitionGroup('211141>111151').group, 'IMPROVE')        // 2→1、4→5 ともに改善
assert.equal(transitionGroup('111111>211111').group, 'DETERIORATE')    // 1→2 悪化
assert.equal(transitionGroup('211111>112111').group, 'MIXED')          // 改善と悪化
assert.deepEqual(transitionGroup('011111>111111'), { group: 'INVALID', invalidDigits: 1 })
assert.deepEqual(transitionGroup('011112>111111'), { group: 'IMPROVE', invalidDigits: 1 })  // 判定できる桁 (2→1 改善) だけで分類

// 滞在日数の 3 群の境目。
assert.deepEqual([1, 5, 6, 19, 20, 400].map(dwellClass), [0, 0, 1, 1, 2, 2])
assert.throws(() => dwellClass(0))

// 中央値 (線形補間) と、1 つ除いた中央値。
assert.equal(sortedMedian([1, 2, 3, 4]), 2.5)
assert.equal(sortedMedian([1, 2, 3, 4], 4), 2)
assert.equal(sortedMedian([1, 2, 2, 9], 2), 2)
assert.throws(() => sortedMedian([1, 2, 3], 5))

// 業種の強さ: 中央値の大きい順。自分の業種は自分を除く。5 銘柄未満の業種は順位から外す。同じ値は業種の並び順。
const sector = (key: string, values: number[]) => ({ key, sorted: Float32Array.from(values).sort() })
const day = [
  sector('A', [0.05, 0.05, 0.05, 0.05, 0.05, 0.5]),  // 自分 (0.5) を除くと中央値 0.05
  sector('B', [0.1, 0.1, 0.1, 0.1, 0.1]),
  sector('C', [0.05, 0.05, 0.05, 0.05, 0.05]),
  sector('D', [0, 0, 0, 0, 0]),
  sector('E', [-0.1, -0.1, -0.1, -0.1, -0.1]),
  sector('F', [-0.2, -0.2, -0.2, -0.2, -0.2]),
  sector('G', [1, 1, 1]),                              // 5 銘柄未満 → 順位に入れない
]
assert.equal(MIN_SECTOR_MEMBERS, 5)
assert.deepEqual(sectorStrength(day, 'A', Math.fround(0.5)), { strength: 0, rank: 2, ranked: 6 })  // B, A(同値で C より前), C ...
assert.deepEqual(sectorStrength(day, 'C', null), { strength: 1, rank: 3, ranked: 6 })
assert.deepEqual(sectorStrength(day, 'F', null), { strength: 2, rank: 6, ranked: 6 })
assert.deepEqual(sectorStrength(day, 'B', Math.fround(0.1)), { excluded: 'ownSectorTooSmall' })  // 自分を除くと 4 銘柄
assert.deepEqual(sectorStrength(day, 'Z', null), { excluded: 'ownSectorMissing' })

// 20 日騰落: 20 行に満たない日・10 営業日を超える空白を含む日は入れない。
const calendar = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2017, 0, 2 + i)).toISOString().slice(0, 10))
const calendarIndex = new Map(calendar.map((date, i) => [date, i]))
const bar = (date: string, close: number): EventPriceBar => ({ date, open: close, high: close, low: close, close })
const returns = new Map<number, number>()
twentyDayReturns(calendar.slice(0, 25).map((date, i) => bar(date, 100 + i)), calendarIndex, (d, v) => returns.set(d, v))
assert.deepEqual([...returns.keys()], [20, 21, 22, 23, 24])
assert.equal(returns.get(20), 120 / 100 - 1)
const gapped = new Map<number, number>()
twentyDayReturns([...calendar.slice(0, 10), ...calendar.slice(21)].map((date, i) => bar(date, 100 + i)), calendarIndex, (d, v) => gapped.set(d, v))
assert.equal(Math.min(...gapped.keys()), 41)  // 空白 (11 営業日) が 20 行の中に入る日は除く
assert.equal(gapped.size, 19)

// ブートストラップ: 中央値の差は研究 1 の区間と同じ乱数の使い方。勝率の差も同じ重みで出す。
const records: TransitionComparisonRecord[] = []
for (let i = 0; i < 400; i += 1) {
  records.push({ cohort: i % 2 ? 'H001' : 'C2', ticker: String(i % 37), signalDate: `20${10 + (i % 9)}-0${1 + (i % 9)}-15`,
    netReturn: (i % 2 ? 0.01 : -0.01) + ((i * 7919) % 101) / 1000 - 0.05 })
}
const comparison = compareTransitionCohorts({ records, iterations: 500, seed: 7, timeAxis: 'signalMonth' })
const byTicker = bootstrapCohortDifferences(records, 'ticker', 500, 7 ^ 0x5449434b)
assert.equal(comparison.tickerClusterBootstrap.lower95, quantile(byTicker.median, 0.025))
assert.equal(byTicker.winRate.length, byTicker.median.length)
const allWin = bootstrapCohortDifferences(records.map((row) => ({ ...row, netReturn: row.cohort === 'H001' ? 1 : -1 })), 'ticker', 200, 3)
assert.ok(allWin.winRate.every((value) => value === 1))

// 2 段階の判定と、2 つの分布を両方含む区間。
assert.ok(Math.abs(STRONG_LEVEL - 0.995833) < 1e-6)
assert.deepEqual(envelope([[1, 2, 3, 4, 5], [0, 1, 3, 6, 9]], 0.5), { lower: 1, upper: 6 })
const zero = { lower: -1, upper: 1 }; const positive = { lower: 0.1, upper: 1 }
assert.equal(evidenceLevel({ interval95: positive, intervalStrong: positive, blocksSameDirection: true }), 'STRONG')
assert.equal(evidenceLevel({ interval95: positive, intervalStrong: zero, blocksSameDirection: true }), 'WEAK')
assert.equal(evidenceLevel({ interval95: positive, intervalStrong: positive, blocksSameDirection: false }), 'NONE')
assert.equal(evidenceLevel({ interval95: zero, intervalStrong: zero, blocksSameDirection: true }), 'NONE')

// 出力は研究 A・B の専用フォルダか一時フォルダだけ。
assert.throws(() => assertOutputDirectory('/Users/yoshio/Desktop/x', RESULT_ROOT_AB))
assert.equal(assertOutputDirectory('/private/tmp/dwell-sector-test', RESULT_ROOT_AB), '/private/tmp/dwell-sector-test')

// 報告ページは結果を埋め込み、遷移ごとの数字は transitions/ から読む。
const html = renderDwellSectorReport({ counts: {}, hypotheses: [], note: '</script>' })
assert.match(html, /'transitions\/'\+sh\+'\.js'/)
assert.doesNotMatch(html, /<\/script>"/)

console.log('test-six-stage-dwell-sector: ok')
