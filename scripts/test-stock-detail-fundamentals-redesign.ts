import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StockDecisionSummary } from '@/components/stock/StockDecisionSummary'
import { FundamentalSummaryBoard } from '@/components/stock/fundamentals/FundamentalSummaryBoard'
import {
  compareDisplayed,
  directionFromMedianComparison,
  displaySummary,
  positionInRange,
  UNAVAILABLE_LABEL,
  unavailableLabel,
} from '@/components/stock/fundamentals/format'
import {
  BarLadder,
  DefinitionTip,
  PeerBand,
  RangeRuler,
  TabBanner,
} from '@/components/stock/fundamentals/primitives'
import type { FinancialOverviewReadModel, FinancialOverviewValue } from '@/lib/server/financial-overview-read-model'
import { TrendingUp } from 'lucide-react'

const root = new URL('../', import.meta.url)
const source = (path: string) => readFileSync(new URL(path, root), 'utf8')

const stockDetail = source('app/stock/[ticker]/StockDetailClient.tsx')
const summary = source('components/stock/StockDecisionSummary.tsx')
const board = source('components/stock/fundamentals/FundamentalSummaryBoard.tsx')
const performance = source('components/stock/FinancialPerformanceDetail.tsx')
const financial = source('components/stock/FinancialDetail.tsx')
const valuation = source('components/stock/ValuationDetail.tsx')
const returns = source('components/stock/ShareholderReturnsDetail.tsx')

const helperDir = new URL('components/stock/fundamentals/', root)
const helperSources = readdirSync(helperDir).map((name) => ({ name, text: readFileSync(new URL(name, helperDir), 'utf8') }))
const redesigned = [
  { name: 'FinancialPerformanceDetail', text: performance },
  { name: 'FinancialDetail', text: financial },
  { name: 'ValuationDetail', text: valuation },
  { name: 'ShareholderReturnsDetail', text: returns },
  ...helperSources,
]

function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  assert.ok(start >= 0, `marker not found: ${from}`)
  assert.ok(end > start, `marker not found: ${to}`)
  return text.slice(start, end)
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

