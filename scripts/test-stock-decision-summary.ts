import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildStockDecisionSummaryUrls,
  formatFinancialSummaryValue,
  summarizeMaStructure,
} from '@/lib/stock-decision-summary'
import type { FinancialOverviewValue } from '@/lib/server/financial-overview-read-model'

function point(overrides: Partial<FinancialOverviewValue>): FinancialOverviewValue {
  return {
    value: null,
    unit: null,
    availability: 'missing',
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

const urls = buildStockDecisionSummaryUrls('7203.T', '2026-06-30', 'nikkei225')
assert.match(urls.financial, /as_of=2026-06-30/)
assert.match(urls.physical, /date=2026-06-30/)
assert.match(urls.sector, /taxonomy=33/)
assert.match(urls.sector, /universe=nikkei225/)

assert.equal(formatFinancialSummaryValue(point({
  value: 7.233,
  availability: 'available',
}), 'percent', { signed: true }).text, '+7.2%')
assert.equal(formatFinancialSummaryValue(point({
  value: 11.921,
  availability: 'available',
}), 'percent').text, '11.9%')
assert.equal(formatFinancialSummaryValue(point({
  availability: 'not_applicable',
  reason: { code: 'not_applicable_financial_sector', message: '金融業では適用外' },
}), 'multiple').text, 'N/A')
assert.equal(formatFinancialSummaryValue(point({
  reason: { code: 'per_inputs_missing_or_nm', message: '利益が負のため算定不能' },
}), 'multiple').text, 'N/M')
assert.equal(formatFinancialSummaryValue(point({
  reason: { code: 'no_current_fy_forecast_as_of', message: '予想なし' },
}), 'per_share', { forecast: true }).text, '予想なし')
assert.equal(formatFinancialSummaryValue(point({}), 'currency').text, '—')

const rad = (degrees: number) => degrees * Math.PI / 180
assert.equal(summarizeMaStructure({
  ma5Angle: rad(8),
  ma25Angle: rad(5),
  ma75Angle: rad(3),
  ma200Angle: rad(1),
}), '上方向へ拡散')
assert.equal(summarizeMaStructure({
  ma5Angle: rad(5),
  ma25Angle: rad(2),
  ma75Angle: rad(-2),
  ma200Angle: rad(-4),
}), '短期上向き・長期収縮')

const stockDetailSource = readFileSync(
  new URL('../app/stock/[ticker]/StockDetailClient.tsx', import.meta.url),
  'utf8',
)
const summarySource = readFileSync(
  new URL('../components/stock/StockDecisionSummary.tsx', import.meta.url),
  'utf8',
)

const topTabs = stockDetailSource.slice(
  stockDetailSource.indexOf('function StockDetailTabs'),
  stockDetailSource.indexOf('function FundamentalWorkspace'),
)
const topTabLabels = ['概要', 'チャート・6ステージ', 'ファンダメンタル', 'シナリオ', '類似・比較']
let previousIndex = -1
for (const label of topTabLabels) {
  const index = topTabs.indexOf(`label: '${label}'`)
  assert.ok(index > previousIndex, `top tab order: ${label}`)
  previousIndex = index
}
assert.equal((topTabs.match(/\{ id: '/g) ?? []).length, 5)

const fundamentalWorkspace = stockDetailSource.slice(
  stockDetailSource.indexOf('function FundamentalWorkspace'),
  stockDetailSource.indexOf('function OverviewWorkspace'),
)
const fundamentalLabels = ['サマリー', '業績', '財務', 'バリュエーション', '株主還元', '企業情報']
previousIndex = -1
for (const label of fundamentalLabels) {
  const index = fundamentalWorkspace.indexOf(`label: '${label}'`)
  assert.ok(index > previousIndex, `fundamental tab order: ${label}`)
  previousIndex = index
}

const overviewRoute = stockDetailSource.slice(
  stockDetailSource.indexOf("{activeTab === 'overview'"),
  stockDetailSource.indexOf("{activeTab === 'chart'"),
)
assert.match(overviewRoute, /<OverviewWorkspace/)
const overview = stockDetailSource.slice(
  stockDetailSource.indexOf('function OverviewWorkspace'),
  stockDetailSource.indexOf('function OverviewBasicInfoPanel'),
)
const overviewOrder = [
  '<OverviewBasicInfoPanel',
  '<StockDecisionSummary',
  '<FinancialPerformanceTimeline',
]
previousIndex = -1
for (const marker of overviewOrder) {
  const index = overview.indexOf(marker)
  assert.ok(index > previousIndex, `overview order: ${marker}`)
  previousIndex = index
}
assert.equal(
  (overview.match(/fetch\(physicalUrl/g) ?? []).length,
  1,
  'Overview must fetch physical momentum exactly once and share it by props',
)
const basicInfoCard = stockDetailSource.slice(
  stockDetailSource.indexOf('function BasicInfoCard'),
  stockDetailSource.indexOf('function buildBasicDecisionSummary'),
)
assert.doesNotMatch(basicInfoCard, /\/api\/physical-momentum/, 'BasicInfoCard must not issue a duplicate physical request')

for (const legacyHash of ['performance', 'financial', 'valuation', 'returns', 'company']) {
  assert.match(stockDetailSource, new RegExp(`hash === '${legacyHash}'`))
}
assert.match(stockDetailSource, /hash === 'shikiho'/)

const stageLabels = ['日A', '日B', '週A', '週B', '月A', '月B']
const stageKeys = stockDetailSource.slice(
  stockDetailSource.indexOf('const SUMMARY_STAGE_KEYS'),
  stockDetailSource.indexOf('function MarketSnapshotCard'),
)
previousIndex = -1
for (const label of stageLabels) {
  const index = stageKeys.indexOf(`label: '${label}'`)
  assert.ok(index > previousIndex, `stage order: ${label}`)
  previousIndex = index
}

assert.ok(summarySource.indexOf('Market Structure') < summarySource.indexOf('Fundamental Summary'))
assert.doesNotMatch(summarySource, /function StageStrip/)
assert.match(summarySource, /33業種 構造順位/)
assert.match(summarySource, /33業種平均との差/)

console.log('stock decision summary tests passed')
