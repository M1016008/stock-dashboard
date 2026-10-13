import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  NAVIGATION_BY_AREA,
  PAGE_CATALOG,
  PAGE_CATALOG_ENTRIES,
  QUICK_COMMAND_PAGE_IDS_BY_AREA,
  type HeaderArea,
  type NavigationEntry,
  type PageId,
} from '../components/layout/navigation'
import {
  buildMarketSwitchLinks,
  MARKET_COUNTERPARTS,
  MARKET_SPECIFIC_PAGE_IDS,
  MARKET_SWITCH_OPTIONS,
  resolveHeaderArea,
  SHARED_PAGE_IDS,
  type MarketCounterpart,
} from '../components/layout/market-switch'
import type { UniverseFilterValue } from '../lib/market-universe'

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
  ['ホーム', '市場・業種', '銘柄探索', '分析・AI', '監視'],
  'US navigation must expose the same task vocabulary once market analysis is available.',
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
assert.equal(PAGE_CATALOG.usMarketMomentum.href, '/us/market-momentum')
assert.equal(PAGE_CATALOG.usSectors.href, '/us/sectors')
assert.equal(PAGE_CATALOG.mtfCloseCalendar.href, '/mtf-close-calendar')
assert.equal(PAGE_CATALOG.usMtfCloseCalendar.href, '/us/mtf-close-calendar')

assert.ok(navPageIds('jp').includes('sectors'), 'Industry analysis must remain under Market & Industry.')
assert.ok(navPageIds('jp').includes('periodExplorer'), 'Period Explorer must be available under stock discovery.')
assert.ok(navPageIds('jp').includes('hexStage'), 'Market-wide six-stage analysis must remain under Analysis & AI.')
assert.ok(navPageIds('jp').includes('ma25mMonitor'), 'Monthly MA monitoring must move to Monitor.')
assert.ok(navPageIds('jp').includes('customCharts'), 'Synthetic charts must move to Analysis & AI.')
assert.ok(!navPageIds('jp').includes('historicalPatterns'), 'Historical pattern search must not duplicate MA Lens in navigation.')
assert.ok(!navPageIds('jp').includes('sectorStructure'), 'Sector structure must stay a view inside sector analysis.')
assert.ok(navPageIds('us').includes('usMarketMomentum'), 'US market momentum must be available under Market & Industry.')
assert.ok(navPageIds('us').includes('usSectors'), 'US sector analysis must be available under Market & Industry.')

function menuPageIds(area: HeaderArea, menuId: string): PageId[] {
  const entries: readonly NavigationEntry[] = NAVIGATION_BY_AREA[area]
  const entry = entries.find((item) => item.kind === 'menu' && item.id === menuId)
  assert.ok(entry && entry.kind === 'menu', `${area}:${menuId} menu must exist.`)
  return entry.sections.flatMap((section) => [...section.pageIds])
}

assert.ok(menuPageIds('jp', 'market').includes('mtfCloseCalendar'), 'JP MTF Close Calendar must stay under JP Market & Industry.')
assert.ok(menuPageIds('us', 'us-market').includes('usMtfCloseCalendar'), 'US MTF Close Calendar must live under US Market & Industry.')
assert.ok(!navPageIds('us').includes('mtfCloseCalendar'), 'US navigation must not link the JP-session calendar.')
assert.ok(!navPageIds('jp').includes('usMtfCloseCalendar'), 'JP navigation must not link the US-session calendar.')

