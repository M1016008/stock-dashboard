import assert from 'node:assert/strict'
import { STRONG_LEVEL_CD, e039StatesAt, monthEnds, rankingScore, riskOutcome, scoreGroup } from '@/lib/research/six-stage-ranking-risk'
import { assertOutputDirectory, selectTickerEvents } from './analyze-six-stage-transitions-prereg'
import { RESULT_ROOT_CD } from './analyze-six-stage-ranking-risk-prereg'

assert.equal(STRONG_LEVEL_CD, 0.996875)

// 研究 C の点数: |5 日騰落率| × min(出来高倍率, 5)。20 日平均出来高はシグナル日を含めない。
const bars: { close: number; volume: number | null }[] = Array.from({ length: 21 }, () => ({ close: 100, volume: 300_000 }))
bars[15] = { close: 80, volume: 300_000 }      // 5 行前
bars[20] = { close: 100, volume: 3_000_000 }   // シグナル日 (出来高倍率 10 → 5 で頭打ち)
const noGap = () => 0
const metrics = rankingScore(bars, 20, noGap, 10)
assert.ok(!('excluded' in metrics))
if (!('excluded' in metrics)) {
  assert.equal(metrics.return5, 0.25)
  assert.equal(metrics.volumeRatio, 10)
  assert.equal(metrics.score, 0.25 * 5)
  assert.equal(metrics.averageVolume20, 300_000)
  assert.equal(metrics.belowFloor, false)
  assert.equal(metrics.turnover20, (19 * 100 * 300_000 + 80 * 300_000) / 20)
}
// 除外は事前登録の順: 20 行に満たない → 終値 → 出来高 → 空白 → 20 日平均出来高が 0。
assert.deepEqual(rankingScore(bars, 19, noGap, 10), { excluded: 'fewerThan20Rows' })
assert.deepEqual(rankingScore(bars.map((b, i) => (i === 15 ? { ...b, close: 0 } : b)), 20, noGap, 10), { excluded: 'invalidClose' })
assert.deepEqual(rankingScore(bars.map((b, i) => (i === 3 ? { ...b, volume: null } : b)), 20, noGap, 10), { excluded: 'invalidVolume' })
assert.deepEqual(rankingScore(bars.map((b, i) => (i === 0 ? { ...b, volume: -1 } : b)), 20, noGap, 10), { excluded: 'invalidVolume' })
assert.deepEqual(rankingScore(bars, 20, (i) => (i === 19 ? 11 : 0), 10), { excluded: 'gap' })     // 1 行前とシグナル日の間
assert.ok(!('excluded' in rankingScore(bars, 20, (i) => (i === 20 ? 11 : 0), 10)))                  // シグナル日の後は見ない
assert.deepEqual(rankingScore(bars.map((b, i) => (i < 20 ? { ...b, volume: 0 } : b)), 20, noGap, 10), { excluded: 'zeroAverageVolume' })
const small = rankingScore(bars.map((b) => ({ ...b, volume: 199_999 })), 20, noGap, 10)
assert.ok(!('excluded' in small) && small.belowFloor)

// 群: 80% 点以上が上位、20% 点以下が下位。
assert.deepEqual([0.1, 0.2, 0.5, 0.8, 0.9].map((s) => scoreGroup(s, { p20: 0.2, p80: 0.8 })), [0, 0, 1, 2, 2])

// 研究 D: (a) 1〜h 行目の安値の最小 ÷ 基準 − 1、(b) 日々の騰落率の標本標準偏差。
const risk = [{ high: 100, low: 100, close: 100 }, { high: 110, low: 90, close: 110 }, { high: 99, low: 95, close: 99 }]
const outcome = riskOutcome(risk, 0, 2)!
assert.ok(Math.abs(outcome.drawdown - -0.1) < 1e-12)
const r = [0.1, 99 / 110 - 1]; const mean = (r[0] + r[1]) / 2
assert.ok(Math.abs(outcome.stdev - Math.sqrt(((r[0] - mean) ** 2 + (r[1] - mean) ** 2) / 1)) < 1e-12)
assert.equal(riskOutcome(risk, 0, 3), null)                                          // h 行目が無い
assert.equal(riskOutcome([risk[0], { ...risk[1], low: 0 }, risk[2]], 0, 2), null)     // 安値が 0
assert.ok(riskOutcome(risk, 0, 2)!.drawdown < 0)

// 月末の日。
assert.deepEqual(monthEnds(['2020-01-30', '2020-01-31', '2020-02-03', '2020-02-28', '2020-03-02']), ['2020-01-31', '2020-02-28', '2020-03-02'])

// E039 だけで決まる状態: X>Y のイベントの前の dwell_b 行は X。区間の最後の状態 (次の変化が無い) と、区間の切れ目の行は決まらない。
const events = [
  { sequenceKey: '111111>211111', signalRow: 10, dwellB: 4 },   // 行 6〜9 は 111111 (区間の初めから)
  { sequenceKey: '211111>111111', signalRow: 15, dwellB: 5 },   // 行 10〜14 は 211111
  { sequenceKey: '111111>112111', signalRow: 30, dwellB: 3 },   // 行 16 で区間が切れ、行 27〜29 は 111111 (行 15 からの 111111 は決まらない)
]
const states = e039StatesAt(events, [5, 6, 9, 12, 15, 20, 28, 30, 31])
assert.deepEqual([...states].sort((a, b) => a[0] - b[0]), [[6, '111111'], [9, '111111'], [12, '211111'], [28, '111111']])

// 重複の規則を外すと、20 行以内の同じ遷移も残る (売買代金の基準の金額を決めるときだけ使う)。
const prices = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100 }))
const calendarIndex = new Map(prices.map((bar, i) => [bar.date, i]))
const twin = [{ length: 2, sequenceKey: '111111>211111', signalDate: prices[1].date, dwellB: 3 }, { length: 2, sequenceKey: '111111>211111', signalDate: prices[5].date, dwellB: 3 }]
assert.equal(selectTickerEvents(prices, twin, calendarIndex, () => {}).length, 1)
assert.equal(selectTickerEvents(prices, twin, calendarIndex, () => {}, false).length, 2)

// 書き出し先は研究 C・D の専用フォルダか一時フォルダだけ。
assert.throws(() => assertOutputDirectory('/Users/yoshio/Documents/x', RESULT_ROOT_CD))
assert.throws(() => assertOutputDirectory('relative/dir', RESULT_ROOT_CD))
console.log('six-stage ranking-risk tests passed')
