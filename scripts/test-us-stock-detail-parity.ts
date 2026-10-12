import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildMaFieldInsight,
  buildUsShortTermEvidence,
  fmtUsd,
  normalizeStage,
  technicalMomentumSnapshot,
  type UsPhysicalMomentumResponse,
  type UsPhysicalMomentumRow,
  type UsStageEntry,
} from '../components/us/stock-detail/technical-view'

const root = new URL('../', import.meta.url)

async function source(path: string) {
  return readFile(new URL(path, root), 'utf8')
}

function momentumRow(overrides: Partial<UsPhysicalMomentumRow> = {}): UsPhysicalMomentumRow {
  return {
    date: '2026-10-09',
    physicalMomentumScore: 1.2,
    physicalForceScore: 0.9,
    physicalEnergyScore: 0.4,
    velocity: 0.1,
    acceleration: 0.05,
    force: 0.2,
    ma5Angle: 0.12,
    ma25Angle: 0.1,
    ma75Angle: 0.08,
    ma200Angle: 0.06,
    maAngleAvg: 0.09,
    energy: 0.3,
    ...overrides,
  }
}

function stageEntry(overrides: Partial<UsStageEntry> = {}): UsStageEntry {
  return {
    date: '2026-10-09',
    close: 100,
    ma_5: 98,
    ma_25: 95,
    ma_75: 90,
    ma_300: 80,
    daily_a_stage: 1,
    daily_b_stage: 1,
    weekly_a_stage: 1,
    weekly_b_stage: 1,
    monthly_a_stage: 1,
    monthly_b_stage: 1,
    ...overrides,
  }
}

async function main() {
  assert.equal(fmtUsd(0.125), '$0.125', 'sub-dollar prices must not round to $0')
  assert.equal(fmtUsd(null), '-', 'missing prices must remain unavailable')
  assert.equal(normalizeStage(0), null, 'Stage 0 is not a valid six-stage value')
  assert.equal(normalizeStage(6), 6)

  const upward = buildMaFieldInsight(momentumRow(), null)
  assert.equal(upward.label, '上方向へ力が拡散')
  const missing = buildMaFieldInsight(momentumRow({ ma25Angle: null, ma75Angle: null }), null)
  assert.equal(missing.label, 'MA力場未判定')

  const response: UsPhysicalMomentumResponse = {
    latest: momentumRow(),
    history: [momentumRow({ date: '2026-10-08' }), momentumRow()],
    rank: 10,
    totalRanked: 100,
    trend: 'rising',
    latestScoredDate: '2026-10-09',
    isScoreFresh: true,
  }
  const snapshot = technicalMomentumSnapshot('ready', response, '')
  assert.equal(snapshot.status, 'available')
  assert.equal(snapshot.scoreDate, '2026-10-09')
  assert.equal(snapshot.pms, 1.2)

  const evidenceWithoutMove = buildUsShortTermEvidence(stageEntry(), momentumRow(), null, null)
  const dailyMove = evidenceWithoutMove.sides[0].items.find((item) => item.label === '日次騰落')
  assert.equal(dailyMove?.value, '—', 'missing historical daily move must not become 0%')
  assert.equal(dailyMove?.direction, null)

  const client = await source('app/us/stock/[ticker]/UsStockDetailClient.tsx')
  assert.match(client, /if \(!analysisReview\?\.available\) return null/)
  assert.match(client, /analysisReview\?\.available \? analysisReview\.base\.changePercent : null/)
  assert.match(client, /changePercent: base\.changePercent \?\? Number\.NaN/)
  assert.doesNotMatch(client, /changePercent: base\.changePercent \?\? 0/)
  assert.match(client, /label: '類似・ML'/)

  const scenarioProjection = client.indexOf('<ScenarioProjectionChart')
  const movePeriods = client.indexOf('<StockMovePeriods')
  const notebook = client.indexOf('<TradeScenarioNotebook')
  const scenarioAi = client.indexOf('<StockScenarioAiPanel')
  assert.ok(scenarioProjection < movePeriods && movePeriods < notebook && notebook < scenarioAi, 'scenario blocks must follow the editorial order')

  const mlInsights = client.indexOf('<StockMlInsights')
  const analogs = client.indexOf('<HistoricalAnalogExplorer')
  const mlStatus = client.indexOf('<UsMlDataStatus')
  assert.ok(mlInsights < analogs && analogs < mlStatus, 'similar/ML blocks must follow the editorial order')

  const chart = await source('components/us/stock-detail/UsChartWorkspace.tsx')
  assert.match(chart, /toolbarVariant="segmented"/)
  assert.match(chart, /summaryVariant="strip"/)
  assert.match(chart, /<StageTimeline[\s\S]*market="US"/)
  assert.match(chart, /<UsPhysicalMomentumSection/)

  const momentumHook = await source('components/us/stock-detail/useUsPhysicalMomentum.ts')
  assert.match(momentumHook, /requestedKey\.current === key/)
  assert.match(momentumHook, /market: 'US'/)
  assert.match(momentumHook, /params\.set\('date', analysisDate\)/)

  const jpMl = await source('components/stock/StockMlInsights.tsx')
  const jpAnalog = await source('components/stock/HistoricalAnalogExplorer.tsx')
  assert.match(jpMl, /market === 'US' \? '値動きの近い銘柄' : '③ 値動きの近い銘柄'/)
  assert.match(jpAnalog, /market === 'US' \? '過去の近い局面' : '② 過去の近い局面'/)

  const mlStatusSource = await source('components/us/stock-detail/UsMlDataStatus.tsx')
  assert.match(jpMl, /loadUsMlStatus<MlBackendStatus>\(statusEndpoint\)/)
  assert.match(mlStatusSource, /loadUsMlStatus<UsMlStatusResponse>\(url\)/)
  const mlResource = await source('components/us/stock-detail/usMlStatusResource.ts')
  assert.match(mlResource, /const inFlight = new Map/)
  assert.match(mlResource, /inFlight\.delete\(url\)/)

  console.log('US stock detail parity tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
