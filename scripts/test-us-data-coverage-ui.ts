import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { summarizeUsCoverage, type UsStatusSummary } from '@/lib/us-status'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { US_ANALYSIS_NAV_HREFS, usDataCoverageScopeForRoute } from '@/components/us/UsAnalysisNav'
import {
  US_DATA_COVERAGE_SCOPE_COPY,
  UsDataCoverageStripView,
  type UsDataCoverageScope,
} from '@/components/us/UsDataCoverageStrip'
import {
  US_STATUS_ENDPOINT,
  getUsDataCoverageSnapshot,
  isUsStatusSummary,
  loadUsDataCoverage,
  type UsDataCoverageState,
} from '@/components/us/usDataCoverageResource'

const STRIP = 'components/us/UsDataCoverageStrip.tsx'
const RESOURCE = 'components/us/usDataCoverageResource.ts'
const NAV = 'components/us/UsAnalysisNav.tsx'
const read = (path: string) => fs.readFileSync(path, 'utf8')
const src = { strip: read(STRIP), resource: read(RESOURCE), nav: read(NAV) }

// ── 1. Route coverage ────────────────────────────────────────────────

const ALL_SCOPES = Object.keys(US_DATA_COVERAGE_SCOPE_COPY) as UsDataCoverageScope[]
const navScopes = new Set<UsDataCoverageScope>()
for (const href of US_ANALYSIS_NAV_HREFS) {
  const scope = usDataCoverageScopeForRoute(href)
  assert.ok(scope, `nav route ${href} must map to a coverage scope`)
  navScopes.add(scope)
}
assert.equal(usDataCoverageScopeForRoute('/us/unknown'), null, 'unknown routes must not guess a scope')

// 各ページの UsAnalysisNav current が nav の route と一致し、scope が引けること。
const NAV_PAGES = [
  'app/us/page.tsx',
  'components/us/UsDashboardShell.tsx',
  'app/us/market-momentum/page.tsx',
  'app/us/sectors/page.tsx',
  'app/us/screener/UsScreenerClient.tsx',
  'app/us/stage-screener/page.tsx',
  'app/us/trigger-discovery/page.tsx',
  'app/us/analysis/ml-lens/page.tsx',
  'app/us/analysis/transitions/page.tsx',
  'app/us/analysis/backtest/page.tsx',
]
const pageRoutes = new Set<string>()
for (const page of NAV_PAGES) {
  const matches = [...read(page).matchAll(/<UsAnalysisNav current="([^"]+)"/g)]
  assert.ok(matches.length > 0, `${page} must keep rendering UsAnalysisNav`)
  for (const [, route] of matches) {
    assert.ok(usDataCoverageScopeForRoute(route), `${page}: ${route} must resolve to a coverage scope`)
    pageRoutes.add(route)
  }
}
for (const href of US_ANALYSIS_NAV_HREFS) {
  assert.ok(pageRoutes.has(href), `nav route ${href} must be rendered by a page`)
}

// nav 外の 2 画面は直接 strip を置く。
const stockPage = read('app/us/stock/[ticker]/page.tsx')
const mtfPage = read('app/us/mtf-close-calendar/page.tsx')
assert.match(stockPage, /<UsDataCoverageStrip scope="stock" ticker=\{normalized\}/, 'stock detail must render a ticker-scoped strip')
assert.match(mtfPage, /<UsDataCoverageStrip scope="mtf-calendar"/, 'MTF calendar must render its strip')
assert.ok(mtfPage.indexOf('<UsDataCoverageStrip') > mtfPage.indexOf('<PageTitle'), 'MTF strip sits directly under PageTitle')
assert.ok(mtfPage.indexOf('<UsDataCoverageStrip') < mtfPage.indexOf('<Notice'), 'MTF strip precedes the page notice')

const usedScopes = new Set<UsDataCoverageScope>([...navScopes, 'stock', 'mtf-calendar'])
assert.deepEqual([...usedScopes].sort(), [...ALL_SCOPES].sort(), 'every scope must be used by exactly the routes in this wave')

// 既存 ViewTabs を壊さない。
assert.match(src.nav, /<ViewTabs\s+label="米国株"\s+current=\{current\}/, 'UsAnalysisNav must keep its ViewTabs')
assert.match(src.nav, /aria-hidden/, 'nav icons stay decorative')