// ---------------------------------------------------------------------------
// 0. Global shell is untouched: five Fundamentals tabs, same labels/order.
// ---------------------------------------------------------------------------
const workspace = slice(stockDetail, 'function FundamentalWorkspace', 'function OverviewWorkspace')
let cursor = -1
for (const label of ['サマリー', '業績', '財務', 'バリュエーション', '株主還元']) {
  const index = workspace.indexOf(`label: '${label}'`)
  assert.ok(index > cursor, `Fundamental tab order: ${label}`)
  cursor = index
}
assert.equal(count(workspace, /\{ id: '/g), 5)
assert.match(workspace, /variant="fundamental"/)
assert.match(workspace, /onSelectFundamentalTab=\{onSelect\}/, 'Summary axes navigate through the existing tab handler')
for (const component of ['<FinancialPerformanceDetail', '<FinancialDetail', '<ValuationDetail', '<ShareholderReturnsDetail']) {
  assert.equal(count(workspace, new RegExp(component)), 1, `${component} is mounted once in the workspace`)
}

// ---------------------------------------------------------------------------
// 1. Shared vocabulary / pure helpers
// ---------------------------------------------------------------------------
assert.equal(UNAVAILABLE_LABEL.not_applicable, '対象外')
assert.equal(UNAVAILABLE_LABEL.not_meaningful, '算出不能')
assert.equal(UNAVAILABLE_LABEL.missing, 'データなし')
assert.equal(unavailableLabel('not_applicable'), '対象外')
assert.equal(unavailableLabel(undefined), 'データなし')
assert.deepEqual(displaySummary({ text: 'N/A', availability: 'not_applicable', reason: null }), { text: '対象外', unavailable: true })
assert.deepEqual(displaySummary({ text: 'N/M', availability: 'missing', reason: null }), { text: '算出不能', unavailable: true })
assert.deepEqual(displaySummary({ text: '—', availability: 'missing', reason: null }), { text: 'データなし', unavailable: true })
assert.deepEqual(displaySummary({ text: '予想なし', availability: 'missing', reason: null }), { text: '予想なし', unavailable: true })
assert.deepEqual(displaySummary({ text: '12.0%', availability: 'available', reason: null }), { text: '12.0%', unavailable: false })

assert.equal(compareDisplayed(7.21, 7.24, 0.1), 'same', 'values equal at display precision are 同水準')
assert.equal(compareDisplayed(8, 7, 0.1), 'higher')
assert.equal(compareDisplayed(5, 7, 0.1), 'lower')
assert.equal(directionFromMedianComparison({ kind: 'ratio_percent', value: 12.3 }), 'higher')
assert.equal(directionFromMedianComparison({ kind: 'ratio_percent', value: -0.04 }), 'same')
assert.equal(directionFromMedianComparison({ kind: 'percentage_point', value: -2 }), 'lower')
assert.equal(directionFromMedianComparison({ kind: 'unavailable', value: null }), null)
assert.deepEqual(positionInRange(5, 0, 10), { left: 50, clipped: null })
assert.deepEqual(positionInRange(-3, 0, 10), { left: 0, clipped: 'low' })
assert.deepEqual(positionInRange(14, 0, 10), { left: 100, clipped: 'high' })
assert.equal(positionInRange(5, 10, 10), null)
assert.equal(positionInRange(null, 0, 10), null)

// ---------------------------------------------------------------------------
// 2. Presentational primitives render semantics without data access
// ---------------------------------------------------------------------------
const banner = renderToStaticMarkup(createElement(TabBanner, { icon: TrendingUp, id: 't', title: 'タイトル', lead: 'リード', flow: ['結論', '根拠', '詳細'] }))
assert.match(banner, /<h2 id="t"/)
assert.match(banner, /aria-label="読む順番"/)
assert.ok(banner.indexOf('結論') < banner.indexOf('根拠') && banner.indexOf('根拠') < banner.indexOf('詳細'))

const tip = renderToStaticMarkup(createElement(DefinitionTip, { term: 'ROE', children: '式' }))
assert.match(tip, /<button[^>]*type="button"/, 'Definitions are opened by a button, not hover')
assert.match(tip, /aria-expanded="false"/)
assert.match(tip, /aria-label="ROEの定義"/)
assert.doesNotMatch(tip, /role="note"/, 'Closed definition renders no popover')

const ruler = renderToStaticMarkup(createElement(RangeRuler, {
  low: 10, high: 20, current: 25, median: 15,
  lowText: '5% 10.00倍', highText: '95% 20.00倍', currentText: '25.00倍', medianText: '中央値 15.00倍', ariaLabel: 'レンジ',
}))
assert.match(ruler, /role="img"/)
assert.match(ruler, /端に寄せて表示/, 'A value outside the band is explicitly flagged, not silently clamped')

const band = renderToStaticMarkup(createElement(PeerBand, {
  label: '予想PER', p25: 10, median: 15, p75: 20, target: 17, targetText: '17.00倍', medianText: '15.00倍',
}))
assert.match(band, /中央値〜P75/)
assert.doesNotMatch(band, /割安|割高/)
const degenerate = renderToStaticMarkup(createElement(PeerBand, {
  label: 'x', p25: 10, median: 10, p75: 10, target: 10, targetText: '', medianText: '',
}))
assert.match(degenerate, /帯を描けません/)

const ladder = renderToStaticMarkup(createElement(BarLadder, {
  mode: 'signed',
  rows: [
    { key: 'a', label: '売上', value: 10, text: '+10.0%' },
    { key: 'b', label: 'EPS', value: -5, text: '-5.0%' },
    { key: 'c', label: 'ROIC', value: null, text: '対象外' },
  ],
}))
assert.doesNotMatch(ladder, /price-up|price-down/, 'Generic bars never use market up/down colors')
assert.match(ladder, /対象外/)

// ---------------------------------------------------------------------------
// 3. StockDecisionSummary: fundamental variant is isolated; overview is unchanged
// ---------------------------------------------------------------------------
const overviewHtml = renderToStaticMarkup(createElement(StockDecisionSummary, { ticker: '7203.T', analysisDate: null, quote: null }))
assert.match(overviewHtml, /data-section="Market Structure"/)
assert.match(overviewHtml, /業種内の位置/)
assert.match(overviewHtml, /aria-labelledby="fundamental-summary-title-overview"/)
assert.match(overviewHtml, /data-section="Fundamental Summary"/)
assert.match(overviewHtml, /ファンダメンタルで詳しく見る/)
assert.match(overviewHtml, /業績・成長/)
assert.match(overviewHtml, /収益性・効率/)
assert.match(overviewHtml, /株価の評価/)
assert.match(overviewHtml, /株主還元/)
assert.doesNotMatch(overviewHtml, /5軸の現在地|data-axis=/, 'Overview never receives the 5-axis board')
assert.ok(overviewHtml.indexOf('Market Structure') < overviewHtml.indexOf('Fundamental Summary'))

const fundamentalHtml = renderToStaticMarkup(createElement(StockDecisionSummary, { ticker: '7203.T', analysisDate: null, quote: null, variant: 'fundamental' }))
assert.match(fundamentalHtml, /aria-labelledby="fundamental-summary-title-fundamental"/)
assert.match(fundamentalHtml, /5軸の現在地/)
for (const axis of ['growth', 'profitability', 'safety', 'valuation', 'returns']) {
  assert.match(fundamentalHtml, new RegExp(`data-axis="${axis}"`), `axis: ${axis}`)
}
for (const title of ['成長', '収益性', '財務安全性', '株価の位置', '株主還元']) {
  assert.match(fundamentalHtml, new RegExp(`>${title}<`), `axis title: ${title}`)
}
assert.doesNotMatch(fundamentalHtml, /Market Structure|業種内の位置/)

// Source-level isolation: the early return precedes the untouched overview JSX.
const earlyReturn = summary.indexOf("if (variant === 'fundamental') {")
assert.ok(earlyReturn > 0)
assert.ok(earlyReturn < summary.indexOf('data-section="Market Structure"'))
assert.match(summary, /let pending = 1 \+ \(variant === 'overview' \? 1 : 0\) \+ \(variant === 'overview' && !hasSharedPhysicalMomentum \? 1 : 0\)/)
assert.match(summary, /if \(variant === 'overview'\) \{\s+getJson<StockSectorContextResult>\(urls\.sector/)
assert.equal(count(summary, /urls\.sector/g), 1)
assert.match(summary, /<MetricLadder title=\{group\.ladderTitle\}/)
assert.match(summary, /grid gap-x-6 gap-y-5 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4/)
assert.match(summary, /overflow-hidden rounded-\[var\(--radius-card\)\] border border-\[var\(--color-border-default\)\] bg-white/)
assert.doesNotMatch(summary, /shadow-\[0_1px_3px_rgba\(16,32,52,0\.05\)\]/)
assert.match(summary, /配当性向\(実績\) 利益に対する配当の割合/)
{
  const overviewJsx = summary.slice(summary.indexOf('return (\n    <div className="space-y-4 md:space-y-6">'))
  assert.ok(overviewJsx.length > 0 && overviewJsx.startsWith('return ('), 'overview JSX block is located')
  assert.doesNotMatch(overviewJsx, /FundamentalSummaryBoard|fundamental-axis/, 'Board is referenced only by the fundamental branch')
  assert.match(overviewJsx, /variant === 'overview' && \(/, 'Market Structure stays overview-only')
}

// The board: reading order, neutral vocabulary and navigation
assert.match(board, /flow=\{\['現在地\(5軸\)', '根拠の数値', '各タブで詳細'\]\}/)
{
  const ordered = ['aria-label="5軸の現在地"', 'id="growth"', 'id="profitability"', 'id="safety"', 'id="valuation"', 'id="returns"', '<footer']
  let at = -1
  for (const marker of ordered) {
    const index = board.indexOf(marker)
    assert.ok(index > at, `board order: ${marker}`)
    at = index
  }
}
for (const tab of ['performance', 'financial', 'valuation', 'returns']) {
  assert.match(board, new RegExp(`tab="${tab}"`), `axis links to ${tab}`)
}
assert.match(board, /割安・割高の判定はしません/)
assert.doesNotMatch(board, /割安です|割高です|買い|売り|目標株価|スコア/)
assert.match(board, /scrollIntoView/, 'Chips jump with scrollIntoView, not hash anchors that collide with tab routing')
assert.doesNotMatch(board, /href="#/)

// Board renders deterministic overview facts (no network in SSR) with unified vocabulary
function point(value: number | null, overrides: Partial<FinancialOverviewValue> = {}): FinancialOverviewValue {
  return {
    value,
    unit: null,
    availability: value == null ? 'missing' : 'available',
    reason: null,
    periodStart: null,
    periodEnd: null,
    publishedAt: null,
    consolidationScope: null,
    accountingStandard: null,
    definitionVersion: null,
    inputIds: [],
    ...overrides,
  }
}
const scope = (revenue: number | null, operatingProfit: number | null, eps: number | null, dps: number | null) => ({
  targetFiscalYear: 2026,
  publishedAt: null,
  revenue: point(revenue),
  operatingProfit: point(operatingProfit),
  netIncome: point(null),
  eps: point(eps),
  dps: point(dps),
})
const fixture: FinancialOverviewReadModel = {
  contractVersion: 'financial-overview-v1',
  ticker: '7203.T',
  asOf: '2026-06-30',
  priceDate: '2026-06-30',
  isFinancialSector: false,
  classification: { name: null, marketSegment: null, sector17: null, sector33: null },
  performanceAndGrowth: {
    latestFyRevenue: point(9e11),
    ltmRevenue: point(1e12),
    ltmRevenueGrowth: point(7.2),
    latestFyOperatingProfit: point(1e11),
    ltmOperatingProfit: point(1.1e11),
    operatingMargin: point(11),
    eps: point(150),
    epsGrowth: point(4),
    revenueCagr3y: point(5),
    revenueCagr5y: point(3),
  },
  quality: {
    roe: point(12),
    roa: point(5),
    roic: point(null, { availability: 'not_applicable', reason: { code: 'not_applicable_financial_sector', message: '金融業では適用外' } }),
    simpleFcf: point(5e10),
  },
  valuation: {
    marketCapitalization: point(2e12),
    per: point(15),
    forwardPer: point(14.2),
    pbr: point(1.4),
    psr: point(1.1),
  },
  shareholderReturns: {
    actualDps: point(60),
    currentForecastDps: point(70),
    dividendYield: point(3.1),
    payoutRatio: point(35),
  },
  forecasts: {
    currentFy: scope(1.1e12, 1.2e11, 160, 70),
    nextFy: scope(null, null, null, null),
  },
  coverage: { facts: 1, sourceFacts: 1, derivedFacts: 0, forecastSnapshots: 1, calculatedMetrics: 1, ltmAvailable: true },
}
const boardHtml = renderToStaticMarkup(createElement(FundamentalSummaryBoard, {
  ticker: '7203.T',
  analysisDate: null,
  financial: fixture,
  loading: false,
  failed: false,
  financialAsOf: '2026-06-30',
}))
assert.match(boardHtml, /\+7\.2%/)
assert.match(boardHtml, /14\.2倍/)
assert.match(boardHtml, /3\.1%/)
assert.match(boardHtml, /直近1年の売上成長は3年CAGRを上回る/)
assert.match(boardHtml, /今期会社予想の売上高はLTMを上回る/)
assert.match(boardHtml, /今期予想DPSは実績を上回る/)
assert.match(boardHtml, /対象外/, 'not_applicable ROIC is shown as 対象外')
assert.doesNotMatch(boardHtml, /N\/A|N\/M/, 'Raw N/A and N/M never reach the board')
assert.doesNotMatch(boardHtml, /price-up|price-down/, 'Board never uses market up/down colors')
assert.match(boardHtml, /読み込んでいます/, 'Remote-only axes degrade to a compact loading state in SSR')

// ---------------------------------------------------------------------------
// 4. Performance
// ---------------------------------------------------------------------------
for (const heading of ['実績と会社予想', '直近の水準', '業績グラフ', '収益性の推移', '会社予想修正履歴']) {
  assert.match(performance, new RegExp(`title="${heading}"|>${heading}<`), `performance heading: ${heading}`)
}
{
  const order = ['<ActualVersusForecast', '<RecentLevel', 'id="performance-chart-title"', 'id="profitability-title"', '<ForecastHistory']
  let at = -1
  for (const marker of order) {
    const index = performance.indexOf(marker)
    assert.ok(index > at, `performance order: ${marker}`)
    at = index
  }
}
assert.match(performance, /<YoyStrip metric=\{selectedMetric\}/, 'YoY direction is always visible, not tooltip-only')
assert.match(performance, /revision\.ratePercent/, 'Revisions are surfaced next to the forecast')
{
  const chart = slice(performance, 'function PerformanceChart', 'function YoyStrip')
  assert.equal(count(chart, /<Bar\b/g), 1, 'Actual/forecast share one bar series so bars stay category-centered')
  assert.match(chart, /<Cell/)
  assert.doesNotMatch(chart, /dataKey="currentForecast"|dataKey="nextForecast"|dataKey="actual"/)
  assert.match(chart, /pointType/)
}
assert.match(performance, /md:hidden/)
assert.match(performance, /hidden overflow-x-auto[^"]*md:block/, 'Tables are desktop-only; phones get cards')
assert.match(performance, /ErrorBlock/)
assert.match(performance, /window\.matchMedia\('\(min-width: 1024px\)'\)/)
assert.equal(count(performance, /\/api\/financial-performance-detail\//g), 1)
assert.match(performance, /as_of=/)

// ---------------------------------------------------------------------------
// 5. Financials: Safety / Profitability / Capital efficiency / Cash generation
// ---------------------------------------------------------------------------
for (const tab of ['まとめ', '指標', 'P/L', 'B/S', 'C/F']) {
  assert.match(financial, new RegExp(`label: '${tab.replace('/', '\\/')}'`), `Financial subtab: ${tab}`)
}
assert.match(financial, /role="tablist"/)
{
  const summaryBody = slice(financial, 'function FinancialSummary', 'function tipLabel')
  const order = ['title="安全性"', 'title="収益性"', 'title="資本効率"', 'title="キャッシュ創出"']
  let at = -1
  for (const marker of order) {
    const index = summaryBody.indexOf(marker)
    assert.ok(index > at, `financial view order: ${marker}`)
    at = index
  }
  for (const source of ['source="B/S"', 'source="P/L"', 'source="P/L × B/S"', 'source="C/F"']) {
    assert.ok(summaryBody.includes(source), `each view names its statement: ${source}`)
  }
  assert.equal(count(summaryBody, /ratioBar\('roe'/g), 1, 'ROE appears once in the summary')
  assert.equal(count(summaryBody, /label="EPS\(P\/L由来\)"/g), 1, 'EPS appears once')
  assert.equal(count(summaryBody, /label="BPS\(B\/S由来\)"/g), 1, 'BPS appears once')
}
{
  // Visible equity-ratio supplemental line is Japanese presentation copy; the canonical
  // English formula stays untouched in the metric registry and definition panels.
  const summaryBody = slice(financial, 'function FinancialSummary', 'function ViewPanel')
  assert.match(summaryBody, /EQUITY_RATIO_SUMMARY_NOTE = '最新開示値\(親会社帰属ベース\)'/)
  assert.doesNotMatch(summaryBody, /Latest reported attributable equity ratio/, 'English formula never hard-coded in the visible summary')
  const meterLine = slice(summaryBody, 'label="自己資本比率"', '総資産')
  assert.match(meterLine, /tipLabel\(model, 'equity_ratio'\)/)
  assert.match(slice(financial, 'function tipLabel', 'function ViewPanel'), /key === 'equity_ratio'\) return EQUITY_RATIO_SUMMARY_NOTE/)
  assert.doesNotMatch(financial, /Latest reported attributable equity ratio/, 'FinancialDetail never embeds the canonical formula text')
  const metrics = source('lib/financial-metrics.ts')
  assert.ok(
    metrics.includes("key: 'equity_ratio', displayName: '自己資本比率', formula: 'Latest reported attributable equity ratio',"),
    'Canonical equity_ratio formula in the registry is unchanged',
  )
  assert.ok(metrics.includes("requiredInputs: ['equity_ratio:instant']"))
  assert.ok(metrics.includes("version: 'equity-ratio-reported-v1'"))
  // Definition panels still render the canonical formula untouched.
  assert.match(financial, /<span className="block">\{definition\.formula\}<\/span>/)
  assert.match(financial, /<div>\{definition\.formula\}<\/div>/)
}
assert.match(financial, /B\/S・P\/L・C\/Fのつながり/)
assert.match(financial, /function StatementLinks/)
assert.match(financial, /period\.periodEnd === pl\.periodEnd/, 'The 3-statement link only compares values from the same period')
assert.match(financial, /function StatementFlow/)
assert.match(financial, /<DefinitionTip/, 'Definitions open by tap')
assert.doesNotMatch(financial, /#1d4ed8|#0f766e|#7c3aed/, 'CF chart uses tokens, not one-off hex colors')
assert.match(financial, /md:hidden/)
assert.match(financial, /hidden overflow-x-auto md:block/)
assert.equal(count(financial, /\/api\/financial-detail\//g), 1)
assert.match(financial, /as_of=/)

// ---------------------------------------------------------------------------
// 6. Valuation: one view for current / own history / peers, never a verdict
// ---------------------------------------------------------------------------
for (const heading of ['現在の評価', '自社過去と同業の中での位置', '自社過去レンジの詳細', '同業の分布']) {
  assert.match(valuation, new RegExp(heading), `valuation heading: ${heading}`)
}
{
  const order = ['<CurrentValuation', '<PositionOverview', '<HistoricalRange', '<PeerComparison', '<Definitions']
  let at = -1
  for (const marker of order) {
    const index = valuation.indexOf(marker)
    assert.ok(index > at, `valuation order: ${marker}`)
    at = index
  }
}
assert.match(valuation, /<RangeRuler/)
assert.match(valuation, /<PeerBand/)
assert.match(valuation, /directionFromMedianComparison/)
assert.match(valuation, /より高い/)
assert.match(valuation, /より低い/)
for (const line of valuation.split('\n')) {
  if (/割安|割高/.test(line)) {
    assert.match(line, /しません|断定|判定/, `Valuation must not classify cheap/expensive: ${line.trim()}`)
  }
}
assert.doesNotMatch(valuation, /おすすめ|推奨します|買い時|売り時|適正株価|目標株価/)
assert.match(valuation, /観測 n=/)
assert.match(valuation, /観測期間が限定的/)
assert.match(valuation, /percentage_point/)
assert.doesNotMatch(valuation, /filter\(\(value\) => value\.availability !== 'missing'\)/)
assert.equal(count(valuation, /\/api\/valuation-detail\//g), 1)
assert.match(valuation, /as_of=/)

// ---------------------------------------------------------------------------
// 7. Shareholder return: continuity + capacity, compact buyback state
// ---------------------------------------------------------------------------
for (const heading of ['現在の還元', '継続性', '余力', '配当履歴']) {
  assert.match(returns, new RegExp(heading), `returns heading: ${heading}`)
}
{
  const order = ['<CurrentReturns', '<DividendContinuity', '<DividendCapacity', '<DividendHistory', '<ForecastRevisionHistory', '<DefinitionNotes']
  let at = -1
  for (const marker of order) {
    const index = returns.indexOf(marker)
    assert.ok(index > at, `returns order: ${marker}`)
    at = index
  }
}
assert.doesNotMatch(returns, /持続可能性・自社株買いを確認/, 'Capacity is no longer hidden in a collapsed <details>')
assert.match(returns, /data-dividend-direction=\{row\.direction\}/, 'Year-by-year direction metadata is visible')
assert.match(returns, /consecutiveIncreaseYears/)
assert.match(returns, /fcfDividendCoverage/)
{
  const buyback = slice(returns, 'data-section="buybacks"', '/* 4. 配当履歴')
  assert.match(buyback, /<UnavailableNote>/, 'Missing buyback data is one compact explicit note')
  assert.match(buyback, /データなし/)
  assert.doesNotMatch(buyback, /grid-cols-2 gap-px/, 'No large empty two-cell block for missing buyback data')
  assert.doesNotMatch(buyback, /—<\/div>/)
}
assert.match(returns, /stackId=\{overlap \? undefined : 'dps'\}/, 'DPS bars stay centered when actual/forecast never share a year')
assert.doesNotMatch(returns, /--color-market-red|--color-price-up/, 'Forecast bars use brand tokens, not market colors')
assert.equal(count(returns, /\/api\/shareholder-returns\//g), 1)
assert.match(returns, /as_of=/)

// ---------------------------------------------------------------------------
// 8. Cross-cutting quality gates
// ---------------------------------------------------------------------------
for (const { name, text } of redesigned) {
  assert.doesNotMatch(text, /text-\[(?:7|8|9|10)px\]/, `${name}: explanatory text must be at least 11px`)
  assert.doesNotMatch(text, /fontSize:\s*(?:7|8|9|10)\b/, `${name}: chart text must be at least 11px`)
  assert.doesNotMatch(text, /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/, `${name}: no one-off hex colors`)
  assert.doesNotMatch(text, /\b(?:bg|text|border)-(?:amber|red|green|emerald|yellow)-\d{2,3}/, `${name}: no raw Tailwind palette colors`)
  assert.doesNotMatch(text, /--price-up|--price-down|--color-price-up|--color-price-down|--color-market-red/, `${name}: price colors are not generic decoration`)
  assert.doesNotMatch(text, /<svg/, `${name}: icons come from lucide-react`)
  assert.doesNotMatch(text, /<ResponsiveContainer/, `${name}: charts use MeasuredChartFrame`)
  if (name !== 'format.ts') {
    // format.ts is the one place that maps the legacy N/A・N/M tokens onto the unified vocabulary.
    assert.doesNotMatch(text, /'N\/A'|'N\/M'|"N\/A"|"N\/M"/, `${name}: unavailable wording is normalized`)
  }
}
for (const text of [performance, financial, valuation, returns]) {
  assert.match(text, /<MeasuredChartFrame/)
  assert.match(text, /<TabBanner/)
  assert.match(text, /flow=\{\[/, 'each subtab declares its reading order')
  assert.match(text, /LoadingBlock/)
  assert.match(text, /ErrorBlock/)
  assert.match(text, /setReloadKey/, 'error states can retry')
}
assert.match(source('components/stock/fundamentals/primitives.tsx'), /pointer-coarse:h-9/, 'Definition tips get a larger touch target')
assert.match(source('components/stock/fundamentals/primitives.tsx'), /aria-expanded=\{open\}/)
assert.match(source('components/stock/fundamentals/primitives.tsx'), /Escape/)

console.log('stock detail fundamentals redesign tests passed')
