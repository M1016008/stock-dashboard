import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { execAll, execGet } from '@/lib/db/client'
import { isHistoricalUniverseMemberAt } from '@/lib/historical-universe'
import type { TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import {
  createTriggerDiscoverySqlDataSource,
  getTriggerDiscovery,
} from '@/lib/server/trigger-discovery-read-model'
import { getTriggerDiscoveryMiniCharts } from '@/lib/server/trigger-discovery-mini-charts'
import {
  parseTriggerDiscoverySearchRequest,
  triggerDiscoveryBaseSearchKey,
} from '@/lib/server/trigger-discovery-search-request'
import { calculateTriggerScore } from '@/lib/trigger-score'

const REQUESTED_TRADING_DAY = '2025-10-31'
const REQUESTED_WEEKEND = '2025-11-02'
const REQUESTED_HOLIDAY = '2025-11-03'
const RESOLVED_HISTORICAL_DAY = '2025-10-31'
const MARKETS = ['プライム', 'スタンダード']
const SAMPLE_SIZE = 5

type SideEffectCounts = {
  evaluations: number
  members: number
  lifecycle: number
  outbox: number
  deliveryAttempts: number
}

type HistoricalUniverseRow = {
  ticker: string
  active: number
  first_trade_date: string | null
  last_trade_date: string | null
  latest_ohlcv_date: string | null
}

function closeEnough(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9
}

function rowSnapshot(row: TriggerDiscoveryRow) {
  return {
    ticker: row.ticker,
    price: row.price,
    ma1: row.ma1Value,
    ma2: row.ma2Value,
    status: row.triggerStatus,
    score: row.triggerScore,
    scoreBreakdown: row.scoreBreakdown,
    stage: [
      row.dayAStage,
      row.dayBStage,
      row.weekAStage,
      row.weekBStage,
      row.monthAStage,
      row.monthBStage,
    ],
    priceDate: row.priceDate,
    maDate: row.maDate,
    stageDate: row.stageDate,
  }
}

async function sideEffectCounts(): Promise<SideEffectCounts> {
  const row = await execGet<Record<string, number>>(`
    SELECT (SELECT COUNT(*) FROM trigger_evaluations) AS evaluations,
           (SELECT COUNT(*) FROM trigger_evaluation_members) AS members,
           (SELECT COUNT(*) FROM trigger_lifecycle_events) AS lifecycle,
           (SELECT COUNT(*) FROM notification_outbox) AS outbox,
           (SELECT COUNT(*) FROM notification_delivery_attempts) AS delivery_attempts
  `)
  return {
    evaluations: Number(row?.evaluations ?? 0),
    members: Number(row?.members ?? 0),
    lifecycle: Number(row?.lifecycle ?? 0),
    outbox: Number(row?.outbox ?? 0),
    deliveryAttempts: Number(row?.delivery_attempts ?? 0),
  }
}

function discoveryInput(asOf: string) {
  return {
    asOf,
    triggerConfig: { ma1Period: 20, ma2Period: 25 },
    markets: MARKETS,
    limit: 100,
  }
}

async function assertDirectFacts(rows: TriggerDiscoveryRow[], resolvedAsOf: string) {
  for (const row of rows) {
    const price = await execGet<{ date: string; close: number }>(`
      SELECT date, close FROM ohlcv_daily
      WHERE ticker=? AND date<=?
      ORDER BY date DESC LIMIT 1
    `, [row.ticker, resolvedAsOf])
    assert.equal(row.priceDate, price?.date, `${row.ticker} price date must match OHLCV`)
    assert.ok(closeEnough(row.price, Number(price?.close)), `${row.ticker} price must match OHLCV`)

    const stage = await execGet<Record<string, number | string>>(`
      SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
             monthly_a_stage, monthly_b_stage
      FROM daily_snapshots WHERE ticker=? AND date=?
    `, [row.ticker, resolvedAsOf])
    const expectedStage = stage
      ? [stage.daily_a_stage, stage.daily_b_stage, stage.weekly_a_stage,
          stage.weekly_b_stage, stage.monthly_a_stage, stage.monthly_b_stage]
        .map((value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 6
          ? Number(value)
          : null)
      : [null, null, null, null, null, null]
    assert.deepEqual(rowSnapshot(row).stage, expectedStage, `${row.ticker} Stage must use the exact resolved date`)
    assert.equal(row.stageDate, stage ? resolvedAsOf : null, `${row.ticker} Stage date contract`)

    const liquidity = await execAll<{ close: number; volume: number }>(`
      SELECT close, volume FROM ohlcv_daily
      WHERE ticker=? AND date<=?
      ORDER BY date DESC LIMIT ?
    `, [row.ticker, resolvedAsOf, row.liquidityLookbackSessions])
    const expectedAverageVolume = liquidity.reduce((sum, item) => sum + Number(item.volume), 0) / liquidity.length
    const expectedAverageTradingValue = liquidity.reduce(
      (sum, item) => sum + Number(item.close) * Number(item.volume), 0,
    ) / liquidity.length
    assert.ok(closeEnough(row.averageVolume, expectedAverageVolume), `${row.ticker} average volume must be PIT`)
    assert.ok(closeEnough(row.averageTradingValue, expectedAverageTradingValue), `${row.ticker} trading value must be PIT`)

    const market = await execGet<{ market: string | null }>(`
      SELECT COALESCE(hu.market_segment, tu.market_segment) AS market
      FROM historical_universe AS hu
      LEFT JOIN ticker_universe AS tu ON tu.ticker=hu.ticker
      WHERE hu.ticker=?
    `, [row.ticker])
    assert.equal(row.market, market?.market ?? null, `${row.ticker} market must match the reconstructed universe`)

    const recalculated = calculateTriggerScore({
      triggerStatus: row.triggerStatus,
      fromAbove: row.fromAbove,
      zoneDistancePct: row.zoneDistancePct,
      maxApproachDistancePct: 5,
      approachVelocityPctPointsPerSession: row.approachVelocityPctPointsPerSession,
      ma1SlopePct: row.ma1SlopePct,
      ma2SlopePct: row.ma2SlopePct,
      averageTradingValue: row.averageTradingValue,
      dayAStage: row.dayAStage,
      dayBStage: row.dayBStage,
      weekAStage: row.weekAStage,
      weekBStage: row.weekBStage,
      monthAStage: row.monthAStage,
      monthBStage: row.monthBStage,
    })
    assert.equal(row.triggerScore, recalculated.totalScore, `${row.ticker} score total`)
    assert.deepEqual(row.scoreBreakdown, recalculated.scoreBreakdown, `${row.ticker} score breakdown`)
  }
}

async function universeRow(ticker: string): Promise<HistoricalUniverseRow> {
  const row = await execGet<HistoricalUniverseRow>(`
    SELECT hu.ticker, COALESCE(tu.active, 0) AS active, hu.first_trade_date,
           hu.last_trade_date, hu.latest_ohlcv_date
    FROM historical_universe AS hu
    LEFT JOIN ticker_universe AS tu ON tu.ticker=hu.ticker
    WHERE hu.ticker=?
  `, [ticker])
  assert.ok(row, `historical universe fixture ${ticker}`)
  return row
}

async function main() {
  const before = await sideEffectCounts()
  const startedAt = performance.now()

  const monthly = await getTriggerDiscovery(discoveryInput(REQUESTED_TRADING_DAY))
  assert.equal(monthly.requestedAsOf, REQUESTED_TRADING_DAY)
  assert.equal(monthly.resolvedAsOf, RESOLVED_HISTORICAL_DAY)
  assert.ok(monthly.rows.length >= SAMPLE_SIZE, 'historical Monthly fixture must provide candidates')
  assert.ok(monthly.rows.every((row) => row.priceDate <= RESOLVED_HISTORICAL_DAY))
  assert.ok(monthly.rows.every((row) => row.maDate <= RESOLVED_HISTORICAL_DAY))
  assert.ok(monthly.rows.every((row) => row.stageDate == null || row.stageDate === RESOLVED_HISTORICAL_DAY))

  const weekend = await getTriggerDiscovery(discoveryInput(REQUESTED_WEEKEND))
  assert.equal(weekend.requestedAsOf, REQUESTED_WEEKEND)
  assert.equal(weekend.resolvedAsOf, RESOLVED_HISTORICAL_DAY)
  assert.deepEqual(weekend.rows.map(rowSnapshot), monthly.rows.map(rowSnapshot), 'weekend and resolved trading day must match')

  const source = createTriggerDiscoverySqlDataSource()
  const holidaySessions = await source.loadMarketSessions(REQUESTED_HOLIDAY, 1)
  assert.equal(holidaySessions.value[0], RESOLVED_HISTORICAL_DAY, 'holiday must resolve backward')
  const latest = await execGet<{ date: string }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  assert.ok(latest?.date)
  const futureSessions = await source.loadMarketSessions('2999-12-31', 1)
  assert.equal(futureSessions.value[0], latest.date, 'future date must resolve to latest available data')

  const biweekly = await getTriggerDiscovery(discoveryInput(REQUESTED_TRADING_DAY), { timeframe: 'BIWEEKLY' })
  assert.equal(biweekly.resolvedAsOf, RESOLVED_HISTORICAL_DAY)
  assert.ok(biweekly.rows.length >= SAMPLE_SIZE, 'historical Biweekly fixture must provide candidates')
  assert.notDeepEqual(
    biweekly.rows.map((row) => row.ticker).sort(),
    monthly.rows.map((row) => row.ticker).sort(),
    'Monthly and Biweekly caches/results must remain isolated',
  )
  assert.ok(biweekly.rows.every((row) => row.priceDate <= RESOLVED_HISTORICAL_DAY))
  assert.ok(biweekly.rows.every((row) => row.maDate <= RESOLVED_HISTORICAL_DAY))

  const sampleRows = monthly.rows.slice(0, SAMPLE_SIZE)
  await assertDirectFacts(sampleRows, RESOLVED_HISTORICAL_DAY)
  const mini = await getTriggerDiscoveryMiniCharts({
    tickers: sampleRows.map((row) => row.ticker),
    requestedAsOf: REQUESTED_TRADING_DAY,
    timeframe: 'MONTHLY',
    ma1Period: 20,
    ma2Period: 25,
  })
  assert.equal(mini.resolvedAsOf, RESOLVED_HISTORICAL_DAY)
  const miniByTicker = new Map(mini.charts.map((chart) => [chart.ticker, chart]))
  for (const row of sampleRows) {
    const chart = miniByTicker.get(row.ticker)
    const point = chart?.points.at(-1)
    assert.ok(chart && point, `${row.ticker} historical Mini Chart`)
    assert.ok(chart.points.every((item) => item.date <= RESOLVED_HISTORICAL_DAY), `${row.ticker} Mini Chart PIT`)
    assert.equal(point.date, row.maDate, `${row.ticker} Mini Chart right edge`)
    assert.ok(closeEnough(point.close, row.price), `${row.ticker} Mini Chart close`)
    assert.ok(closeEnough(point.ma1, row.ma1Value), `${row.ticker} Mini Chart MA1`)
    assert.ok(closeEnough(point.ma2, row.ma2Value), `${row.ticker} Mini Chart MA2`)
  }

  const recentSessions = await source.loadMarketSessions('2026-08-25', 30)
  const recentCandidates = await source.loadCandidateSnapshots({
    resolvedAsOf: recentSessions.value[0],
    oldestSessionDate: recentSessions.value.at(-1)!,
    liquidityLookbackSessions: 20,
  })
  const selected = recentCandidates.value.filter((row) => row.ticker === '7003' || row.ticker === '7203')
    .flatMap((row) => row.priceDate && row.price != null ? [{
      ...row,
      priceDate: row.priceDate,
      price: row.price,
      averageVolume: row.averageVolume,
      averageTradingValue: row.averageTradingValue,
      liquidityObservationCount: row.liquidityObservationCount,
      priceStalenessSessions: 0,
      priceFreshness: 'CURRENT' as const,
      liquidityComplete: true,
    }] : [])
  assert.equal(selected.length, 2, 'fast/generic fixtures')
  const [stored, generic] = await Promise.all([
    source.loadStoredMaObservations({
      candidates: selected,
      ma1Period: 20,
      ma2Period: 25,
      oldestObservationDate: recentSessions.value.at(-1)!,
      requiredObservations: 6,
    }),
    source.loadGenericMaObservations({
      candidates: selected,
      ma1Period: 20,
      ma2Period: 25,
      requiredObservations: 6,
    }),
  ])
  for (const candidate of selected) {
    const fastPoint = stored.value.get(candidate.ticker)?.at(-1)
    const genericPoint = generic.value.get(candidate.ticker)?.at(-1)
    assert.ok(fastPoint && genericPoint, `${candidate.ticker} fast/generic observations`)
    assert.equal(fastPoint.date, candidate.priceDate)
    assert.equal(genericPoint.date, candidate.priceDate)
    assert.ok(fastPoint.date <= recentSessions.value[0])
    assert.ok(genericPoint.date <= recentSessions.value[0])
    assert.ok(closeEnough(fastPoint.price, genericPoint.price), `${candidate.ticker} fast/generic price`)
    assert.ok(closeEnough(fastPoint.ma1, genericPoint.ma1), `${candidate.ticker} fast/generic MA1`)
    assert.ok(closeEnough(fastPoint.ma2, genericPoint.ma2), `${candidate.ticker} fast/generic MA2`)
  }

  const [preIpo, listed, afterHistory] = await Promise.all([
    universeRow('441A'),
    universeRow('7003'),
    universeRow('7691'),
  ])
  const membership = (row: HistoricalUniverseRow) => isHistoricalUniverseMemberAt({
    asOf: RESOLVED_HISTORICAL_DAY,
    currentActive: row.active === 1,
    historicalRecordExists: true,
    firstTradeDate: row.first_trade_date,
    lastTradeDate: row.last_trade_date,
    ledgerThrough: row.latest_ohlcv_date,
  })
  assert.equal(membership(preIpo), false, 'pre-IPO ticker must be excluded')
  assert.equal(membership(listed), true, 'listed ticker must be included')
  assert.equal(membership(afterHistory), false, 'ticker after reconstructed listing history must be excluded')

  const base = parseTriggerDiscoverySearchRequest({ requestedAsOf: REQUESTED_TRADING_DAY })
  const weekendParsed = parseTriggerDiscoverySearchRequest({ requestedAsOf: REQUESTED_WEEKEND })
  const biweeklyParsed = parseTriggerDiscoverySearchRequest({ requestedAsOf: REQUESTED_TRADING_DAY, timeframe: 'BIWEEKLY' })
  const otherMa = parseTriggerDiscoverySearchRequest({ requestedAsOf: REQUESTED_TRADING_DAY, ma2Period: 50 })
  assert.notEqual(triggerDiscoveryBaseSearchKey(base.input, base.timeframe), triggerDiscoveryBaseSearchKey(weekendParsed.input, weekendParsed.timeframe))
  assert.notEqual(triggerDiscoveryBaseSearchKey(base.input, base.timeframe), triggerDiscoveryBaseSearchKey(biweeklyParsed.input, biweeklyParsed.timeframe))
  assert.notEqual(triggerDiscoveryBaseSearchKey(base.input, base.timeframe), triggerDiscoveryBaseSearchKey(otherMa.input, otherMa.timeframe))

  const after = await sideEffectCounts()
  assert.deepEqual(after, before, 'Historical Search must not create Evaluation, Lifecycle, Outbox, or Delivery rows')

  console.log(JSON.stringify({
    requestedTradingDay: REQUESTED_TRADING_DAY,
    requestedWeekend: REQUESTED_WEEKEND,
    requestedHoliday: REQUESTED_HOLIDAY,
    resolvedAsOf: RESOLVED_HISTORICAL_DAY,
    monthlyMatched: monthly.totalMatched,
    biweeklyMatched: biweekly.totalMatched,
    sampleTickers: sampleRows.map((row) => row.ticker),
    monthlyPerformanceMs: monthly.diagnostics.performance.totalMs,
    weekendPerformanceMs: weekend.diagnostics.performance.totalMs,
    biweeklyPerformanceMs: biweekly.diagnostics.performance.totalMs,
    miniChartPerformanceMs: mini.performance.totalMs,
    latestAvailableDate: latest.date,
    futureDateBehavior: 'resolved_to_latest',
    universeContract: 'reconstructed_from_currently_held_trade_history',
    sideEffectsBefore: before,
    sideEffectsAfter: after,
    totalTestMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
  }, null, 2))
  console.log('Trigger Discovery Historical As-of integration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