// 既存の route 固有 as-of / 日付表示を削除しない。
const EXISTING_FACTS: Array<[string, RegExp]> = [
  ['app/us/screener/UsScreenerClient.tsx', /AS OF \{asOfDate/],
  ['app/us/analysis/ml-lens/page.tsx', /label="データ基準日"/],
  ['app/us/analysis/transitions/page.tsx', /基準日 \{analysis\.date/],
  ['app/us/analysis/backtest/page.tsx', /サービング統計 \{analysis\.servingDate/],
  ['app/us/mtf-close-calendar/page.tsx', /日付の根拠と検証状況/],
  ['app/us/stock/[ticker]/UsStockDetailClient.tsx', /価格日 \$\{displayedQuote\.priceDate\}/],
]
for (const [file, pattern] of EXISTING_FACTS) {
  assert.match(read(file), pattern, `${file} must keep its route-specific date fact`)
}

// ── 2. Source discipline ─────────────────────────────────────────────

for (const [name, source] of Object.entries({ strip: src.strip, resource: src.resource })) {
  assert.doesNotMatch(source, /\b\d{4}-\d{2}-\d{2}\b/, `${name}: no hardcoded dates`)
  assert.doesNotMatch(source, /\b\d{1,3}(?:,\d{3})+\b|\b\d{1,3}(?:_\d{3})+\b/, `${name}: no hardcoded counts`)
  assert.doesNotMatch(source, /new Date\(|Date\.now\(|today/i, `${name}: must not infer staleness from the clock`)
  assert.doesNotMatch(source, /exec(?:All|Get)|SELECT\s/i, `${name}: no SQL / DB access on the client`)
  assert.doesNotMatch(source, /min-h-|h-\[|\bfixed\b|invisible|gradient|#[0-9a-f]{3,8}\b/i, `${name}: no reserve space, fixed layers, gradients or new colors`)
}
// coverage は server 値を使う。client で比率を再計算しない。
assert.doesNotMatch(src.strip, /\.covered\s*[/*]|[/*]\s*[\w.]*\.eligible|percent\s*[:=]\s*[^=]/, 'strip must not recompute coverage ratios')
assert.doesNotMatch(src.strip, /fetch\(/, 'strip must read through the shared resource')
assert.equal((src.resource.match(/fetch\(/g) ?? []).length, 1, 'resource owns the single /api/us/status fetch')
assert.equal(US_STATUS_ENDPOINT, '/api/us/status')
// ticker は route param からのみ。RGC/QMMM は backtest の source-quality 説明文だけ。
const backtestBlock = src.strip.slice(src.strip.indexOf('  backtest: {'), src.strip.indexOf('  stock: {'))
for (const symbol of ['RGC', 'QMMM']) {
  assert.equal((src.strip.match(new RegExp(`\\b${symbol}\\b`, 'g')) ?? []).length, 1, `${symbol} appears once`)
  assert.match(backtestBlock, new RegExp(`${symbol}.*source-quality`), `${symbol} only as source-quality detail copy`)
}
assert.doesNotMatch(src.strip, /\b(?:AAPL|MSFT|NVDA|TSLA|SPY)\b/, 'no hardcoded tickers')
// native details、既定は閉。
assert.match(src.strip, /<details className=/, 'strip uses native <details>')
assert.doesNotMatch(src.strip, /<details[^>]*\bopen\b/, 'strip is closed by default')

// ── 3. Rendered states ───────────────────────────────────────────────

function fixture(overrides: { ohlcv?: [number, number] | null; snapshots?: [number, number] | null } = {}): UsStatusSummary {
  const date = 'fixture-date'
  const cov = (pair: [number, number] | null | undefined, fallback: [number, number]) => {
    if (pair === null) return summarizeUsCoverage(null, 0, 0)
    const [eligible, covered] = pair ?? fallback
    return summarizeUsCoverage(date, eligible, covered)
  }
  return {
    market: 'US',
    universe: { total: 0, active: 0, productionActive: 0, stocks: 0, etfs: 0, mutualFunds: 0, testSymbols: 0, excludedArtifacts: 0 },
    ohlcv: { firstDate: null, latestDate: date, tickers: 0, rows: null, rowsApproximate: true },
    snapshots: { latestDate: date, tickers: 0 },
    coverage: { ohlcv: cov(overrides.ohlcv, [200, 200]), snapshots: cov(overrides.snapshots, [150, 150]) },
    contracts: {
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      priceFrequency: 'EOD',
      classification: { taxonomy: 'SEC_SIC', effectiveDating: 'CURRENT_ONLY', historicalPitAvailable: false },
      fundamentals: { source: 'SEC_COMPANYFACTS', basis: 'ACTUAL_ONLY', companyForecastsAvailable: false },
    },
    latestRun: null,
  }
}

function render(scope: UsDataCoverageScope, state: UsDataCoverageState, ticker?: string) {
  const html = renderToStaticMarkup(createElement(UsDataCoverageStripView, { scope, state, ticker, onRetry: () => {} }))
  const [summary, details = ''] = html.split('</summary>')
  return { html, summary, details }
}
const ready = (data: UsStatusSummary): UsDataCoverageState => ({ status: 'ready', data })
const text = (html: string) => html.replace(/<[^>]+>/g, '')

assert.ok(isUsStatusSummary(fixture()), 'fixture must satisfy the client contract guard')
assert.equal(isUsStatusSummary({ market: 'US' }), false, 'incomplete payload is rejected (→ 確認できません)')

// COMPLETE: 警告 badge にしない。基準日・母集団・Tiingo調整済EOD を 1 行に。
{
  const { html, summary } = render('dashboard', ready(fixture()))
  assert.doesNotMatch(html, /data-tone="warning"/, 'COMPLETE must not render a warning badge')
  assert.doesNotMatch(html, /<details[^>]*\sopen/, 'rendered closed by default')
  assert.match(text(summary), /ソース基準日fixture-date/)
  assert.match(text(summary), /母集団 200 銘柄/)
  assert.match(text(summary), /Tiingo調整済EOD/)
  assert.match(text(summary), /価格全件200\/200（100\.00%）/)
  assert.match(html, /aria-label="USデータの鮮度とカバレッジ"/)
}

// PARTIAL: covered/eligible/% を必ず併記。切り捨てで 100.00% に見せない。
{
  const { summary, details } = render('market-momentum', ready(fixture({ snapshots: [12_004, 11_760] })))
  assert.match(summary, /data-tone="warning"[^>]*>PARTIAL</)
  assert.match(text(summary), /6 Stage/)
  assert.match(text(summary), /11,760\/12,004（97\.97%）/, 'PARTIAL shows covered/eligible/%')
  assert.match(text(details), /11,760\/12,004/)
  const nearFull = render('stage-screener', ready(fixture({ snapshots: [100_000, 99_999] })))
  assert.match(text(nearFull.summary), /99,999\/100,000（99\.99%）/, 'PARTIAL is never rounded up to 100.00%')
  assert.doesNotMatch(text(nearFull.summary), /100\.00%/)
}

// UNAVAILABLE はデータ欠落「—」。N/A や PARTIAL にしない。
{
  const { summary } = render('dashboard', ready(fixture({ ohlcv: null })))
  assert.match(summary, /aria-hidden="true">—</)
  assert.doesNotMatch(summary, /N\/A|PARTIAL/)
}

// status 取得失敗は「確認できません」。N/A にしない。
{
  const { summary, details } = render('sectors', { status: 'error' })
  assert.match(text(summary), /確認できません/)
  assert.doesNotMatch(summary, /N\/A/, 'fetch failure must not read as N/A')
  assert.match(details, /再読み込み/)
  assert.match(text(details), /適用外という意味ではありません/)
}
{
  const { summary } = render('sectors', { status: 'loading' })
  assert.match(summary, /role="status"/)
  assert.doesNotMatch(summary, /N\/A|確認できません/)
}

// ── 4. Route-specific copy ───────────────────────────────────────────

const ROUTE_COPY: Record<UsDataCoverageScope, RegExp[]> = {
  dashboard: [/OHLCV/, /PARTIAL/],
  'market-momentum': [/6 Stage/],
  sectors: [/SEC SIC/, /GICS ではありません/, /current-only/, /historical PIT/],
  screener: [/SIC 業種・Exchange/, /current-only/, /過去日では利用できません/, /無効になり絞り込みに使われず/, /現在の値で代用することもありません/, /会社予想/],
  'stage-screener': [/6 Stage/],
  'trigger-discovery': [/単一日付・現時点/, /historical classification/, /保存・事後評価・通知・期間スキャンは未提供/],
  'ml-lens': [/世代（generation）/, /画面上の「データ基準日」を正/],
  transitions: [/イベント日は画面上の表示を正/, /historical classification/],
  backtest: [/RGC・QMMM/, /source-quality/, /方針は未決/, /clip \/ winsorize/, /activation pending/],
  stock: [/個別系列/, /SEC Companyfacts の実績値のみ/, /会社予想/, /current-only/],
  'mtf-calendar': [/観測された US 取引日/, /休日ルール/, /TradingView 照合は未完了/, /UNVERIFIED/],
}
for (const scope of ALL_SCOPES) {
  const { details } = render(scope, ready(fixture()), scope === 'stock' ? 'TICKER-FIXTURE' : undefined)
  const body = text(details)
  for (const pattern of ROUTE_COPY[scope]) assert.match(body, pattern, `${scope}: detail copy ${pattern}`)
  // PIT 境界と凡例は全画面共通。
  for (const pattern of [/PIT境界/, /SEC SIC・現在の分類のみ/, /SEC Companyfacts・実績のみ/, /N\/A ?仕様上適用しない/, /PARTIAL ?一部の銘柄のみ取得/, /UNVERIFIED ?外部基準と未照合/, /— ?データ欠落/, /画面上の表示を正/]) {
    assert.match(body, pattern, `${scope}: shared detail ${pattern}`)
  }
}

// 6 Stage 系の画面は snapshots coverage を、価格系は OHLCV coverage を閉じた行に出す。
for (const scope of ['market-momentum', 'stage-screener'] as const) {
  assert.equal(US_DATA_COVERAGE_SCOPE_COPY[scope].primary, 'snapshots', `${scope} leads with 6 Stage coverage`)
}
assert.equal(US_DATA_COVERAGE_SCOPE_COPY.dashboard.primary, 'ohlcv', 'dashboard leads with OHLCV coverage')
{
  const { summary } = render('sectors', ready(fixture()))
  assert.match(text(summary), /過去分類N\/A/, 'sectors flags historical classification as N/A (spec)')
}
// screener は過去日で current-only 属性を fail-closed にする。現在値で絞り込むとは書かない。
{
  const body = text(render('screener', ready(fixture())).details)
  assert.doesNotMatch(body, /過去日で絞り込むときも|属性は現在の値（current-only）です|当時の分類・上場市場ではありません/, 'screener must not imply current values are used on historical dates')
}
{
  const { summary } = render('stock', ready(fixture({ ohlcv: [200, 150] })), 'TICKER-FIXTURE')
  assert.match(text(summary), /対象 TICKER-FIXTURE/, 'stock strip is ticker-scoped')
  assert.match(text(summary), /会社予想N\/A/)
  assert.doesNotMatch(summary, /PARTIAL/, 'market-wide OHLCV coverage is not presented as the ticker status')
}
{
  const { summary } = render('mtf-calendar', ready(fixture()))
  assert.match(text(summary), /TradingView照合UNVERIFIED/)
  assert.match(text(summary), /NYSE\/Nasdaq 通常取引日/)
}

// ── 5. Shared resource: one fetch per screen ─────────────────────────

async function resourceTests() {
  const originalFetch = globalThis.fetch
  let calls = 0
  let fail = false
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    assert.equal(String(input), US_STATUS_ENDPOINT)
    if (fail) return new Response('boom', { status: 500 })
    return new Response(JSON.stringify(fixture()), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await Promise.all([loadUsDataCoverage('dashboard:'), loadUsDataCoverage('dashboard:')])
    assert.equal(calls, 1, 'concurrent strips on one screen share one request')
    await loadUsDataCoverage('dashboard:')
    assert.equal(calls, 1, 'settled result is reused on the same screen')
    assert.equal(getUsDataCoverageSnapshot().status, 'ready')
    await loadUsDataCoverage('sectors:')
    assert.equal(calls, 2, 'a different screen reads status again')
    fail = true
    await loadUsDataCoverage('sectors:', true)
    assert.equal(getUsDataCoverageSnapshot().status, 'error', 'failure is kept as error, not N/A')
  } finally {
    globalThis.fetch = originalFetch
  }
}

resourceTests().then(() => {
  console.log('US data coverage UI tests passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
