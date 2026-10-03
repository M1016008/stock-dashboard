import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

const stockDetail = source('app/stock/[ticker]/StockDetailClient.tsx')
const summary = source('components/stock/StockDecisionSummary.tsx')
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
assert.match(summary, /function FundamentalEditorialSummary/)
for (const label of ['売上高', '営業利益', 'EPS', 'ROE']) {
  assert.match(summary, new RegExp(`metric\\('${label}'`), `primary summary metric: ${label}`)
}
assert.match(summary, /const ltmBasis = 'LTM \/ 直近12か月'/)
assert.match(summary, /metric\('売上高', financial\?\.performanceAndGrowth\.ltmRevenue, 'currency'\), periodBasis: ltmBasis/)
assert.match(summary, /metric\('営業利益', financial\?\.performanceAndGrowth\.ltmOperatingProfit, 'currency'\), periodBasis: ltmBasis/)
assert.match(summary, /metric\('EPS', financial\?\.performanceAndGrowth\.eps, 'per_share'\), periodBasis: ltmBasis/)
assert.match(summary, /metric\('ROE', financial\?\.quality\.roe, 'percent'\), periodBasis: ltmBasis/)
assert.match(summary, /item\.value\.reason \?\? item\.periodBasis \?\? '直近利用可能値'/)
assert.match(summary, /lg:grid-cols-\[minmax\(0,1\.4fr\)_minmax\(320px,1fr\)\]/)
assert.match(summary, /業績・成長/)
assert.match(summary, /評価・資本効率/)
assert.match(overviewReadModel, /latestFact\(facts, 'revenue', 'LTM'\)/)
assert.match(overviewReadModel, /latestFact\(facts, 'operating_profit', 'LTM'\)/)
assert.match(metricRegistry, /key: 'eps',[\s\S]*?periodBasis: 'LTM'/)
assert.match(metricRegistry, /key: 'roe',[\s\S]*?periodBasis: 'LTM'/)
assert.match(summary, /補足指標/)
assert.match(summary, /<details className="border-t/)

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
assert.match(performance, /実績と会社予想を塗り・輪郭・ラベルで区別/)
assert.match(performance, /<details className="group border-t/)
assert.match(performance, /<Table2 size=\{13\} \/>原表/)
assert.match(performance, /会社予想修正履歴/)
assert.match(performance, /window\.matchMedia\('\(min-width: 1024px\)'\)/)
assert.doesNotMatch(performance, /hidden grid-cols-2 lg:grid/)
assert.match(performance, /const \[selectedMetric, setSelectedMetric\]/)
assert.match(performance, /<MetricSwitch value=\{selectedMetric\} onChange=\{setSelectedMetric\} \/>/)
assert.match(performance, /<PerformanceChart metric=\{selectedMetric\} periods=\{periods\} \/>/)
assert.doesNotMatch(performance, /FINANCIAL_PERFORMANCE_DETAIL_METRICS\.map\(\(metric\) => \(\s*<PerformanceChart/)
assert.match(performance, /はこの基準では取得できません。/)
assert.match(performance, /h-\[250px\][^\n]*sm:h-\[330px\]/)

for (const tab of ['まとめ', '指標', 'P/L', 'B/S', 'C/F']) {
  assert.match(financial, new RegExp(`label: '${tab.replace('/', '\\/')}'`), `Financial tab: ${tab}`)
}
assert.match(financial, /role="tablist"/)
assert.match(financial, /aria-selected=\{subtab === tab\.id\}/)
assert.match(financial, /lg:grid-cols-\[0\.95fr_1\.05fr_1\.2fr_0\.8fr\]/)
assert.match(financial, /primaryLabels=\{\['営業CF', '簡易FCF'\]\}/)
assert.match(financial, /primaryLabels=\{\['自己資本比率'\]\}/)

for (const section of ['現在の評価', '自社過去レンジ', '同業比較']) {
  assert.match(valuation, new RegExp(section), `Valuation section: ${section}`)
}
assert.match(valuation, /の現在位置/)
assert.match(valuation, /過去\{HISTORY_WINDOWS/)

const returnsOrder = [
  '<CurrentReturns',
  '<DividendDirectionSummary',
  '<DividendHistory',
  '<ForecastRevisionHistory',
]
cursor = -1
for (const marker of returnsOrder) {
  const index = returns.indexOf(marker)
  assert.ok(index > cursor, `Shareholder returns order: ${marker}`)
  cursor = index
}
assert.match(returns, /持続可能性・自社株買いを確認/)
assert.match(returns, /aria-label="現在の還元と配当の方向性"/)
assert.match(returns, /<details className="overflow-hidden border-y/)
for (const component of [performance, financial, valuation, returns]) {
  assert.match(component, /<MeasuredChartFrame/)
  assert.doesNotMatch(component, /<ResponsiveContainer/)
}
assert.match(measuredChart, /new ResizeObserver/)
assert.match(measuredChart, /next\.width > 0 && next\.height > 0/)

console.log('fundamental visual structure tests passed')
