import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  NAVIGATION_BY_AREA,
  PAGE_CATALOG,
  PAGE_CATALOG_ENTRIES,
  QUICK_COMMAND_PAGE_IDS_BY_AREA,
  type HeaderArea,
  type PageId,
} from '../components/layout/navigation'

const root = process.cwd()
const header = fs.readFileSync(path.join(root, 'components/layout/Header.tsx'), 'utf8')

function navPageIds(area: HeaderArea): PageId[] {
  return NAVIGATION_BY_AREA[area].flatMap((entry) => (
    entry.kind === 'link'
      ? [entry.pageId]
      : entry.sections.flatMap((section) => [...section.pageIds])
  ))
}

assert.deepEqual(
  NAVIGATION_BY_AREA.jp.map((entry) => entry.label),
  ['ホーム', '市場・業種', '銘柄探索', '分析・AI', '監視'],
  'JP navigation must keep the agreed five task categories.',
)
assert.deepEqual(
  NAVIGATION_BY_AREA.us.map((entry) => entry.label),
  ['ホーム', '銘柄探索', '分析・AI', '監視'],
  'US navigation must use the same task vocabulary without an empty market category.',
)
assert.deepEqual(
  NAVIGATION_BY_AREA.commodities.map((entry) => entry.label),
  ['ホーム', '銘柄探索'],
  'Commodity navigation must only expose relevant categories.',
)

for (const area of Object.keys(NAVIGATION_BY_AREA) as HeaderArea[]) {
  const pageIds = navPageIds(area)
  assert.equal(new Set(pageIds).size, pageIds.length, `${area} pages must have one primary navigation owner.`)
  for (const pageId of pageIds) assert.ok(PAGE_CATALOG[pageId], `${area}:${pageId} must exist in the page catalog.`)
  for (const pageId of QUICK_COMMAND_PAGE_IDS_BY_AREA[area]) {
    assert.ok(PAGE_CATALOG[pageId], `${area} quick command ${pageId} must exist in the page catalog.`)
  }
}

assert.equal(PAGE_CATALOG.marketMomentum.href, '/market-momentum')
assert.equal(PAGE_CATALOG.periodExplorer.href, '/period-explorer')
assert.equal(PAGE_CATALOG.sectorStructure.href, '/sectors?view=structure')
assert.equal(PAGE_CATALOG.historicalPatterns.href, '/ai/ma-lens#historical-pattern-search')
assert.equal(PAGE_CATALOG.usAiResearch.href, '/ai/research?market=US')
assert.equal(PAGE_CATALOG.usChartDrill.href, '/chart-drill?market=US')

assert.ok(navPageIds('jp').includes('sectors'), 'Industry analysis must remain under Market & Industry.')
assert.ok(navPageIds('jp').includes('periodExplorer'), 'Period Explorer must be available under stock discovery.')
assert.ok(navPageIds('jp').includes('hexStage'), 'Market-wide six-stage analysis must remain under Analysis & AI.')
assert.ok(navPageIds('jp').includes('ma25mMonitor'), 'Monthly MA monitoring must move to Monitor.')
assert.ok(navPageIds('jp').includes('customCharts'), 'Synthetic charts must move to Analysis & AI.')
assert.ok(!navPageIds('jp').includes('historicalPatterns'), 'Historical pattern search must not duplicate MA Lens in navigation.')
assert.ok(!navPageIds('jp').includes('sectorStructure'), 'Sector structure must stay a view inside sector analysis.')

const commodityHrefs = navPageIds('commodities').map((pageId) => PAGE_CATALOG[pageId].href)
assert.ok(!commodityHrefs.some((href) => /^\/commodities\/(jp|us)\//.test(href)), 'Specific commodity instruments must not be top-level navigation entries.')
assert.equal(PAGE_CATALOG_ENTRIES.length, Object.keys(PAGE_CATALOG).length)
assert.match(header, /PAGE_CATALOG_ENTRIES\.map/, 'Command search must be generated from the shared page catalog.')
assert.match(header, /QUICK_COMMAND_PAGE_IDS_BY_AREA\[area\]/, 'Quick commands must be selected by catalog page id.')

console.log('header navigation regression tests passed')
