import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  evaluateUsEarningsCoverage,
  isUsEarningsDate,
  usEarningsScheduleStatus,
} from '../lib/queries/us-earnings'

const root = process.cwd()
const route = fs.readFileSync(path.join(root, 'app/api/us/earnings-calendar/route.ts'), 'utf8')
const page = fs.readFileSync(path.join(root, 'app/us/earnings/page.tsx'), 'utf8')
const query = fs.readFileSync(path.join(root, 'lib/queries/us-earnings.ts'), 'utf8')

assert.equal(isUsEarningsDate('2026-10-27'), true)
assert.equal(isUsEarningsDate('2026-02-30'), false)
assert.equal(isUsEarningsDate('2026-1-02'), false)
assert.equal(usEarningsScheduleStatus(null, null), 'provider_scheduled_unverified')
assert.equal(usEarningsScheduleStatus(1.23, null), 'reported')
assert.equal(usEarningsScheduleStatus(null, 1_000_000), 'reported')
const now = 2_000_000
assert.deepEqual(evaluateUsEarningsCoverage({
  fromDate: '2026-01-01', toDate: '2026-12-31', finishedAt: now - 60,
}, { from: '2026-06-01', to: '2026-06-30' }, now, 7), { ok: true, reason: 'ready' })
assert.equal(evaluateUsEarningsCoverage({
  fromDate: '2026-06-15', toDate: '2026-12-31', finishedAt: now - 60,
}, { from: '2026-06-01', to: '2026-06-30' }, now, 7).reason, 'range_uncovered')
assert.equal(evaluateUsEarningsCoverage({
  fromDate: '2026-01-01', toDate: '2026-12-31', finishedAt: now - 8 * 86_400,
}, { from: '2026-06-01', to: '2026-06-30' }, now, 7).reason, 'stale')
assert.match(route, /invalid_us_earnings_query/)
assert.match(route, /status === 'unavailable' \? 503 : 200/)
assert.match(route, /cache-control': 'private, no-store'/)
assert.match(query, /e\.source = 'finnhub'/)
assert.match(query, /推定日による補完は行いません/)
assert.match(query, /provider_scheduled_unverified/)
assert.match(query, /scheduledDate/)
assert.match(query, /actualReportDate/)
assert.match(query, /range_uncovered/)
assert.match(query, /unavailableReason: coverageStatus\.reason/)
assert.match(query, /unavailableReason: 'read_failed'/)
assert.match(query, /LEFT JOIN market_universe/)
assert.match(query, /getNextUsEarnings[\s\S]*to: addCalendarDays\(today, 180\)/)
assert.match(page, /StockBoardによる予測ではありません/)
assert.match(page, /UNAVAILABLE_REASON_COPY/)
assert.match(page, /同期範囲を確認して再読み込みしてください/)
assert.match(page, /href=\{`\/us\/stock\//)
assert.doesNotMatch(page, /J-Quants|JPX公式/)

console.log('US earnings calendar contract tests: PASS')
