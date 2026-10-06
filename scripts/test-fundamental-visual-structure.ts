import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

const stockDetail = source('app/stock/[ticker]/StockDetailClient.tsx')
const summary = source('components/stock/StockDecisionSummary.tsx')
const fundamentalSummary = source('components/stock/fundamentals/FundamentalSummaryBoard.tsx')
const fundamentalPrimitives = source('components/stock/fundamentals/primitives.tsx')
const performance = source('components/stock/FinancialPerformanceDetail.tsx')
const financial = source('components/stock/FinancialDetail.tsx')
const valuation = source('components/stock/ValuationDetail.tsx')
const returns = source('components/stock/ShareholderReturnsDetail.tsx')
const measuredChart = source('components/charts/MeasuredChartFrame.tsx')
const overviewReadModel = source('lib/server/financial-overview-read-model.ts')
const metricRegistry = source('lib/financial-metrics.ts')

const workspace = stockDetail.slice(
  stockDetail.indexOf('function FundamentalWorkspace'),
  stockDetail.indexOf('function OverviewWorkspace'),
)
const tabs = ['サマリー', '業績', '財務', 'バリュエーション', '株主還元']
let cursor = -1
for (const tab of tabs) {
  const index = workspace.indexOf(`label: '${tab}'`)
  assert.ok(index > cursor, `Fundamental tab order: ${tab}`)
  cursor = index
}
assert.equal((workspace.match(/\{ id: '/g) ?? []).length, 5)
assert.match(workspace, /role="tablist"/)
assert.match(workspace, /aria-selected=\{active === id\}/)
assert.match(workspace, /h-11/)

assert.match(summary, /variant === 'fundamental'/)
assert.match(summary, /<FundamentalSummaryBoard/)
assert.match(summary, /if \(variant === 'fundamental'\)/)
for (const axis of ['growth', 'profitability', 'safety', 'valuation', 'returns']) {
  assert.match(fundamentalSummary, new RegExp(`id="${axis}"`), `Fundamental summary axis: ${axis}`)
}
for (const label of ['成長', '収益性', '財務安全性', '株価の位置', '株主還元']) {
  assert.match(fundamentalSummary, new RegExp(`title="${label}"|label: '${label}'`), `Fundamental summary label: ${label}`)
}
assert.match(fundamentalSummary, /aria-label="5軸の現在地"/)
assert.match(fundamentalSummary, /自社過去5年の中央値/)
assert.match(fundamentalSummary, /33業種の中央値/)
assert.match(fundamentalSummary, /割安・割高の判定はしません/)
assert.match(fundamentalPrimitives, /function RangeRuler/)
assert.match(fundamentalPrimitives, /function PeerBand/)
assert.match(overviewReadModel, /latestFact\(facts, 'revenue', 'LTM'\)/)
assert.match(overviewReadModel, /latestFact\(facts, 'operating_profit', 'LTM'\)/)
assert.match(metricRegistry, /key: 'eps',[\s\S]*?periodBasis: 'LTM'/)
assert.match(metricRegistry, /key: 'roe',[\s\S]*?periodBasis: 'LTM'/)

const components = [performance, financial, valuation, returns]
const endpoints = [
  '/api/financial-performance-detail/',
  '/api/financial-detail/',
  '/api/valuation-detail/',
  '/api/shareholder-returns/',
]
components.forEach((component, index) => {
  assert.equal(
    (component.match(new RegExp(endpoints[index].replaceAll('/', '\\/'), 'g')) ?? []).length,
    1,
    `${endpoints[index]} must be fetched by one component path`,
  )
  assert.match(component, /as_of=/, `${endpoints[index]} must preserve analysisDate`)
  assert.doesNotMatch(component, /text-\[(?:7|8)px\]/, `${endpoints[index]} must avoid 7px/8px UI text`)
  assert.doesNotMatch(component, /fontSize:\s*(?:7|8)\b/, `${endpoints[index]} chart ticks must remain readable`)
})

assert.match(performance, /業績グラフ/)
assert.match(performance, /実績と会社予想を同じ尺度で並べ/)
assert.match(performance, /<PerformanceRawTable periods=\{periods\} \/>/)
assert.match(performance, /会社予想修正履歴/)
assert.match(performance, /window\.matchMedia\('\(min-width: 1024px\)'\)/)
assert.match(performance, /const \[selectedMetric, setSelectedMetric\]/)
assert.match(performance, /<PerformanceChart metric=\{selectedMetric\} periods=\{periods\} \/>/)
assert.doesNotMatch(performance, /FINANCIAL_PERFORMANCE_DETAIL_METRICS\.map\(\(metric\) => \(\s*<PerformanceChart/)
assert.match(performance, /h-\[250px\][^\n]*sm:h-\[330px\]/)

for (const tab of ['まとめ', '指標', 'P/L', 'B/S', 'C/F']) {
  assert.match(financial, new RegExp(`label: '${tab.replace('/', '\\/')}'`), `Financial tab: ${tab}`)
}
assert.match(financial, /role="tablist"/)
assert.match(financial, /aria-selected=\{subtab === tab\.id\}/)
assert.match(financial, /title="4つの観点"/)
for (const section of ['安全性', '収益性', '資本効率', 'キャッシュ創出']) {
  assert.match(financial, new RegExp(`title="${section}"`), `Financial viewpoint: ${section}`)
}
assert.match(financial, /title="B\/S・P\/L・C\/Fのつながり"/)

for (const section of ['現在の評価', '自社過去と同業の中での位置', '自社過去レンジの詳細', '同業の分布']) {
  assert.match(valuation, new RegExp(section), `Valuation section: ${section}`)
}
assert.match(valuation, /<RangeRuler/)
assert.match(valuation, /<PeerBand/)
assert.match(valuation, /割安・割高の判定や推奨はしません/)

const returnsOrder = [
  '<CurrentReturns',
  '<DividendContinuity',
  '<DividendCapacity',
  '<DividendHistory',
  '<ForecastRevisionHistory',
]
cursor = -1
for (const marker of returnsOrder) {
  const index = returns.indexOf(marker)
  assert.ok(index > cursor, `Shareholder returns order: ${marker}`)
  cursor = index
}
assert.match(returns, /現在の還元/)
assert.match(returns, /継続性\(配当の向き\)/)
assert.match(returns, /余力\(利益とキャッシュで賄えているか\)/)
assert.match(returns, /配当履歴/)
for (const component of [performance, financial, valuation, returns]) {
  assert.match(component, /<MeasuredChartFrame/)
  assert.doesNotMatch(component, /<ResponsiveContainer/)
}
assert.match(measuredChart, /new ResizeObserver/)
assert.match(measuredChart, /next\.width > 0 && next\.height > 0/)

console.log('fundamental visual structure tests passed')