const commodityHrefs = navPageIds('commodities').map((pageId) => PAGE_CATALOG[pageId].href)
assert.ok(!commodityHrefs.some((href) => /^\/commodities\/(jp|us)\//.test(href)), 'Specific commodity instruments must not be top-level navigation entries.')
assert.equal(PAGE_CATALOG_ENTRIES.length, Object.keys(PAGE_CATALOG).length)
assert.match(header, /PAGE_CATALOG_ENTRIES\.map/, 'Command search must be generated from the shared page catalog.')
assert.match(header, /QUICK_COMMAND_PAGE_IDS_BY_AREA\[area\]/, 'Quick commands must be selected by catalog page id.')

// --- Market switch: active market contract -------------------------------

const AREAS: HeaderArea[] = ['jp', 'us', 'commodities']

const areaCases: Array<[string, string | null, HeaderArea]> = [
  ['/', null, 'jp'],
  ['/screener', null, 'jp'],
  ['/stock/7203', null, 'jp'],
  ['/watchlist', null, 'jp'],
  ['/custom-charts', null, 'jp'],
  ['/us', null, 'us'],
  ['/us/screener', null, 'us'],
  ['/us/stock/AAPL', null, 'us'],
  ['/commodities', null, 'commodities'],
  ['/commodities/us/GLD', null, 'commodities'],
  ['/ai/research', null, 'jp'],
  ['/ai/research', 'JP', 'jp'],
  ['/ai/research', 'US', 'us'],
  // AssistantResearchClient reads `market` case-sensitively; the header must agree.
  ['/ai/research', 'us', 'jp'],
  ['/ai/research', 'COMMODITY', 'commodities'],
  ['/chart-drill', 'US', 'us'],
  // ChartDrillClient reads `market` case-insensitively; the header must agree.
  ['/chart-drill', 'us', 'us'],
  ['/chart-drill', 'COMMODITY', 'jp'],
  // On JP pages `market` is a market-segment filter, not a market switch.
  ['/period-explorer', 'US', 'jp'],
  ['/ma25m-monitor', 'US', 'jp'],
  ['/large-holders', 'US', 'jp'],
  ['/watchlist', 'US', 'jp'],
  // Prefix matching must respect path segments.
  ['/usage', null, 'jp'],
  ['/commodities-archive', null, 'jp'],
]
for (const [pathname, market, expected] of areaCases) {
  assert.equal(resolveHeaderArea(pathname, market), expected, `area for ${pathname}?market=${market}`)
}

function switchHrefs(pathname: string, marketParam: string | null = null, universe: UniverseFilterValue = null) {
  const links = buildMarketSwitchLinks({ pathname, marketParam, universe })
  return Object.fromEntries(links.map((link) => [link.area, link.href])) as Record<HeaderArea, string>
}

function areaOfHref(href: string): HeaderArea {
  const url = new URL(href, 'https://stockboard.invalid')
  return resolveHeaderArea(url.pathname, url.searchParams.get('market'))
}

for (const [pathname, market] of areaCases.map(([p, m]) => [p, m] as const)) {
  const links = buildMarketSwitchLinks({ pathname, marketParam: market })
  assert.deepEqual(links.map((link) => link.area), AREAS, 'Switch order must stay JP, US, COM.')
  assert.deepEqual(links.map((link) => link.label), ['日本株', '米国株', 'コモディティ'])
  assert.deepEqual(links.map((link) => link.shortLabel), ['JP', 'US', 'COM'])
  const active = links.filter((link) => link.active)
  assert.equal(active.length, 1, `exactly one active market for ${pathname}`)
  assert.equal(active[0].area, resolveHeaderArea(pathname, market), `active market must equal header area for ${pathname}`)
  assert.equal(active[0].destination, 'current')
  for (const link of links) {
    assert.equal(areaOfHref(link.href), link.area, `${pathname} -> ${link.area} link (${link.href}) must land in that market`)
  }
}

// --- Market switch: counterpart route contract ---------------------------

const expectedCounterparts: Array<[string, string | null, Record<HeaderArea, string>]> = [
  ['/', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/us', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/commodities', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/market-momentum', null, { jp: '/', us: '/us/market-momentum', commodities: '/commodities' }],
  ['/us/market-momentum', null, { jp: '/market-momentum', us: '/us', commodities: '/commodities' }],
  ['/sectors', null, { jp: '/', us: '/us/sectors', commodities: '/commodities' }],
  ['/us/sectors', null, { jp: '/sectors', us: '/us', commodities: '/commodities' }],
  ['/mtf-close-calendar', null, { jp: '/', us: '/us/mtf-close-calendar', commodities: '/commodities' }],
  ['/us/mtf-close-calendar', null, { jp: '/mtf-close-calendar', us: '/us', commodities: '/commodities' }],
  ['/screener', null, { jp: '/', us: '/us/screener', commodities: '/commodities/screener' }],
  ['/us/screener', null, { jp: '/screener', us: '/us', commodities: '/commodities/screener' }],
  ['/commodities/screener', null, { jp: '/screener', us: '/us/screener', commodities: '/commodities' }],
  ['/stage-screener', null, { jp: '/', us: '/us/stage-screener', commodities: '/commodities' }],
  ['/us/stage-screener', null, { jp: '/stage-screener', us: '/us', commodities: '/commodities' }],
  ['/trigger-discovery', null, { jp: '/', us: '/us/trigger-discovery', commodities: '/commodities' }],
  ['/us/trigger-discovery', null, { jp: '/trigger-discovery', us: '/us', commodities: '/commodities' }],
  ['/ai/ma-lens', null, { jp: '/', us: '/us/analysis/ml-lens', commodities: '/commodities' }],
  ['/us/analysis/ml-lens', null, { jp: '/ai/ma-lens', us: '/us', commodities: '/commodities' }],
  ['/ai/transitions', null, { jp: '/', us: '/us/analysis/transitions', commodities: '/commodities' }],
  ['/us/analysis/transitions', null, { jp: '/ai/transitions', us: '/us', commodities: '/commodities' }],
  ['/backtest', null, { jp: '/', us: '/us/analysis/backtest', commodities: '/commodities' }],
  ['/us/analysis/backtest', null, { jp: '/backtest', us: '/us', commodities: '/commodities' }],
  // Shared query routes: the market query is added for US and removed for JP.
  ['/ai/research', null, { jp: '/', us: '/ai/research?market=US', commodities: '/commodities' }],
  ['/ai/research', 'US', { jp: '/ai/research', us: '/us', commodities: '/commodities' }],
  ['/chart-drill', null, { jp: '/', us: '/chart-drill?market=US', commodities: '/commodities' }],
  ['/chart-drill', 'US', { jp: '/chart-drill', us: '/us', commodities: '/commodities' }],
  ['/chart-drill', 'us', { jp: '/chart-drill', us: '/us', commodities: '/commodities' }],
  // No commodity research page in navigation: go home rather than guess.
  ['/ai/research', 'COMMODITY', { jp: '/', us: '/us', commodities: '/commodities' }],
  // Market-specific pages have no counterpart.
  ['/hex-stage', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/period-explorer', 'プライム', { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/themes', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/themes/ai', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/sector-etfs/1615', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/large-holders/investors/123', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  // Shared pages are never given a market query.
  ['/watchlist', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/custom-charts', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  // Tickers are never mapped across markets.
  ['/stock/7203', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/us/stock/AAPL', null, { jp: '/', us: '/us', commodities: '/commodities' }],
  ['/commodities/us/GLD', null, { jp: '/', us: '/us', commodities: '/commodities' }],
]
for (const [pathname, market, expected] of expectedCounterparts) {
  assert.deepEqual(switchHrefs(pathname, market), expected, `switch hrefs for ${pathname}?market=${market}`)
}

const researchLinks = buildMarketSwitchLinks({ pathname: '/ai/research', marketParam: 'US' })
assert.deepEqual(
  researchLinks.map((link) => link.destination),
  ['counterpart', 'current', 'home'],
  'US AI research must offer the JP counterpart and fall back to the commodity home.',
)
assert.match(researchLinks[0].title, /AI銘柄リサーチ/, 'Counterpart titles must name the destination page.')
assert.match(researchLinks[2].title, /対応するコモディティページはありません/, 'Home fallbacks must say there is no counterpart.')

// The Nikkei 225 universe is JP-only: kept on the JP link, dropped across markets.
assert.deepEqual(switchHrefs('/screener', null, 'nikkei225'), {
  jp: '/?universe=nikkei225',
  us: '/us/screener',
  commodities: '/commodities/screener',
})

// No market-switch href may carry a ticker or attach `market` to a page that does not read it.
const samplePaths = [
  ...PAGE_CATALOG_ENTRIES.map(([, page]) => page.href),
  ...expectedCounterparts.map(([pathname, market]) => (market ? `${pathname}?market=${market}` : pathname)),
]
for (const sample of samplePaths) {
  const url = new URL(sample, 'https://stockboard.invalid')
  for (const link of buildMarketSwitchLinks({ pathname: url.pathname, marketParam: url.searchParams.get('market') })) {
    assert.doesNotMatch(link.href, /\/stock\/|\/commodities\/(jp|us)\//, `${sample} -> ${link.href} must not target an instrument`)
    assert.doesNotMatch(link.href, /#/, `${sample} -> ${link.href} must not carry a fragment`)
    const target = new URL(link.href, 'https://stockboard.invalid')
    if (target.searchParams.has('market')) {
      assert.ok(['/ai/research', '/chart-drill'].includes(target.pathname), `${link.href} must not attach market to a page that ignores it`)
    }
  }
}

// --- Counterpart table integrity -------------------------------------------

const classified = new Map<PageId, string>()
function classify(pageId: PageId, owner: string) {
  assert.ok(!classified.has(pageId), `${pageId} is classified twice (${classified.get(pageId)} and ${owner}).`)
  classified.set(pageId, owner)
}
for (const group of MARKET_COUNTERPARTS as readonly MarketCounterpart[]) {
  const members = AREAS.filter((area) => group[area] !== undefined)
  assert.ok(members.length >= 2, 'A counterpart group needs at least two markets.')
  for (const area of members) {
    const pageId = group[area]!
    classify(pageId, `counterpart:${area}`)
    assert.ok(navPageIds(area).includes(pageId), `${area} counterpart ${pageId} must be in ${area} navigation.`)
    assert.equal(areaOfHref(PAGE_CATALOG[pageId].href), area, `${pageId} href must resolve to ${area}.`)
  }
}
for (const area of AREAS) {
  for (const pageId of MARKET_SPECIFIC_PAGE_IDS[area]) {
    classify(pageId, `specific:${area}`)
    assert.ok(navPageIds(area).includes(pageId), `${pageId} must be in ${area} navigation.`)
  }
}
for (const pageId of SHARED_PAGE_IDS) {
  classify(pageId, 'shared')
  const owners = AREAS.filter((area) => navPageIds(area).includes(pageId))
  assert.ok(owners.length >= 2, `${pageId} is only shared if several markets list it.`)
}
for (const area of AREAS) {
  for (const pageId of navPageIds(area)) {
    assert.ok(
      classified.has(pageId),
      `${area}:${pageId} must be classified as a counterpart, market-specific, or shared page before it ships.`,
    )
  }
}
for (const option of MARKET_SWITCH_OPTIONS) {
  const home: readonly NavigationEntry[] = NAVIGATION_BY_AREA[option.area]
  assert.ok(
    home.some((entry) => entry.kind === 'link' && entry.pageId === option.homePageId),
    `${option.area} home must be the market's ホーム navigation link.`,
  )
}

// --- Source wiring ----------------------------------------------------------

const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8')
assert.match(header, /resolveHeaderArea\(pathname, requestedMarket\)/, 'Header area must come from the shared resolver.')
assert.match(header, /buildMarketSwitchLinks\(\{ pathname, marketParam: requestedMarket, universe: activeUniverse \}\)/)
assert.equal((header.match(/<MarketSwitch /g) ?? []).length, 1, 'The market switch must render once for every viewport.')
assert.match(header, /<nav\s+aria-label="市場切替"/, 'The market switch must be a labelled navigation landmark.')
assert.match(header, /aria-current=\{link\.active \? 'true' : undefined\}/, 'The active market must expose aria-current.')
assert.match(header, /className="sr-only"> \{link\.label\}/, 'Compact market codes must keep the full market name for assistive tech.')
assert.match(header, /h-7 min-w-\[30px\]/, 'Market switch targets must stay at least 28x30px.')
assert.doesNotMatch(
  header.slice(header.indexOf('function MarketSwitch'), header.indexOf('function NavIcon')),
  /focus-visible:outline-none/,
  'Market switch links must keep the global focus-visible outline.',
)
assert.doesNotMatch(header, /header-market-switcher-compact/, 'Desktop and compact switches must not be separate copies.')
assert.doesNotMatch(header, /href="\/(us|commodities)"/, 'Market switch hrefs must come from the counterpart contract.')
assert.doesNotMatch(css, /header-market-switcher-compact/)
assert.match(
  css,
  /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*?\.header-market-switch-long\s*\{[\s\S]*?display:\s*block;[\s\S]*?\.header-market-switch-short\s*\{[\s\S]*?display:\s*none;/,
  'Full market labels must replace compact codes from 1024px.',
)

console.log('header navigation regression tests passed')
