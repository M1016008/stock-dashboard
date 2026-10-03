import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DAILY_CLOSE_REPORT_TYPE,
  DAILY_CLOSE_REPORT_VERSION,
  aggregateClassifications60,
  aggregateSectorRotation,
  isValidReportDate,
  median,
  percentage,
  sortTopBottom,
  stageChanges,
  watchlistChangeReasons,
  type ClassificationInput,
  type StageSet,
} from '@/lib/daily-close-report'

const root = process.cwd()
const viewSource = fs.readFileSync(path.join(root, 'components/reports/DailyCloseReportView.tsx'), 'utf8')
const clientSource = fs.readFileSync(path.join(root, 'components/reports/DailyCloseReportClient.tsx'), 'utf8')
const routeSource = fs.readFileSync(path.join(root, 'app/api/reports/daily-close/route.ts'), 'utf8')
const builderSource = fs.readFileSync(path.join(root, 'lib/server/daily-close-report.ts'), 'utf8')
const cssSource = fs.readFileSync(path.join(root, 'components/reports/daily-close-report.module.css'), 'utf8')

assert.equal(DAILY_CLOSE_REPORT_TYPE, 'STOCKBOARD_DAILY_CLOSE')
assert.equal(DAILY_CLOSE_REPORT_VERSION, 1)
assert.equal(median([]), null)
assert.equal(median([3, 1, 2]), 2)
assert.equal(median([4, 1, 3, 2]), 2.5)
assert.ok(Math.abs(percentage(110, 100)! - 10) < 1e-9)
assert.equal(percentage(100, 0), null)
assert.equal(isValidReportDate('2026-09-30'), true)
assert.equal(isValidReportDate('2024-02-29'), true)
assert.equal(isValidReportDate('2026-02-29'), false)
assert.equal(isValidReportDate('2026-99-99'), false)
assert.equal(isValidReportDate('2026-9-30'), false)

const fixture: ClassificationInput[] = Array.from({ length: 60 }, (_, index) => ({
  name: `分類${String(index + 1).padStart(2, '0')}`,
  return5: index - 20,
  return10: index - 25,
  return20: index - 30,
}))
fixture.push(
  { name: '分類01', return5: 3, return10: 4, return20: 5 },
  { name: '分類01', return5: -1, return10: 2, return20: null },
  { name: '分類01', return5: 2, return10: -2, return20: 1 },
  { name: '分類01', return5: null, return10: 6, return20: 3 },
  { name: '分類01', return5: 0, return10: 0, return20: -1 },
)

const classification = aggregateClassifications60(fixture)
assert.equal(classification.length, 60, '60分類fixture must produce exactly 60 groups')
const classification01 = classification.find((row) => row.name === '分類01')
assert.ok(classification01)
assert.equal(classification01.oneWeek.totalCount, 6)
assert.equal(classification01.oneWeek.eligibleCount, 5)
assert.equal(classification01.oneWeek.winnerCount, 2)
assert.equal(classification01.oneWeek.loserCount, 2)
assert.equal(classification01.oneWeek.winRate, 2 / 5)
assert.equal(classification01.oneWeek.medianReturn, 0)
assert.equal(classification01.oneWeek.lowSample, false)
assert.equal(classification.find((row) => row.name === '分類02')?.oneWeek.lowSample, true)
assert.ok(classification.every((row) => row.rank1W != null && row.rank2W != null && row.rank1M != null))

const ranked = sortTopBottom(classification, (row) => row.oneWeek.meanReturn, 3)
assert.equal(ranked.top.length, 3)
assert.equal(ranked.bottom.length, 3)
assert.ok(ranked.top[0].oneWeek.meanReturn! >= ranked.top[1].oneWeek.meanReturn!)
assert.ok(ranked.bottom[0].oneWeek.meanReturn! <= ranked.bottom[1].oneWeek.meanReturn!)

const sector = aggregateSectorRotation([
  { name: '機械', return1: 3, previousReturn1: 1, return5: 6 },
  { name: '機械', return1: 1, previousReturn1: 1, return5: 2 },
  { name: '銀行業', return1: -1, previousReturn1: 4, return5: 1 },
])
assert.equal(sector[0].name, '機械')
assert.equal(sector[0].return1D, 2)
assert.equal(sector[0].return5D, 4)
assert.equal(sector[0].rankChange, 1)

