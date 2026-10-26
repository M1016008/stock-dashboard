import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isUsEarningsDate } from '../lib/queries/us-earnings'

const root = process.cwd()
const route = fs.readFileSync(path.join(root, 'app/api/us/earnings-calendar/route.ts'), 'utf8')
const page = fs.readFileSync(path.join(root, 'app/us/earnings/page.tsx'), 'utf8')
const query = fs.readFileSync(path.join(root, 'lib/queries/us-earnings.ts'), 'utf8')

assert.equal(isUsEarningsDate('2026-10-27'), true)
assert.equal(isUsEarningsDate('2026-02-30'), false)
assert.equal(isUsEarningsDate('2026-1-02'), false)
assert.match(route, /invalid_us_earnings_query/)
assert.match(route, /status === 'unavailable' \? 503 : 200/)
assert.match(route, /cache-control': 'private, no-store'/)
assert.match(query, /e\.source = 'finnhub'/)
assert.match(query, /推定日による補完は行いません/)
assert.match(query, /LEFT JOIN market_universe/)
assert.match(page, /StockBoardによる予測ではありません/)
assert.match(page, /href=\{`\/us\/stock\//)
assert.doesNotMatch(page, /J-Quants|JPX公式/)

console.log('US earnings calendar contract tests: PASS')
