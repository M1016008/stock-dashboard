import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  NAVIGATION_BY_AREA,
  PAGE_CATALOG,
  type NavigationEntry,
  type PageId,
} from '../components/layout/navigation'
import { CLOSE_TIMEFRAMES } from '../lib/timeframes'

const US_PAGE = 'app/us/mtf-close-calendar/page.tsx'

assert.ok(fs.existsSync(US_PAGE), 'US MTF Close Calendar route must exist at /us/mtf-close-calendar')

const files = {
  usPage: fs.readFileSync(US_PAGE, 'utf8'),
  jpPage: fs.readFileSync('app/mtf-close-calendar/page.tsx', 'utf8'),
  client: fs.readFileSync('app/mtf-close-calendar/MtfCloseCalendarClient.tsx', 'utf8'),
}

for (const [name, source] of Object.entries(files)) {
  assert.doesNotMatch(source, /https?:\/\/(?:localhost|127\.0\.0\.1)/, `${name} must keep browser reads same-origin`)
  assert.doesNotMatch(source, /exec(?:All|Get)|execUsAnalytics/, `${name} must not bypass the read model`)
}

// Route wiring: both markets share one client; each page passes its market explicitly.
assert.match(files.usPage, /from '\.\.\/\.\.\/mtf-close-calendar\/MtfCloseCalendarClient'/, 'US page must reuse the shared JP calendar client')
assert.match(files.usPage, /<MtfCloseCalendarClient\s+market="US"/, 'US page must request market=US')
assert.match(files.jpPage, /<MtfCloseCalendarClient\s+market="JP"/, 'JP page must keep requesting market=JP')
assert.match(files.usPage, /export const dynamic = 'force-dynamic'/, 'US "today" must be derived per request')

// "Today" is a US market date, never browser local time or JST.
assert.match(files.usPage, /timeZone: US_MARKET_TIME_ZONE/, 'US today must be formatted in the market time zone')
assert.match(files.usPage, /US_MARKET_TIME_ZONE = 'America\/New_York'/, 'US market time zone must be America/New_York')
assert.doesNotMatch(files.usPage, /Asia\/Tokyo/, 'US page must not derive dates in JST')
assert.match(files.jpPage, /timeZone: 'Asia\/Tokyo'/, 'JP page must keep JST market dates')
assert.doesNotMatch(files.client, /new Date\(\)/, 'client must not derive "today" from the browser clock')

// Shared client contract: market-driven API request, all 12 timeframes, unchanged interaction model.
assert.match(files.client, /market: CloseCalendarMarket/, 'client must take an explicit market prop')
assert.match(files.client, /new URLSearchParams\(\{\s*market,/, 'client must forward the market prop to the API')
assert.doesNotMatch(files.client, /market: 'JP'/, 'client must not hard-code the JP market in the request')
assert.match(files.client, /\/api\/mtf-close-calendar\?/, 'client must read the shared MTF Close Calendar API')
assert.match(files.client, /useState<CloseTimeframe\[\]>\(\[\.\.\.CLOSE_TIMEFRAMES\]\)/, 'all close timeframes must be enabled by default')
for (const unit of ['day', 'week', 'month']) {
  assert.match(files.client, new RegExp(`unit: '${unit}'`), `${unit} timeframe group must be rendered`)
}
assert.deepEqual(
  [...CLOSE_TIMEFRAMES],
  ['D', '2D', '3D', '5D', 'W', '2W', '3W', '5W', 'M', '2M', '3M', '5M'],
  'shared calendar must expose the 12 agreed timeframes',
)
for (const fragment of [
  'CLOSE_FILTERS',
  'toggleTimeframe',
  'getUpcomingCloseDays',
  'addMonths(value, -1)',
  'addMonths(value, 1)',
  'aria-busy={loading}',
  '再読み込み',
  '該当日なし',
]) {
  assert.ok(files.client.includes(fragment), `shared client must keep ${fragment}`)
}

// US copy: regular sessions, NY market dates, observed vs projected, pending Oracle validation.
assert.match(files.usPage, /NYSE\/Nasdaq/, 'US copy must name NYSE/Nasdaq regular sessions')
assert.match(files.usPage, /通常取引/, 'US copy must state regular-session coverage')
assert.match(files.usPage, /America\/New_York/, 'US copy must state America/New_York market dates')
assert.match(files.usPage, /US 日足/, 'US copy must state observed dates come from market OHLCV')
assert.match(files.usPage, /休日ルール/, 'US copy must state future dates are holiday-rule projections')
assert.match(files.usPage, /US 固有の TradingView 照合はまだ完了していません/, 'US page must disclose that US Oracle validation is pending')
assert.doesNotMatch(files.usPage, /US[^。]*(?:照合|検証)済み/, 'US page must not claim US TradingView validation')
assert.match(files.client, /US: \{\s*showDataSource: true/, 'US calendar must distinguish observed and projected dates')
assert.match(files.client, /JP: \{\s*showDataSource: false/, 'JP calendar presentation must stay unchanged')
assert.match(files.client, /予定（米国休日ルール）/, 'US selected-day detail must label projected dates')
for (const source of [files.usPage, files.client]) {
  assert.doesNotMatch(source, /買い推奨|売り推奨|おすすめ銘柄/, 'calendar copy must not give investment advice')
}

// Navigation: one owner under US "市場・業種", distinct from the JP calendar.
assert.equal(PAGE_CATALOG.usMtfCloseCalendar.href, '/us/mtf-close-calendar')
const usMarketMenu = (NAVIGATION_BY_AREA.us as readonly NavigationEntry[]).find(
  (entry) => entry.kind === 'menu' && entry.id === 'us-market',
)
assert.ok(usMarketMenu && usMarketMenu.kind === 'menu', 'US market menu must exist')
assert.equal(usMarketMenu.label, '市場・業種')
const usMarketPageIds: PageId[] = usMarketMenu.sections.flatMap((section) => [...section.pageIds])
assert.ok(usMarketPageIds.includes('usMtfCloseCalendar'), 'US MTF Close Calendar must be under US 市場・業種')
const usOwners = (NAVIGATION_BY_AREA.us as readonly NavigationEntry[]).flatMap((entry) => (
  entry.kind === 'link' ? [entry.pageId] : entry.sections.flatMap((section) => [...section.pageIds])
)).filter((pageId) => pageId === 'usMtfCloseCalendar')
assert.equal(usOwners.length, 1, 'US MTF Close Calendar must have exactly one navigation owner')

console.log('US MTF Close Calendar UI contract tests passed')
