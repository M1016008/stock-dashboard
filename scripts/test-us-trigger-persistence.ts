import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execRun } from '@/lib/db/client'
import type { TriggerDiscoveryResult, TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import {
  evaluateSavedTriggerDefinition,
  getTriggerEvaluationDetail,
  listSavedTriggerEvaluations,
} from '@/lib/server/trigger-evaluations'
import {
  SavedTriggerNotFoundError,
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  getSavedTriggerDefinition,
  listSavedTriggerDefinitions,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import {
  getTriggerNotificationSettings,
  updateTriggerNotificationSettings,
} from '@/lib/server/trigger-notification-settings'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import {
  SAVED_TRIGGER_EVALUATION_CONFIG_VERSION,
  savedTriggerConfigsFromSearchRequest,
  type SavedTriggerEvaluationConfig,
} from '@/lib/trigger-definition'

const prefix = '__us_trigger_persistence__'

function legacyEvaluationSignature(config: SavedTriggerEvaluationConfig): string {
  const { belowZoneToleranceEnabled, maxBelowZonePct, ...legacyCore } = config.triggerCore
  const canonicalPayload = JSON.stringify({
    version: SAVED_TRIGGER_EVALUATION_CONFIG_VERSION,
    config: belowZoneToleranceEnabled
      ? config
      : { ...config, triggerCore: legacyCore },
  })
  return createHash('sha256').update(canonicalPayload).digest('hex')
}

function row(): TriggerDiscoveryRow {
  return {
    ticker: 'AAPL', companyName: 'Apple Inc.', market: 'NASDAQ',
    requestedAsOf: '2026-10-14', resolvedAsOf: '2026-10-14',
    priceDate: '2026-10-14', maDate: '2026-10-14', stageDate: '2026-10-14',
    price: 250, priceStalenessSessions: 0, priceFreshness: 'CURRENT',
    averageVolume: 40_000_000, averageTradingValue: 10_000_000_000,
    liquidityLookbackSessions: 20, liquidityObservationCount: 20, liquidityComplete: true,
    ma1Period: 20, ma2Period: 25, ma1Value: 245, ma2Value: 240,
    ma1Trend: 'RISING', ma2Trend: 'RISING', ma1SlopePct: 0.7, ma2SlopePct: 0.4,
    bothRising: true, maSpreadPct: 2.083, maSpreadSlope: 0.1,
    maSpreadExpansionRatio: 0.75, maSpreadExpanding: true,
    bullishMaOrder: true, spreadExpansionAvailable: true,
    zoneUpper: 245, zoneLower: 240, zoneDistancePct: 2.041,
    ma1DistancePct: 2.041, ma2DistancePct: 4.167, fromAbove: true,
    approachDirection: 'TOWARD_ZONE', approachVelocityPctPointsPerSession: 0.15,
    triggerStatus: 'NEAR', matched: true, maPath: 'generic', triggerScore: 81,
    scoreBreakdown: {
      proximity: 20, approach: 12, maTrend: 18, stageStructure: 21, liquidity: 10,
      total: 81, stageCoverage: 1, stageAvailableAxes: 6,
      maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
      explanations: { proximity: 'near', approach: 'toward', maTrend: 'rising', stageStructure: '6/6', liquidity: 'liquid' },
    },
    dayAStage: 1, dayBStage: 2, weekAStage: 1, weekBStage: 2,
    monthAStage: 1, monthBStage: 2, stageAvailable: true, stageComplete: true,
  }
}

function result(): TriggerDiscoveryResult {
  const item = row()
  return {
    contractVersion: 'trigger-discovery-v1', requestedAsOf: item.requestedAsOf,
    resolvedAsOf: item.resolvedAsOf,
    triggerConfig: { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ma1Period: 20, ma2Period: 25 },
    liquidityLookbackSessions: 20, maxPriceStalenessSessions: 3,
    totalTriggerMatched: 1, totalMatched: 1, rows: [item], limit: 10_000, offset: 0, hasMore: false,
    diagnostics: {
      counts: { universe: 1, afterMarket: 1, afterStalePrice: 1, currentPrice: 1, staleAccepted: 0, afterPrice: 1, afterVolume: 1, afterTradingValue: 1, evaluated: 1, matched: 1, afterStageFilter: 1, stageRows: 1, stageComplete: 1, stageIncomplete: 0 },
      rejected: { PIT_UNIVERSE: 0, MARKET_FILTER: 0, PRICE_FILTER: 0, VOLUME_FILTER: 0, TRADING_VALUE_FILTER: 0, STALE_PRICE: 0, INSUFFICIENT_HISTORY: 0, MA_NOT_BOTH_RISING: 0, MA_SPREAD_NOT_EXPANDING: 0, NOT_FROM_ABOVE: 0, NOT_APPROACHING: 0, TOO_FAR: 0 },
      performance: { queryCount: 1, dbQueryMs: 1, maPreparationMs: 1, engineEvaluationMs: 1, stageJoinMs: 1, scoreCalculationMs: 1, totalMs: 5, fastPathEvaluated: 0, genericPathEvaluated: 1 },
    },
  }
}

async function cleanup(): Promise<void> {
  await execRun(`DELETE FROM trigger_notification_settings WHERE definition_id IN (SELECT id FROM trigger_definitions WHERE name LIKE ?)`, [`${prefix}%`])
  await execRun(`DELETE FROM trigger_lifecycle_events WHERE definition_id IN (SELECT id FROM trigger_definitions WHERE name LIKE ?)`, [`${prefix}%`])
  await execRun(`DELETE FROM trigger_evaluation_observations WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id IN (SELECT id FROM trigger_definitions WHERE name LIKE ?))`, [`${prefix}%`])
  await execRun(`DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id IN (SELECT id FROM trigger_definitions WHERE name LIKE ?))`, [`${prefix}%`])
  await execRun(`DELETE FROM trigger_evaluations WHERE definition_id IN (SELECT id FROM trigger_definitions WHERE name LIKE ?)`, [`${prefix}%`])
  await execRun('DELETE FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
  await execRun("DELETE FROM market_universe WHERE market='US' AND ticker='__US_TRIGGER_TEST__'")
}

async function main(): Promise<void> {
  await cleanup()
  try {
    await execRun(`INSERT INTO market_universe (market, ticker, name, exchange, asset_type, active, source)
      VALUES ('US', '__US_TRIGGER_TEST__', 'US Trigger Test', 'NASDAQ', 'Stock', 1, 'test')`)
    const configs = savedTriggerConfigsFromSearchRequest({
      requestedAsOf: '2026-10-14', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
      markets: ['NASDAQ'], sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 50,
    })
    const us = await createSavedTriggerDefinition({ market: 'US', name: `${prefix}us`, ...configs })
    const jp = await createSavedTriggerDefinition({ name: `${prefix}jp`, ...savedTriggerConfigsFromSearchRequest({ requestedAsOf: '2026-10-14' }) })
    assert.equal(us.market, 'US')
    assert.equal(jp.market, 'JP')
    assert.equal(jp.evaluationSignature, legacyEvaluationSignature(jp.evaluationConfig))
    const renamedJp = await updateSavedTriggerDefinition(jp.id, { name: `${prefix}jp-renamed` })
    assert.equal(renamedJp.evaluationSignature, jp.evaluationSignature)
    assert.equal(renamedJp.evaluationVersion, jp.evaluationVersion)
    assert.deepEqual((await listSavedTriggerDefinitions('US')).map((item) => item.id), [us.id])
    assert.deepEqual((await listSavedTriggerDefinitions('JP')).map((item) => item.id), [jp.id])
    await assert.rejects(() => getSavedTriggerDefinition(us.id, 'JP'), SavedTriggerNotFoundError)
    await assert.rejects(() => getSavedTriggerDefinition(jp.id, 'US'), SavedTriggerNotFoundError)

    const settings = await updateTriggerNotificationSettings(us.id, { dailyDigestEnabled: true }, 'US')
    assert.equal(settings.dailyDigestEnabled, true)
    assert.equal((await getTriggerNotificationSettings(us.id, 'US')).dailyDigestEnabled, true)
    await assert.rejects(() => getTriggerNotificationSettings(us.id, 'JP'), SavedTriggerNotFoundError)

    const evaluated = await evaluateSavedTriggerDefinition(us.id, '2026-10-14', {
      market: 'US',
      resolveAsOf: async () => '2026-10-14',
      discover: async (_input, options) => {
        assert.equal(options?.maPath, 'generic')
        assert.ok(options?.dataSource, 'US evaluation must use an explicit US data source')
        return result()
      },
    })
    assert.equal(evaluated.evaluation.market, 'US')
    assert.equal(evaluated.evaluation.counts.finalMatched, 1)
    assert.equal((await listSavedTriggerEvaluations(us.id, 'US')).length, 1)
    const detail = await getTriggerEvaluationDetail({ evaluationId: evaluated.evaluation.id, market: 'US' })
    assert.equal(detail.evaluation.market, 'US')
    assert.equal(detail.members[0]?.ticker, 'AAPL')
    await assert.rejects(
      () => getTriggerEvaluationDetail({ evaluationId: evaluated.evaluation.id, market: 'JP' }),
      /Trigger評価が見つかりません/,
    )
    await assert.rejects(() => evaluateSavedTriggerDefinition(us.id, '2026-10-14'), SavedTriggerNotFoundError)

    await archiveSavedTriggerDefinition(us.id, 'US')
    assert.equal((await listSavedTriggerDefinitions('US')).length, 0)
    console.log('US trigger market-scoped definitions, evaluations, notifications, and isolation tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
