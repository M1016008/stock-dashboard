import assert from 'node:assert/strict'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'

const usCases = [
  ['Saturday after EOD ready', '2026-07-25T04:00:00.000Z', '2026-07-24'],
  ['Saturday before EOD ready', '2026-07-24T20:00:00.000Z', '2026-07-23'],
  ['Monday after EOD ready', '2026-07-27T00:00:00.000Z', '2026-07-24'],
  ['Monday before EOD ready', '2026-07-26T20:00:00.000Z', '2026-07-24'],
  ['Tuesday after EOD ready', '2026-07-27T22:00:00.000Z', '2026-07-27'],
  ['US Good Friday', '2026-04-04T00:00:00.000Z', '2026-04-02'],
  ['US Independence Day observed', '2026-07-04T00:00:00.000Z', '2026-07-02'],
  ['US Thanksgiving', '2026-11-27T00:00:00.000Z', '2026-11-25'],
  ['US Juneteenth', '2026-06-20T00:00:00.000Z', '2026-06-18'],
] as const

for (const [name, input, expected] of usCases) {
  assert.equal(expectedLatestUsTradingDate(new Date(input)), expected, name)
}

const jpCases = [
  ['JP business day after ready', '2026-07-24T08:00:00.000Z', '2026-07-24'],
  ['JP business day before ready', '2026-07-23T22:00:00.000Z', '2026-07-23'],
  ['JP Marine Day after ready', '2026-07-20T08:00:00.000Z', '2026-07-17'],
  ['JP substitute holiday after ready', '2026-05-06T08:00:00.000Z', '2026-05-01'],
  ['JP Saturday', '2026-07-25T04:00:00.000Z', '2026-07-24'],
] as const

for (const [name, input, expected] of jpCases) {
  assert.equal(expectedLatestTradingDate(new Date(input)), expected, name)
}

console.log(`data freshness date tests passed: ${usCases.length + jpCases.length}`)
