import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StageTimelineValue } from '@/components/stock/StageTimeline'
import {
  buildStockDecisionSummaryUrls,
  formatFinancialSummaryValue,
  formatTechnicalSnapshotDateLabel,
  selectPhysicalMomentumScoreRow,
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

assert.equal(formatTechnicalSnapshotDateLabel({
  stageDate: '2026-09-04',
  scoreDate: '2026-09-04',
  maDate: '2026-09-04',
}), '基準日 2026-09-04')
assert.equal(formatTechnicalSnapshotDateLabel({
  stageDate: '2026-09-04',
  scoreDate: '2026-09-03',
  maDate: '2026-09-04',
}), 'Stage・MA 2026-09-04 / PMS 2026-09-03')
assert.equal(formatTechnicalSnapshotDateLabel({
  stageDate: '2026-09-04',
  scoreDate: '2026-09-04',
  maDate: '2026-09-03',
}), 'Stage・PMS 2026-09-04 / MA 2026-09-03')
assert.equal(formatTechnicalSnapshotDateLabel({
  stageDate: null,
  scoreDate: null,
  maDate: null,
  analysisDate: '2026-08-25',
}), '分析基準 2026-08-25')

const staleScoreSelection = selectPhysicalMomentumScoreRow({
  latest: {
    date: '2026-09-04',
    physicalMomentumScore: null,
    physicalForceScore: null,
    physicalEnergyScore: null,
  },
  history: [{
    date: '2026-09-03',
    physicalMomentumScore: 0.7,
    physicalForceScore: 0.4,
    physicalEnergyScore: 0.2,
  }],
  latestScoredDate: '2026-09-03',
  isScoreFresh: false,
})
assert.equal(staleScoreSelection.scoreDate, '2026-09-03')
assert.equal(staleScoreSelection.scoreRow?.physicalMomentumScore, 0.7)
assert.notEqual(staleScoreSelection.scoreRow?.date, '2026-09-04')

const nonInteractiveStage = renderToStaticMarkup(createElement(StageTimelineValue, { stage: 2 }))
assert.match(nonInteractiveStage, /^<span/)
assert.doesNotMatch(nonInteractiveStage, /<button/)
assert.match(nonInteractiveStage, /title="S2:/)
const interactiveStage = renderToStaticMarkup(createElement(StageTimelineValue, { stage: 2, onSelect: () => undefined }))
assert.match(interactiveStage, /^<button/)
assert.match(interactiveStage, /type="button"/)
assert.match(interactiveStage, /title="S2:/)

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
const stageTimelineSource = readFileSync(
  new URL('../components/stock/StageTimeline.tsx', import.meta.url),
  'utf8',
)
const ma25mSource = readFileSync(
  new URL('../components/stock/Ma25mMonitorSummary.tsx', import.meta.url),
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
assert.match(topTabs, /h-11[^\n]+sm:h-9/)

const fundamentalWorkspace = stockDetailSource.slice(
  stockDetailSource.indexOf('function FundamentalWorkspace'),
  stockDetailSource.indexOf('function OverviewWorkspace'),
)
const fundamentalLabels = ['サマリー', '業績', '財務', 'バリュエーション', '株主還元']
previousIndex = -1
for (const label of fundamentalLabels) {
  const index = fundamentalWorkspace.indexOf(`label: '${label}'`)
  assert.ok(index > previousIndex, `fundamental tab order: ${label}`)
  previousIndex = index
}
assert.equal((fundamentalWorkspace.match(/\{ id: '/g) ?? []).length, 5)
assert.match(fundamentalWorkspace, /h-11[^\n]+sm:h-9/)
assert.doesNotMatch(fundamentalWorkspace, /label: '企業情報'/)
assert.doesNotMatch(fundamentalWorkspace, /active === 'company'/)
assert.doesNotMatch(fundamentalWorkspace, /<EarningsCard/, 'earnings dates must not be duplicated in Fundamental')

const overviewRoute = stockDetailSource.slice(
  stockDetailSource.indexOf("{activeTab === 'overview'"),
  stockDetailSource.indexOf("{activeTab === 'chart'"),
)
assert.match(overviewRoute, /<OverviewWorkspace/)
const chartWorkspace = stockDetailSource.slice(
  stockDetailSource.indexOf('function ChartWorkspace'),
  stockDetailSource.indexOf('function FundamentalWorkspace'),
)
const chartOrder = [
  '<TechnicalChartSnapshot',
  '<StageTimeline\n',
  '<CandlestickChart',
  '<PhysicalMomentumSection',
  '<Ma25mMonitorSummary',
]
previousIndex = -1
for (const marker of chartOrder) {
  const index = chartWorkspace.indexOf(marker)
  assert.ok(index > previousIndex, `chart workspace order: ${marker}`)
  previousIndex = index
}
assert.match(chartWorkspace, /onSnapshotChange=\{handleStageSnapshot\}/)
assert.match(chartWorkspace, /onSnapshotChange=\{handleMomentumSnapshot\}/)
assert.equal((chartWorkspace.match(/<StageTimeline\n/g) ?? []).length, 1, 'Chart workspace must mount StageTimeline once')
assert.equal((chartWorkspace.match(/<PhysicalMomentumSection/g) ?? []).length, 1, 'Chart workspace must mount PhysicalMomentumSection once')
assert.equal((chartWorkspace.match(/<CandlestickChart/g) ?? []).length, 1, 'Chart workspace must mount CandlestickChart once')
const chartStageAxes = stockDetailSource.slice(
  stockDetailSource.indexOf('const CHART_STAGE_AXES'),
  stockDetailSource.indexOf('function ChartWorkspace'),
)
for (const label of ['日A', '日B', '週A', '週B', '月A', '月B']) {
  assert.match(chartStageAxes, new RegExp(`label: '${label}'`))
}
assert.match(chartWorkspace, /Technical snapshot/)
assert.match(chartWorkspace, /Price &amp; moving averages/)
assert.match(chartWorkspace, /formatTechnicalSnapshotDateLabel/)
assert.match(chartWorkspace, /scoreDate: momentum\.scoreDate/)
assert.match(chartWorkspace, /maDate: momentum\.maDate/)

const physicalMomentumSection = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalMomentumSection'),
  stockDetailSource.indexOf('function PhysicalScoreCard'),
)
assert.equal((physicalMomentumSection.match(/\/api\/physical-momentum\//g) ?? []).length, 1)
assert.equal((physicalMomentumSection.match(/\/api\/stock-physical-plan\//g) ?? []).length, 1)
assert.match(physicalMomentumSection, /aria-controls="physical-momentum-details"/)
assert.match(physicalMomentumSection, /aria-expanded=\{mobileDetailsOpen\}/)
assert.ok(physicalMomentumSection.indexOf('<PhysicalTimeframeConclusionPanel') < physicalMomentumSection.indexOf('<PhysicalTradePlanCards'))
assert.ok(physicalMomentumSection.indexOf('<PhysicalActionPoints') < physicalMomentumSection.indexOf('id="physical-momentum-details"'))
assert.ok(physicalMomentumSection.indexOf('<PhysicalMaFieldMap') < physicalMomentumSection.indexOf('id="physical-momentum-details"'))

assert.equal((stageTimelineSource.match(/fetch\(`\/api\/stage-history\//g) ?? []).length, 1)
assert.match(stageTimelineSource, /onSnapshotChange\?\.\(latest \? \{/)
assert.match(stageTimelineSource, /onSelect=\{onStageRangeSelect \? \(\) => selectStageSegment\(sys, index\) : undefined\}/)
assert.match(stageTimelineSource, /aria-pressed=\{granularity === item\.key\}/)
assert.match(stageTimelineSource, /aria-pressed=\{count === preset\}/)
assert.match(stageTimelineSource, /min-h-11[^"]+sm:min-h-8/)
assert.match(ma25mSource, /月足長期構造/)
assert.match(ma25mSource, /MA接近レーダー/)
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
assert.ok(
  overview.indexOf('const requestTimer = window.setTimeout') < overview.indexOf('fetch(physicalUrl'),
  'Overview physical fetch must wait for direct hash-tab reconciliation',
)
assert.match(overview, /hash !== 'overview' && hash !== 'company' && hash !== 'shikiho'/)
assert.match(overview, /window\.clearTimeout\(requestTimer\)/)
const basicInfoCard = stockDetailSource.slice(
  stockDetailSource.indexOf('function BasicInfoCard'),
  stockDetailSource.indexOf('function buildBasicDecisionSummary'),
)
assert.doesNotMatch(basicInfoCard, /\/api\/physical-momentum/, 'BasicInfoCard must not issue a duplicate physical request')
const marketSnapshotCard = stockDetailSource.slice(
  stockDetailSource.indexOf('function MarketSnapshotCard'),
  stockDetailSource.indexOf('function CurrentOnlyDataNotice'),
)
assert.match(marketSnapshotCard, /その他の騰落率・信用残/)
assert.match(marketSnapshotCard, /aria-expanded=\{mobileExpanded\}/)
assert.match(marketSnapshotCard, /sm:block/)
assert.equal((marketSnapshotCard.match(/<PerformanceCard ticker=\{ticker\}/g) ?? []).length, 1, 'Market snapshot must mount PerformanceCard once')
assert.match(marketSnapshotCard, /mobileExpanded=\{mobileExpanded\}/)
const performanceSource = readFileSync(
  new URL('../components/stock/PerformanceCard.tsx', import.meta.url),
  'utf8',
)
assert.match(performanceSource, /mobilePrimary = index === 0 \|\| index === 2/)
assert.match(performanceSource, /mobileExpanded \? '' : 'hidden sm:block'/)

const overviewBasicInfo = stockDetailSource.slice(
  stockDetailSource.indexOf('function OverviewBasicInfoPanel'),
  stockDetailSource.indexOf('function StockHeaderClassifications'),
)
assert.match(overviewBasicInfo, /id="company-basic-info"/)
assert.match(overviewBasicInfo, /<ShikihoOverviewSection/)
assert.match(overviewBasicInfo, /<OverviewCompanyDetails/)
assert.match(overviewBasicInfo, /<EarningsCard ticker=\{ticker\} compact/)
assert.doesNotMatch(overviewBasicInfo, /<StockClassificationBar/)
assert.match(stockDetailSource, /<CompanyInformationDetail ticker=\{ticker\} analysisDate=\{analysisDate\} \/>/)
assert.match(stockDetailSource, /会社四季報の会社概要は現在情報のため/)

const stockHeader = stockDetailSource.slice(
  stockDetailSource.indexOf('<div className="stock-detail-sticky'),
  stockDetailSource.indexOf('<StockDetailTabs'),
)
assert.match(stockHeader, /<StockHeaderClassifications/)
const headerClassifications = stockDetailSource.slice(
  stockDetailSource.indexOf('function StockHeaderClassifications'),
  stockDetailSource.indexOf('function ShikihoOverviewSection'),
)
for (const label of ['市場', '33業種', '独自60分類', '独自細分類', '17業種']) {
  assert.match(headerClassifications, new RegExp(`label: '${label}'`))
}
assert.ok(headerClassifications.indexOf("label: '33業種'") < headerClassifications.indexOf("label: '17業種'"))
assert.doesNotMatch(headerClassifications, /\btruncate\b/)
assert.match(headerClassifications, /whitespace-normal break-words/)
assert.doesNotMatch(stockDetailSource, /function StockClassificationBar/)
assert.match(stockDetailSource, /title="会社概要" body=\{profile\.companyFeature\}/)
assert.match(stockDetailSource, /title="連結事業" body=\{profile\.consolidatedBusiness\}/)
const shikihoOverview = stockDetailSource.slice(
  stockDetailSource.indexOf('function ShikihoOverviewSection'),
  stockDetailSource.indexOf('function ShikihoNarrativeSection'),
)
assert.doesNotMatch(shikihoOverview, /<details|<summary/)
assert.doesNotMatch(shikihoOverview, /四季報の指標・記事を見る/)
assert.doesNotMatch(shikihoOverview, /clampLines=\{3\}/)
for (const label of ['四季報サマリー', '業績展望・注目点', '収録号', '発売日']) {
  assert.match(shikihoOverview, new RegExp(label))
}
const shikihoNarrative = stockDetailSource.slice(
  stockDetailSource.indexOf('function ShikihoNarrativeSection'),
  stockDetailSource.indexOf('function ShikihoArticle'),
)
assert.doesNotMatch(shikihoNarrative, /clampLines|WebkitLineClamp|全文表示|折りたたむ/)

for (const legacyHash of ['performance', 'financial', 'valuation', 'returns']) {
  assert.match(stockDetailSource, new RegExp(`hash === '${legacyHash}'`))
}
assert.match(stockDetailSource, /hash === 'company' \|\| hash === 'shikiho'/)
assert.match(stockDetailSource, /hash === 'shikiho'/)
assert.match(stockDetailSource, /legacyQueryTab === 'company'/)
assert.match(stockDetailSource, /url\.hash = 'overview'/)
assert.match(stockDetailSource, /getElementById\('company-basic-info'\)/)

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
assert.match(summarySource, /\$\{data\.sector\.rank\} \/ \$\{data\.sector\.totalGroups\}区分/)
assert.match(summarySource, /6軸Stage 70% \+ MA方向 30%/)
assert.match(summarySource, /業種平均スコアの全区分順位（その他含む）/)
assert.match(summarySource, /if \(variant === 'overview'\) \{\s+getJson<StockSectorContextResult>\(urls\.sector/)
assert.equal((summarySource.match(/urls\.sector/g) ?? []).length, 1, 'sector context must be fetched exactly once')
assert.match(summarySource, /sectorAvailability: 'error'/)
assert.match(summarySource, /33業種平均との差/)
const marketMetric = summarySource.slice(
  summarySource.indexOf('function MarketMetric'),
  summarySource.indexOf('function DesktopAxis'),
)
assert.doesNotMatch(marketMetric, /\btruncate\b/)
assert.match(marketMetric, /break-words/)
assert.match(summarySource, /grid grid-cols-2 gap-2/)
assert.doesNotMatch(stockDetailSource.slice(
  stockDetailSource.indexOf('const basicStageCellTextStyle'),
  stockDetailSource.indexOf('const basicMutedTextStyle'),
), /textOverflow|ellipsis|overflow: 'hidden'/)

console.log('stock decision summary tests passed')
