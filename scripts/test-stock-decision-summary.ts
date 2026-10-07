import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildRuns,
  buildStageTransitions,
  classifyRunLabel,
  pickTickCount,
  StageTimelineValue,
  summarizeStageStability,
  type StageEntry,
} from '@/components/stock/StageTimeline'
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
const analysisVisualsSource = readFileSync(
  new URL('../components/stock/StockAnalysisVisuals.tsx', import.meta.url),
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
// 読み順: 結論+チャート+根拠 → Stage変遷 → 月足MA(Stage変遷の直後) → Physical Momentum → 指標の見方
const chartOrder = [
  '<TechnicalChartSnapshot',
  '<CandlestickChart',
  '<StageTimeline\n',
  '<Ma25mMonitorSummary',
  '<PhysicalMomentumSection',
  '<TechnicalSnapshotGuide',
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
const technicalSnapshot = stockDetailSource.slice(
  stockDetailSource.indexOf('function TechnicalChartSnapshot'),
  stockDetailSource.indexOf('function FundamentalWorkspace'),
)
assert.match(technicalSnapshot, /background: value \? STAGE_BG_COLORS\[value\]/)
assert.match(technicalSnapshot, /borderColor: value \? STAGE_BORDER_COLORS\[value\]/)
assert.match(technicalSnapshot, /<strong className="font-mono text-\[14px\] leading-tight text-\[var\(--color-text-primary\)\]">/)
assert.match(technicalSnapshot, /CHART_STAGE_AXES\.map/)
assert.match(technicalSnapshot, /<TechnicalMaEvidence/)
assert.match(technicalSnapshot, /data-technical-current-state/)
assert.match(technicalSnapshot, /data-technical-stage-map/)
assert.match(technicalSnapshot, /data-technical-scores/)
assert.doesNotMatch(technicalSnapshot, /StageAlignmentBar|Stage Distribution|Stage分布/)
assert.match(technicalSnapshot, /<ScoreThresholdBar label=\{`\$\{label\} \$\{code\}`\}/)
assert.match(technicalSnapshot, /marks=\{marks\}/, 'Technical score panel is the canonical threshold visualization (boundary ticks)')
assert.match(technicalSnapshot, /nearestBoundaryText\(value, marks\)/, 'Nearest-threshold facts must live in the Technical score panel')
assert.match(technicalSnapshot, /PHYSICAL_BOUNDARIES\.map/)
assert.match(technicalSnapshot, /\{ kind: 'pms', code: 'PMS', label: '総合の強さ', neutral: false \}/)
assert.match(technicalSnapshot, /\{ kind: 'pfs', code: 'PFS', label: '足元の力の向き', neutral: false \}/)
assert.match(technicalSnapshot, /\{ kind: 'pes', code: 'PES', label: '値動きの熱量', neutral: true \}/)
assert.equal((technicalSnapshot.match(/<span className="whitespace-nowrap">-2\.5<\/span>/g) ?? []).length, 1, 'Technical snapshot must show its shared score minimum once')
assert.equal((technicalSnapshot.match(/<span className="whitespace-nowrap">\+2\.5<\/span>/g) ?? []).length, 1, 'Technical snapshot must show its shared score maximum once')
const technicalStageMap = technicalSnapshot.slice(
  technicalSnapshot.indexOf('function TechnicalStageMap'),
  technicalSnapshot.indexOf('const TECHNICAL_SCORE_ROWS'),
)
assert.doesNotMatch(technicalStageMap, /min-h-\[|\btruncate\b|\bh-9\b|\bh-11\b|overflow-hidden/, 'Stage map tiles use natural height and never truncate Stage names')
assert.match(technicalStageMap, /\{STAGE_LABELS\[value\]\}/, 'Stage map must render every full Stage name')
assert.match(technicalStageMap, /borderStyle: isException \? 'dashed' : 'solid'/, 'Axis outside the majority is marked with a dashed outline')
assert.match(technicalStageMap, /多数派と異なる軸/, 'Stage summary explains that the highlighted axis differs from the majority')
assert.match(technicalStageMap, />異なる軸<\/b>/, 'Stage cell avoids the ambiguous 例外 label')
assert.match(technicalStageMap, /grid-cols-3/)
assert.doesNotMatch(technicalSnapshot, /text-white/)
assert.doesNotMatch(technicalSnapshot, /color: value \? '#fff'/)
assert.doesNotMatch(technicalSnapshot, /text-\[(?:8|9|10)px\]/, 'Information-bearing text in the technical area must be at least 11px')
assert.doesNotMatch(technicalSnapshot, /lg:flex-1|lg:justify-between|lg:flex-col/, 'Forced equal-height stretching must not return')
assert.doesNotMatch(technicalSnapshot, /MAの傾きはこの銘柄自身の絶対的な角度、3スコアは/, 'The repeated disclaimer paragraph is replaced by block captions')
assert.match(technicalSnapshot, /data-technical-current-state/)
assert.equal((technicalSnapshot.match(/text-\[20px\]/g) ?? []).length, 1, 'Current State hero is the only 20px conclusion')
assert.match(technicalSnapshot, /角度幅/, 'MA span facts live in the canonical MA block')
assert.match(technicalSnapshot, /maSpreadChangeDeg/)
assert.match(technicalSnapshot, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(400px,440px\)\]/, 'Chart sits beside the evidence rail on wide screens')
assert.doesNotMatch(technicalSnapshot, /xl:row-span-2|xl:grid-rows-\[/, 'The rail must not span rows of the chart column (that created a blank block under the chart)')
{
  const snapshotBody = technicalSnapshot.slice(
    technicalSnapshot.indexOf('function TechnicalChartSnapshot'),
    technicalSnapshot.indexOf('type MaSignal'),
  )
  assert.ok(
    snapshotBody.indexOf('<TechnicalStateHero') < snapshotBody.indexOf('{chart}')
      && snapshotBody.indexOf('<TechnicalScorePanel') < snapshotBody.indexOf('<TechnicalStageMap'),
    'Order: Current State → chart → MA/score rail → full-width Stage map',
  )
  assert.doesNotMatch(
    snapshotBody,
    /<TechnicalStageMap[^>]*className=/,
    'The Stage map is a full-width band below the chart/rail row; it takes no rail/column placement classes',
  )
}
assert.match(technicalSnapshot, /function MaAngleBar/)
assert.match(technicalSnapshot, /MA_STRONG_DEG/)
assert.match(technicalSnapshot, /--color-price-flat/, 'PES uses neutral slate, never up/down colors')
assert.match(chartWorkspace, /toolbarVariant="segmented"/)
assert.match(chartWorkspace, /summaryVariant="strip"/)
assert.match(chartWorkspace, /useChartHeight/)
assert.doesNotMatch(chartWorkspace, /<PhysicalMaFieldMap|<PhysicalActionPoints/)

const physicalMomentumSection = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalMomentumSection'),
  stockDetailSource.indexOf('function trendText'),
)
assert.equal((physicalMomentumSection.match(/\/api\/physical-momentum\//g) ?? []).length, 1)
assert.equal((physicalMomentumSection.match(/\/api\/stock-physical-plan\//g) ?? []).length, 1)
assert.match(physicalMomentumSection, /aria-controls="physical-momentum-details"/)
assert.match(physicalMomentumSection, /aria-expanded=\{mobileDetailsOpen\}/)
// 運動状態 → 時間軸比較 → PMS推移・内訳 → 観察プラン(モバイルでは折りたたみ)
const physicalOrder = ['<PhysicalStateSummary', '<PhysicalTimeframeConclusionPanel', '<PhysicalMomentumSparkline', 'id="physical-momentum-details"', '<PhysicalTradePlanCards']
previousIndex = -1
for (const marker of physicalOrder) {
  const index = physicalMomentumSection.indexOf(marker)
  assert.ok(index > previousIndex, `physical momentum order: ${marker}`)
  previousIndex = index
}
assert.doesNotMatch(physicalMomentumSection, /<PhysicalActionPoints|<PhysicalMaFieldMap/, 'Duplicate boundary and MA blocks were merged into the Technical blocks')
assert.doesNotMatch(stockDetailSource, /function PhysicalActionPoints|function PhysicalMaFieldMap/)
assert.doesNotMatch(physicalMomentumSection, /Physical Momentum<\/div>|section-header/, 'Physical Momentum uses the shared section header, not the global gray header bar')
const physicalStateSummary = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalStateSummary'),
  stockDetailSource.indexOf('function scoreTone'),
)
assert.match(physicalStateSummary, /運動状態\(日足・20営業日\)/)
assert.doesNotMatch(physicalStateSummary, /現在の状態|主要指標|MA角度幅/, 'The Physical conclusion must not compete with the Current State hero')
assert.match(physicalStateSummary, /直近の向き/)
assert.match(physicalStateSummary, /20日変化/)
assert.doesNotMatch(physicalStateSummary, /borderLeft/, 'Only the Current State hero carries the colored left rule')
const physicalPlanCards = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalTradePlanCards'),
  stockDetailSource.indexOf('interface PhysicalMaFieldInsight'),
)
assert.doesNotMatch(physicalPlanCards, /tone\.background|rgba\(245, 158, 11/, 'Observation plans do not use an amber/tone fill')
assert.doesNotMatch(physicalPlanCards, /<details|<summary/, 'The plan row toggles candidates inline instead of spending a separate row on a <details> summary')
assert.match(physicalPlanCards, /aria-expanded=\{open\}/, 'Candidates and verification dates open from a button inside the condition line')
assert.match(physicalPlanCards, /aria-controls=\{detailsId\}/)
assert.match(physicalPlanCards, /lg:grid-cols-\[6rem_minmax\(0,1\.5fr\)_minmax\(0,\.9fr\)_minmax\(0,1\.3fr\)\]/, 'Plan rows use one compact 4-column row on wide screens')
{
  const planVisible = physicalPlanCards.slice(0, physicalPlanCards.indexOf('{open && ('))
  assert.doesNotMatch(planVisible, /\{horizon\.suggestion\.stance\}/, 'The stance sentence only repeats the chips and headline; it lives in the expanded detail')
}
assert.doesNotMatch(physicalStateSummary, /20日騰落率/, 'The 20-day return lives in the Physical breakdown, not in the state row')
const physicalSparkline = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalMomentumSparkline'),
  stockDetailSource.indexOf('function PhysicalTrendChip'),
)
assert.doesNotMatch(physicalSparkline, /label="最新"|label="20日変化"/, 'Latest PMS and the 20-day change are shown once (chart end label / state row)')
const physicalTimeframePanel = stockDetailSource.slice(
  stockDetailSource.indexOf('function PhysicalTimeframeConclusionPanel'),
  stockDetailSource.indexOf('function PhysicalBreakdown'),
)
assert.doesNotMatch(physicalTimeframePanel, /grid-cols-\[3\.5rem/, 'The timeframe label column must be wide enough that 短期 / 日足 never breaks mid-word')
assert.match(physicalTimeframePanel, /sm:contents/, 'Timeframe scores stack with full-width bars on phones and become table columns from sm')
assert.doesNotMatch(physicalMomentumSection + physicalPlanCards, /text-\[(?:8|9|10)px\]/)

assert.equal((stageTimelineSource.match(/fetch\(`\/api\/stage-history\//g) ?? []).length, 1)
assert.match(stageTimelineSource, /onSnapshotChange\?\.\(latest \? \{/)
assert.match(stageTimelineSource, /onClick=\{\(\) => selectStageSegment\(system, run\.startIndex\)\}/)
assert.match(stageTimelineSource, /buildRuns\(entries, system\.key\)/)
assert.match(stageTimelineSource, /連続期間\(幅=継続長\)/)
assert.match(stageTimelineSource, /aria-pressed=\{granularity === item\.key\}/)
assert.match(stageTimelineSource, /aria-pressed=\{count === preset\}/)
assert.match(stageTimelineSource, /min-h-11[^"]+sm:min-h-8/)
assert.match(stageTimelineSource, /\{ key: 'timeline', label: 'Timeline' \}/)
assert.match(stageTimelineSource, /\{ key: 'classic', label: 'Classic' \}/)
assert.match(stageTimelineSource, /window\.sessionStorage\.getItem\(HISTORY_VIEW_STORAGE_KEY\)/)
assert.match(stageTimelineSource, /window\.sessionStorage\.setItem\(HISTORY_VIEW_STORAGE_KEY, next\)/)
assert.match(stageTimelineSource, /view === 'classic'/)
assert.equal((stageTimelineSource.match(/fetch\(`\/api\/stage-history\//g) ?? []).length, 1, 'Timeline and Classic must share one stage-history fetch')

// Stage History: every run must be identifiable without hover
assert.equal(classifyRunLabel(Number.NaN), 'none')
assert.equal(classifyRunLabel(0), 'none')
assert.equal(classifyRunLabel(4), 'none')
assert.equal(classifyRunLabel(8.9), 'none')
assert.equal(classifyRunLabel(9), 'digit')
assert.equal(classifyRunLabel(16), 'digit')
assert.equal(classifyRunLabel(19.9), 'digit')
assert.equal(classifyRunLabel(20), 'stage')
assert.equal(classifyRunLabel(71), 'stage')
assert.equal(classifyRunLabel(79.9), 'stage')
assert.equal(classifyRunLabel(80), 'full')
assert.equal(pickTickCount(0), 3)
assert.equal(pickTickCount(100), 2)
assert.equal(pickTickCount(228), 3)
assert.equal(pickTickCount(334), 4)
assert.equal(pickTickCount(1000), 5)

function stageEntry(date: string, overrides: Partial<StageEntry>): StageEntry {
  return {
    date,
    daily_a_stage: null,
    daily_b_stage: null,
    weekly_a_stage: null,
    weekly_b_stage: null,
    monthly_a_stage: null,
    monthly_b_stage: null,
    close: null,
    ...overrides,
  }
}
const stageFixture: StageEntry[] = [
  stageEntry('2025-01-03', { daily_a_stage: 1, daily_b_stage: 3, weekly_a_stage: null }),
  stageEntry('2025-01-10', { daily_a_stage: 1, daily_b_stage: 3, weekly_a_stage: 2 }),
  stageEntry('2025-01-17', { daily_a_stage: 2, daily_b_stage: null, weekly_a_stage: 2 }),
  stageEntry('2025-01-24', { daily_a_stage: 2, daily_b_stage: 4, weekly_a_stage: 5 }),
  stageEntry('2025-01-31', { daily_a_stage: 5, daily_b_stage: 4, weekly_a_stage: 5 }),
  stageEntry('2025-02-07', { daily_a_stage: 1, daily_b_stage: 4, weekly_a_stage: 6 }),
]
const stageTransitions = buildStageTransitions(stageFixture)
assert.equal(
  stageTransitions.length,
  summarizeStageStability(stageFixture).transitionCount,
  'Stage change log rows must match the transitionCount rule (non-null and different)',
)
assert.deepEqual(
  stageTransitions.map((item) => [item.date, item.system, item.from, item.to, item.fromLength, item.fromTruncated, item.toStartIndex]),
  [
    ['2025-01-17', 'daily_a_stage', 1, 2, 2, true, 2],
    ['2025-01-24', 'weekly_a_stage', 2, 5, 2, false, 3],
    ['2025-01-31', 'daily_a_stage', 2, 5, 2, false, 4],
    ['2025-02-07', 'daily_a_stage', 5, 1, 1, false, 5],
    ['2025-02-07', 'weekly_a_stage', 5, 6, 2, false, 5],
  ],
  'null gaps must not create transitions; same-date moves keep system order; first run is a lower bound',
)
assert.deepEqual(buildStageTransitions([]), [])
assert.deepEqual(
  buildRuns(stageFixture, 'daily_b_stage').map((run) => [run.stage, run.startIndex, run.length]),
  [[3, 0, 2], [null, 2, 1], [4, 3, 3]],
)
assert.doesNotMatch(stageTimelineSource, /run\.length >= 3/)
assert.doesNotMatch(stageTimelineSource, /left-\[48px\] right-\[72px\]/)
assert.match(stageTimelineSource, /classifyRunLabel\(runPx\(run\)\)/)
assert.match(stageTimelineSource, /Stage列/)
assert.match(stageTimelineSource, /Stage変更ログ/)
assert.match(stageTimelineSource, /'以上'/)
assert.match(stageTimelineSource, /buildStageTransitions\(entries\)/)
assert.match(stageTimelineSource, /aria-expanded=\{logExpanded\}/)
assert.match(stageTimelineSource, /new ResizeObserver\(measure\)/)
assert.match(stageTimelineSource, /buildTicks\(entries, granularity, pickTickCount\(trackWidth\)\)/)
assert.match(ma25mSource, /月足MAの位置/)
assert.match(ma25mSource, /月足MAの算出履歴が不足しています/)
assert.match(ma25mSource, /月足MAを取得できませんでした/, 'A fetch failure must not be mislabeled as insufficient history')
assert.match(ma25mSource, /setFailed\(/)
assert.match(ma25mSource, /再読込/)
assert.match(ma25mSource, /@\[56rem\]:grid-cols-6/, 'Monthly cells sit in one row on wide containers')
assert.doesNotMatch(ma25mSource, /@min-\[/, '@min-[..] container variants do not generate here; use @[..]')
assert.doesNotMatch(ma25mSource, /violet|Long-term structure|uppercase|text-\[(?:8|9|10)px\]/, 'No Stage-colored 接近, English eyebrow or sub-11px text in the monthly block')
assert.ok(
  ma25mSource.indexOf('setFailed(null)') < ma25mSource.indexOf('月足MAの算出履歴が不足しています'),
  'error state is reset on each fetch and checked before the insufficient-history branch',
)

// Stage History: legend, from→to cue, navy selection, shared controls
assert.match(stageTimelineSource, /aria-label="Stage凡例"/)
assert.match(stageTimelineSource, /STAGE_NUMBERS\.map/)
assert.match(stageTimelineSource, /STAGE_LABELS\[stage\]/)
assert.match(stageTimelineSource, /enteredFrom/)
assert.match(stageTimelineSource, /item\.system === system\.key && item\.toStartIndex === current\.startIndex/, 'from→to must come from buildStageTransitions, not a new calculation')
assert.doesNotMatch(stageTimelineSource, /amber|Stage history<\/div>|uppercase|text-\[(?:8|9|10)px\]/, 'Selection is navy; no English eyebrow; text stays at 11px or larger')
assert.doesNotMatch(stageTimelineSource, /fontSize: '(?:8|9|10)px'/)
assert.doesNotMatch(stageTimelineSource, /min-h-\[260px\]/, 'Loading state must not reserve a fixed dead area')
assert.match(stageTimelineSource, /xl:grid-cols-3/, 'Stage change log uses the width on wide screens')
assert.match(stageTimelineSource, /label: '日足'/)
assert.match(stageTimelineSource, /VIEW_CAPTIONS/)
assert.doesNotMatch(stageTimelineSource, /現在の6軸整合度/, 'The 13-week tile that repeated the Stage map sentence was removed')
assert.match(stageTimelineSource, /13週で/)
assert.doesNotMatch(stageTimelineSource, /数字=Stage番号/, 'The lane legend sentence was folded into the lane header (白線=Stage変更 ・ 右端=現在)')
assert.match(stageTimelineSource, /白線=Stage変更 ・ 右端=現在/)
assert.match(stageTimelineSource, /onStageRangeSelect \? 'min-h-11 sm:min-h-7' : 'min-h-8 sm:min-h-7'/, 'Only tappable change-log rows reserve the 44px target')

// CandlestickChart: workspace refinements are opt-in and the default consumers keep the old toolbar/summary
const candlestickSource = readFileSync(
  new URL('../components/charts/CandlestickChart.tsx', import.meta.url),
  'utf8',
)
assert.match(candlestickSource, /toolbarVariant = 'default'/)
assert.match(candlestickSource, /summaryVariant = 'cards'/)
assert.match(candlestickSource, /!compact && summaryVariant === 'cards' && <TimeframeSummaryBar/)
assert.match(candlestickSource, /showTimeframeSelector && !segmented/, 'Default toolbar still renders every timeframe tab')
assert.match(candlestickSource, /showAngle=\{effectiveInterval !== 'D'\}/)
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
assert.match(stockDetailSource, /shortTerm\.reading/)
assert.match(stockDetailSource, /function shortTermSideReading/)
assert.match(stockDetailSource, /何が支え、何が逆向き・中立か/)
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
assert.match(overviewBasicInfo, /data-overview-basic-grid/)
assert.match(overviewBasicInfo, /className="grid items-start gap-x-4 gap-y-3/)
assert.match(overviewBasicInfo, /marketSnapshot=\{\(/)
assert.match(stockDetailSource, /<CompanyInformationDetail ticker=\{ticker\} analysisDate=\{analysisDate\} \/>/)
assert.match(stockDetailSource, /会社四季報の会社概要は現在情報のため/)

assert.match(basicInfoCard, /className=\{embedded \? 'contents' : 'card'\}/)
assert.match(basicInfoCard, /data-overview-signal-row/)
const signalDisclosure = basicInfoCard.slice(basicInfoCard.indexOf('<SheetRow label="根拠と条件"'))
assert.ok(basicInfoCard.includes('<SheetRow label="根拠と条件"'), 'Evidence and conditions live in one sheet row')
assert.match(signalDisclosure, /aria-expanded=\{showSignalDetails\}/)
assert.match(signalDisclosure, /aria-controls=\{signalDetailsId\}/)
assert.match(signalDisclosure, /id=\{signalDetailsId\} hidden=\{!showSignalDetails\}/)
assert.match(signalDisclosure, /shortTerm\.sides\.map/, 'Short/mid evidence keeps every side')
assert.match(signalDisclosure, /aria-label="見方が変わる条件"/)
assert.match(signalDisclosure, /<ConditionList conditions=\{changeConditions\} \/>/)
assert.match(signalDisclosure, /<ConditionList conditions=\{shortTerm\.conditions\} \/>/)
const marginInfoCard = stockDetailSource.slice(
  stockDetailSource.indexOf('function MarginInfoCard'),
  stockDetailSource.indexOf('const marketSnapshotCardStyle'),
)
assert.match(marginInfoCard, /data-margin-info/)
assert.match(marginInfoCard, /grid-cols-1[^\"]+sm:grid-cols-2/)
assert.doesNotMatch(marginInfoCard, /min-h-|h-full|flex-grow|gridTemplateColumns/)
for (const label of ['基準週', '信用倍率', '買残', '売残', '買残増減', '売残増減']) {
  assert.match(marginInfoCard, new RegExp(`label="${label}"`))
}

const stockHeader = stockDetailSource.slice(
  stockDetailSource.indexOf('<div className="stock-detail-sticky'),
  stockDetailSource.indexOf('<StockDetailTabs'),
)
assert.match(stockHeader, /<StockHeaderClassifications/)
const headerClassifications = stockDetailSource.slice(
  stockDetailSource.indexOf('function StockHeaderClassifications'),
  stockDetailSource.indexOf('function ShikihoOverviewSection'),
)
const orderedHeaderClassifications = ['市場', '17業種', '33業種', '独自60分類', '独自細分類']
for (const label of orderedHeaderClassifications) {
  assert.match(headerClassifications, new RegExp(`item\\('${label}'`))
}
for (let index = 1; index < orderedHeaderClassifications.length; index += 1) {
  assert.ok(
    headerClassifications.indexOf(`item('${orderedHeaderClassifications[index - 1]}'`) <
      headerClassifications.indexOf(`item('${orderedHeaderClassifications[index]}'`),
  )
}
assert.match(headerClassifications, /data-classification-group=\{group\.key\}/)
for (const group of ['market', 'official', 'custom']) {
  assert.match(headerClassifications, new RegExp(`key: '${group}'`))
}
for (const groupLabel of ['市場属性', '公式業種分類', '独自分類']) {
  assert.match(headerClassifications, new RegExp(`label: '${groupLabel}'`))
}
assert.match(headerClassifications, /value\?\.trim\(\)/)
assert.match(headerClassifications, /text-\[9px\] font-medium text-\[var\(--color-text-tertiary\)\]/)
assert.match(headerClassifications, /text-\[10px\] font-bold/)
assert.match(headerClassifications, /group\.tone === 'official'/)
assert.match(headerClassifications, /group\.tone === 'custom'/)
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
assert.doesNotMatch(shikihoOverview, /index="0\d"/, 'Shikiho sections read by headings and rules, not ordinal numbers')

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
assert.match(summarySource, /33業種の構造順位/)
assert.match(summarySource, /\$\{data\.sector\.rank\} \/ \$\{data\.sector\.totalGroups\}区分/)
assert.match(summarySource, /6軸Stage 70% \+ MA方向 30%/)
assert.match(summarySource, /順位はその他を含む全区分/)
assert.match(summarySource, /if \(variant === 'overview'\) \{\s+getJson<StockSectorContextResult>\(urls\.sector/)
assert.equal((summarySource.match(/urls\.sector/g) ?? []).length, 1, 'sector context must be fetched exactly once')
assert.match(summarySource, /sectorAvailability: 'error'/)
assert.match(summarySource, /33業種平均との差/)
assert.match(summarySource, /<RankStrip/)
assert.match(summarySource, /<ScoreRuler code="PMS"/)
assert.match(summarySource, /<MetricLadder title=\{group\.ladderTitle\}/)
assert.match(analysisVisualsSource, /clamp\(value, -2\.5, 2\.5\)/)
assert.match(analysisVisualsSource, /-2\.5から\+2\.5のZスコア目盛り/)
assert.match(analysisVisualsSource, /export function PeerPositionRow/)
assert.match(analysisVisualsSource, /export function BoundedMeter/)
assert.doesNotMatch(analysisVisualsSource, /StageAlignmentBar/)
assert.doesNotMatch(stockDetailSource.slice(
  stockDetailSource.indexOf('const basicStageCellTextStyle'),
  stockDetailSource.indexOf('const basicMutedTextStyle'),
), /textOverflow|ellipsis|overflow: 'hidden'/)

console.log('stock decision summary tests passed')
