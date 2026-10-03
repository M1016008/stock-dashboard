import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLASS_LABEL, EVENT_LABEL, RANKING_LABEL, date, positionUnits, unitFor, yen } from '@/lib/large-holders/ui'

const read = (path: string) => readFileSync(path, 'utf8')
const client = read('components/large-holders/LargeHoldersClient.tsx')
const detail = read('components/large-holders/InvestorDetailClient.tsx')
const shared = read('components/large-holders/LargeHoldersShared.tsx')
const rankingApi = read('app/api/large-holders/rankings/route.ts')
const activityApi = read('app/api/large-holders/activity/route.ts')
const overviewApi = read('app/api/large-holders/overview/route.ts')

for (const route of ['app/large-holders/page.tsx', 'app/large-holders/rankings/page.tsx',
  'app/large-holders/activity/page.tsx', 'app/large-holders/investors/[id]/page.tsx']) {
  assert.ok(read(route).length > 0, `${route} must exist`)
}
assert.ok(read('components/layout/navigation.ts').includes("label: '大口投資家'"))
assert.equal(RANKING_LABEL.TOTAL_VALUE, '推定時価保有総額')
assert.equal(CLASS_LABEL.UNCLASSIFIED, '未分類')
assert.equal(CLASS_LABEL.OTHER, 'その他')
assert.equal(EVENT_LABEL.EXIT_5PCT, 'EXIT')
assert.equal(yen(523_400_000_000), '5,234億円')
assert.equal(yen(null), '—')
assert.equal(date('2026-09-18'), '2026/09/18')
assert.equal(unitFor({ ticker: '3290', issuerName: 'Ｏｎｅリート投資法人' }), '口')
assert.equal(positionUnits(26_365, { ticker: '3290', issuerName: 'Ｏｎｅリート投資法人' }), '26,365口')
assert.equal(positionUnits(2_202_002, { ticker: '7203', issuerName: 'トヨタ自動車株式会社' }), '2,202,002株')
for (const term of ['investorClass', 'rankingType', 'basis', 'period', 'completeness', 'market',
  'industry17', 'industry33', 'pageSize', 'sort', 'search']) assert.ok(client.includes(term))
assert.ok(client.includes('MobileRankingList') && client.includes('MobileActivityList'))
assert.ok(client.includes('router.push('), 'filters must be reloadable URL state')
assert.ok(client.includes('controller.abort()'), 'obsolete requests must be aborted')
assert.ok(client.includes('setData(null)'), 'old rankings must not remain visible during reload')
assert.ok(shared.includes('certified_snapshot_stale') && shared.includes('certified_snapshot_missing'))
assert.ok(shared.includes('古い順位は表示しません'))
assert.ok(client.includes('運用権限に基づく推定時価') && detail.includes('所有等ベースと合算していません'))
assert.ok(detail.includes('filing.isCorrection ?'))
assert.ok(detail.includes('position.holdingBasis === basis'))
assert.ok(detail.includes('positionUnits(position.certifiedUnits ?? position.reportedShares, position)'))
assert.ok(rankingApi.includes('const search =') && rankingApi.includes('largestOnBasis'))
assert.ok(activityApi.includes('withinPeriod(event') && activityApi.includes('paginate(rows'))
assert.ok(overviewApi.includes('investorClassCounts') && overviewApi.includes('activityCounts'))
for (const source of [client, detail, shared]) {
  for (const forbidden of ['買付額', '売却額', '投資総額', '取得額', '自己保有額'])
    assert.ok(!source.includes(forbidden), `${forbidden} must not be a UI label`)
}
console.log('large-holder UI structure, terminology and unit regressions: PASS')
