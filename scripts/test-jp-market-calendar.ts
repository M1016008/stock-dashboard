import assert from 'node:assert/strict'
import { getJpTradingDates, isJpMarketTradingDate, jpMarketClosureReason } from '@/lib/server/jp-market-calendar'

// The six weekday holidays the calendar used to miss (found by the J-Quants re-fetch, 2026-11-16).
for (const date of ['2016-12-23', '2018-12-24', '2019-04-30', '2019-05-01', '2019-05-02', '2019-10-22']) {
  assert.equal(jpMarketClosureReason(date), 'Japanese national holiday', date)
}
// The Emperor's Birthday (Dec 23, 1989-2018) also closes 2008-2015 and its first years; 1988 had none.
for (const date of ['1990-12-24', '1991-12-23', '2008-12-23', '2011-12-23', '2012-12-24', '2015-12-23']) {
  assert.equal(jpMarketClosureReason(date), 'Japanese national holiday', date)
}
assert.ok(isJpMarketTradingDate('1988-12-23'))
// Their neighbours stay trading days, and the Emperor's Birthday moved: no Dec 23 holiday from 2019.
for (const date of ['2016-12-22', '2016-12-26', '2018-12-21', '2018-12-25', '2019-04-26', '2019-05-07',
  '2019-10-21', '2019-10-23', '2019-12-23', '2021-12-23', '2026-12-23']) {
  assert.ok(isJpMarketTradingDate(date), date)
}
// The 2019 Golden Week ran from Apr 27 to May 6 with no trading day.
assert.deepEqual(getJpTradingDates('2019-04-26', '2019-05-07'), ['2019-04-26', '2019-05-07'])
// Rules already in place keep working (Feb 23 from 2020 with its substitute day, the 2020/2021 Olympic moves).
assert.equal(jpMarketClosureReason('2020-02-24'), 'Japanese national holiday')
assert.ok(isJpMarketTradingDate('2020-10-12'))
assert.equal(jpMarketClosureReason('2021-07-22'), 'Japanese national holiday')
console.log('jp-market-calendar tests passed')