const previous: StageSet = { dayA: 4, dayB: 2, weekA: 5, weekB: 1, monthA: 3, monthB: null }
const current: StageSet = { dayA: 5, dayB: 1, weekA: 6, weekB: 2, monthA: 3, monthB: 1 }
assert.deepEqual(stageChanges(previous, current), ['日A S4→S5', '日B S2→S1', '週A S5→S6'])

const reasons = watchlistChangeReasons({
  dailyReturn: 3.25,
  volumeRatio: 2.4,
  previousStages: previous,
  stages: current,
}, { score: 72, previousScore: 64 })
assert.deepEqual(reasons, [
  '日A S4→S5', '日B S2→S1', '週A S5→S6',
  'Score 64→72', '出来高 2.4倍', '日次 +3.3%',
])
assert.deepEqual(watchlistChangeReasons({
  dailyReturn: 0.1,
  volumeRatio: null,
  previousStages: current,
  stages: current,
}), [])

assert.equal((viewSource.match(/<Page report=\{report\} number=\{/g) ?? []).length, 11)
for (const pageNumber of Array.from({ length: 11 }, (_, index) => index + 1)) {
  assert.match(viewSource, new RegExp(`number=\\{${pageNumber}\\}`))
}
assert.match(viewSource, /title="四季報60細分類 OVERVIEW"/)
assert.match(viewSource, /title="LARGE HOLDER & EVENTS"/)
assert.match(viewSource, /events\.earnings\.slice\(0, 12\)/)
assert.match(viewSource, /DATA DELAYED/)
assert.match(clientSource, /useWatchlistStore/)
assert.match(clientSource, /window\.print\(\)/)
assert.match(routeSource, /cache: 'no-store'|Cache-Control': 'private, no-store'/)
assert.match(builderSource, /getRankingSnapshot\(\)/)
assert.match(builderSource, /snapshot\.priceDate === priceDate \? 'CURRENT' : 'DELAYED'/)
assert.doesNotMatch(builderSource, /sendMail|gmail|nodemailer/i)
assert.doesNotMatch(clientSource, /sendMail|gmail|nodemailer/i)
assert.match(cssSource, /@page\s*\{[\s\S]*?size:\s*A4 landscape;/)
assert.match(cssSource, /break-after:\s*page;/)
assert.match(cssSource, /\.tableScroll\s*\{[\s\S]*?overflow-x:\s*auto;/)

async function main() {
  if (process.env.STOCKBOARD_DB_PATH) {
    const { buildDailyCloseReport } = await import('@/lib/server/daily-close-report')
    const { execAll } = await import('@/lib/db/client')
    const report = await buildDailyCloseReport({ requestedDate: process.env.DAILY_CLOSE_REPORT_TEST_DATE ?? null, watchlistTickers: ['7003', '7203'] })
    assert.equal(report.reportType, DAILY_CLOSE_REPORT_TYPE)
    assert.equal(report.version, DAILY_CLOSE_REPORT_VERSION)
    assert.match(report.reportDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(report.priceDate, report.reportDate)
    assert.equal(report.classifications60.length, 60)
    assert.equal(report.sectors33.length, 33)
    assert.equal(report.sectors33.some((row) => row.name === 'その他'), false)
    assert.ok(report.trigger.candidateCount >= report.trigger.currentCounts.NEAR + report.trigger.currentCounts.IN_ZONE)
    assert.equal(Object.keys(report.takeaways).length, 11)
    assert.ok(report.market.advances + report.market.declines + report.market.unchanged > 4_000)
    assert.ok(report.generationMs > 0)

    type RawClassificationRow = {
      name: string
      close0: number | null
      close5: number | null
      close10: number | null
      close20: number | null
    }
    const rawRows = await execAll<RawClassificationRow>(`
      WITH recent_dates AS (
        SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) rn
        FROM (SELECT DISTINCT date FROM ohlcv_daily WHERE date <= ? ORDER BY date DESC LIMIT 21)
      ), prices AS (
        SELECT o.ticker,d.rn,o.close
        FROM ohlcv_daily o JOIN recent_dates d ON d.date=o.date
      ), pivot AS (
        SELECT ticker,
          MAX(CASE WHEN rn=1 THEN close END) close0,
          MAX(CASE WHEN rn=6 THEN close END) close5,
          MAX(CASE WHEN rn=11 THEN close END) close10,
          MAX(CASE WHEN rn=21 THEN close END) close20
        FROM prices GROUP BY ticker
      )
      SELECT sc.major_category name,p.close0,p.close5,p.close10,p.close20
      FROM pivot p JOIN stock_classification sc ON sc.ticker=p.ticker
      WHERE sc.major_category IS NOT NULL AND sc.major_category<>'' AND p.close0 IS NOT NULL
    `, [report.priceDate])
    const grouped = new Map<string, RawClassificationRow[]>()
    for (const row of rawRows) grouped.set(row.name, [...(grouped.get(row.name) ?? []), row])
    assert.equal(grouped.size, 60)
    const manualMetric = (rows: RawClassificationRow[], base: 'close5' | 'close10' | 'close20') => {
      const values = rows.flatMap((row) => row[base] != null && row[base] !== 0 && row.close0 != null
        ? [(row.close0 / row[base] - 1) * 100] : [])
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return {
        meanReturn: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        medianReturn: values.length ? (values.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
        winnerCount: values.filter((value) => value > 0).length,
        loserCount: values.filter((value) => value < 0).length,
        eligibleCount: values.length,
        totalCount: rows.length,
        winRate: values.length ? values.filter((value) => value > 0).length / values.length : null,
      }
    }
    const closeEnough = (actual: number | null, expected: number | null, label: string) => {
      if (actual == null || expected == null) assert.equal(actual, expected, label)
      else assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`)
    }
    for (const row of report.classifications60) {
      const source = grouped.get(row.name)
      assert.ok(source, `missing independent source for ${row.name}`)
      for (const [period, base] of [['oneWeek', 'close5'], ['twoWeek', 'close10'], ['oneMonth', 'close20']] as const) {
        const expected = manualMetric(source, base)
        const actual = row[period]
        closeEnough(actual.meanReturn, expected.meanReturn, `${row.name} ${period} mean`)
        closeEnough(actual.medianReturn, expected.medianReturn, `${row.name} ${period} median`)
        closeEnough(actual.winRate, expected.winRate, `${row.name} ${period} winRate`)
        assert.equal(actual.winnerCount, expected.winnerCount, `${row.name} ${period} winners`)
        assert.equal(actual.loserCount, expected.loserCount, `${row.name} ${period} losers`)
        assert.equal(actual.eligibleCount, expected.eligibleCount, `${row.name} ${period} eligible`)
        assert.equal(actual.totalCount, expected.totalCount, `${row.name} ${period} total`)
      }
    }
    await assert.rejects(() => buildDailyCloseReport({ requestedDate: '2026-99-99' }), /invalid_report_date/)
    if (!process.env.DAILY_CLOSE_REPORT_TEST_DATE) {
      const weekend = await buildDailyCloseReport({ requestedDate: '2026-09-27', watchlistTickers: [] })
      assert.equal(weekend.requestedDate, '2026-09-27')
      assert.equal(weekend.reportDate, '2026-09-25')
      assert.equal(weekend.priceDate, '2026-09-25')
      assert.equal(weekend.derivedDate, '2026-09-25')
    }
    console.log(JSON.stringify({
      reportDate: report.reportDate,
      derivedDate: report.derivedDate,
      classifications60: report.classifications60.length,
      stocks: report.market.advances + report.market.declines + report.market.unchanged,
      triggerStatus: report.dataStatus.trigger,
      largeHolderStatus: report.dataStatus.largeHolder,
      independentlyVerifiedClassificationMetrics: report.classifications60.length * 3,
      generationMs: report.generationMs,
    }, null, 2))
  }

  console.log('daily close report tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
