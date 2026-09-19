import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execGet, execRun } from '@/lib/db/client'
import { getTriggerDiscoveryOptions } from '@/lib/server/trigger-discovery-options'
import {
  SavedTriggerNotFoundError,
  archiveSavedTriggerDefinition,
  createSavedTriggerDefinition,
  getSavedTriggerDefinition,
  listSavedTriggerDefinitions,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'
import { parseTriggerDiscoverySearchRequest } from '@/lib/server/trigger-discovery-search-request'
import { getTriggerDiscovery } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerDiscoverySearchRequest } from '@/lib/trigger-discovery-contract'
import {
  SavedTriggerValidationError,
  savedTriggerConfigsFromSearchRequest,
  searchRequestFromSavedTrigger,
  type SavedTriggerEvaluationConfig,
  type SavedTriggerViewConfig,
} from '@/lib/trigger-definition'

const namePrefix = '__phase7_saved_trigger_test__'
const createdIds: string[] = []

async function cleanup() {
  await execRun('DELETE FROM trigger_definitions WHERE name LIKE ?', [`${namePrefix}%`])
}

function changedEvaluation(
  source: SavedTriggerEvaluationConfig,
  change: (copy: SavedTriggerEvaluationConfig) => void,
): SavedTriggerEvaluationConfig {
  const copy = structuredClone(source)
  change(copy)
  return copy
}

async function main() {
  await cleanup()
  try {
    const options = await getTriggerDiscoveryOptions()
    const realMarkets = options.markets.map((market) => market.value)
    const firstMarket = realMarkets.find((market): market is string => market != null)
    const secondMarket = realMarkets.find((market): market is string => market != null && market !== firstMarket)
    assert.ok(firstMarket && secondMarket, 'version test requires at least two market values')

    const sourceRequest: TriggerDiscoverySearchRequest = {
      requestedAsOf: '2026-08-25',
      timeframe: 'BIWEEKLY',
      ma1Period: 10,
      ma2Period: 20,
      slopeLookbackSessions: 18,
      approachLookbackSessions: 16,
      minimumAboveZoneRatio: 0.75,
      maxApproachDistancePct: 4,
      nearDistancePct: 1.5,
      spreadExpansionEnabled: true,
      spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7,
      requireBullishMaOrder: true,
      markets: [secondMarket, firstMarket, secondMarket],
      priceMin: 500,
      priceMax: 50_000,
      averageVolumeMin: 100_000,
      averageVolumeMax: null,
      averageTradingValueMin: 50_000_000,
      averageTradingValueMax: null,
      liquidityLookbackSessions: 40,
      maxPriceStalenessSessions: 2,
      stageFilters: { weekBStage: [2, 1, 2], monthAStage: ['unknown', 6] },
      sort: { key: 'triggerScore', direction: 'desc' } as const,
      page: 4,
      pageSize: 25,
    }
    const configs = savedTriggerConfigsFromSearchRequest(sourceRequest)
    assert.deepEqual(configs.evaluationConfig.universe.markets, [firstMarket, secondMarket].sort((a, b) => a.localeCompare(b, 'ja')))
    assert.deepEqual(configs.evaluationConfig.stageFilters.weekBStage, [1, 2])
    assert.deepEqual(configs.evaluationConfig.stageFilters.monthAStage, [6, 'unknown'])

    let definition = await createSavedTriggerDefinition({
      name: `  ${namePrefix}primary  `,
      ...configs,
    })
    createdIds.push(definition.id)
    assert.equal(definition.name, `${namePrefix}primary`)
    assert.equal(definition.evaluationVersion, 1)
    assert.equal(definition.evaluationConfig.timeframe, 'BIWEEKLY')
    assert.equal(definition.evaluationConfig.triggerCore.spreadExpansionEnabled, true)
    assert.equal(definition.engineVersion, 1)
    assert.equal(definition.scoreVersion, 1)
    assert.equal(definition.evaluationSignature.length, 64)
    assert.equal(JSON.stringify(definition).includes('2026-08-25'), false, 'requestedAsOf must not be persisted')
    assert.equal('requestedAsOf' in definition.evaluationConfig, false)

    const read = await getSavedTriggerDefinition(definition.id)
    assert.deepEqual(read.evaluationConfig, configs.evaluationConfig)
    assert.deepEqual(read.viewConfig, configs.viewConfig)
    assert.ok((await listSavedTriggerDefinitions()).some((item) => item.id === definition.id))

    const loadedRequest = searchRequestFromSavedTrigger(read, '2026-09-10')
    assert.equal(loadedRequest.requestedAsOf, '2026-09-10')
    assert.equal(JSON.stringify(loadedRequest).includes('2026-08-25'), false)
    const parsedLoaded = parseTriggerDiscoverySearchRequest(loadedRequest)
    const parsedManual = parseTriggerDiscoverySearchRequest({ ...sourceRequest, requestedAsOf: '2026-09-10', page: 1 })
    assert.deepEqual(parsedLoaded.input, parsedManual.input, 'saved and manual conditions must enter the same search contract')
    assert.equal(parsedLoaded.timeframe, 'BIWEEKLY')
    assert.equal(parsedManual.timeframe, 'BIWEEKLY')

    const belowRequest: TriggerDiscoverySearchRequest = {
      requestedAsOf: '2026-09-18', timeframe: 'BIWEEKLY', ma1Period: 25, ma2Period: 44,
      belowZoneToleranceEnabled: true, maxBelowZonePct: 3, statusFilter: 'BELOW_ZONE',
      page: 1, pageSize: 50, stageFilters: {},
    }
    const belowDefinition = await createSavedTriggerDefinition({
      name: `${namePrefix}2w-below`, ...savedTriggerConfigsFromSearchRequest(belowRequest),
    })
    createdIds.push(belowDefinition.id)
    const loadedBelow = searchRequestFromSavedTrigger(await getSavedTriggerDefinition(belowDefinition.id), belowRequest.requestedAsOf)
    assert.equal(loadedBelow.statusFilter, 'BELOW_ZONE')
    const savedParsed = parseTriggerDiscoverySearchRequest(loadedBelow)
    const manualParsed = parseTriggerDiscoverySearchRequest(belowRequest)
    assert.deepEqual(savedParsed.input.triggerConfig, manualParsed.input.triggerConfig,
      'saved 2W 25/44 Below config matches manual evaluation')
    assert.equal(savedParsed.input.asOf, manualParsed.input.asOf)
    assert.deepEqual(savedParsed.input.stageFilters, manualParsed.input.stageFilters)
    const manualResult = await getTriggerDiscovery({ ...manualParsed.input, limit: 10_000, offset: 0 }, { timeframe: 'BIWEEKLY' })
    const savedResult = await getTriggerDiscovery({ ...savedParsed.input, limit: 10_000, offset: 0 }, { timeframe: 'BIWEEKLY' })
    assert.deepEqual(savedResult.rows, manualResult.rows, 'saved 2W Below candidate values and ordering match manual')

    definition = await updateSavedTriggerDefinition(definition.id, { name: `${namePrefix}renamed` })
    assert.equal(definition.evaluationVersion, 1, 'rename does not change evaluationVersion')

    const sortOnly: SavedTriggerViewConfig = { sort: { key: 'ticker', direction: 'asc' }, pageSize: 25 }
    definition = await updateSavedTriggerDefinition(definition.id, { viewConfig: sortOnly })
    assert.equal(definition.evaluationVersion, 1, 'sort change does not change evaluationVersion')
    definition = await updateSavedTriggerDefinition(definition.id, { viewConfig: { ...sortOnly, pageSize: 100 } })
    assert.equal(definition.evaluationVersion, 1, 'page size change does not change evaluationVersion')
    const signatureBeforeStatusFilter = definition.evaluationSignature
    definition = await updateSavedTriggerDefinition(definition.id, {
      viewConfig: { ...definition.viewConfig, statusFilter: 'BELOW_ZONE' },
    })
    assert.equal(definition.evaluationVersion, 1, 'Status view filter must not change evaluationVersion')
    assert.equal(definition.evaluationSignature, signatureBeforeStatusFilter)
    assert.equal(searchRequestFromSavedTrigger(definition, '2026-09-10').statusFilter, 'BELOW_ZONE')

    const engineVersion = definition.engineVersion
    const scoreVersion = definition.scoreVersion
    const biweeklySignature = definition.evaluationSignature
    definition = await updateSavedTriggerDefinition(definition.id, {
      evaluationConfig: changedEvaluation(definition.evaluationConfig, (copy) => { copy.timeframe = 'MONTHLY' }),
    })
    assert.equal(definition.evaluationVersion, 2, 'Biweekly to Monthly increments evaluationVersion')
    assert.notEqual(definition.evaluationSignature, biweeklySignature, 'Monthly and Biweekly signatures must differ')
    assert.equal(definition.engineVersion, engineVersion, 'timeframe does not change Trigger Engine version')
    assert.equal(definition.scoreVersion, scoreVersion, 'timeframe does not change Trigger Score version')
    definition = await updateSavedTriggerDefinition(definition.id, {
      evaluationConfig: changedEvaluation(definition.evaluationConfig, (copy) => { copy.timeframe = 'BIWEEKLY' }),
    })
    assert.equal(definition.evaluationVersion, 3, 'Monthly to Biweekly increments evaluationVersion')
    assert.equal(definition.evaluationSignature, biweeklySignature, 'canonical Biweekly signature must be deterministic')

    const changes: Array<[string, (copy: SavedTriggerEvaluationConfig) => void]> = [
      ['MA', (copy) => { copy.triggerCore.ma2Period = 25 }],
      ['distance', (copy) => { copy.triggerCore.maxApproachDistancePct = 3 }],
      ['Spread toggle', (copy) => { copy.triggerCore.spreadExpansionEnabled = !copy.triggerCore.spreadExpansionEnabled }],
      ['Spread lookback', (copy) => { copy.triggerCore.spreadLookbackIntervals = 6 }],
      ['Spread ratio', (copy) => { copy.triggerCore.minExpansionRatio = 0.8 }],
      ['Below toggle', (copy) => { copy.triggerCore.belowZoneToleranceEnabled = true }],
      ['Below threshold 3 to 2', (copy) => { copy.triggerCore.maxBelowZonePct = 2 }],
      ['Below threshold 2 to 5', (copy) => { copy.triggerCore.maxBelowZonePct = 5 }],
      ['Below toggle off', (copy) => { copy.triggerCore.belowZoneToleranceEnabled = false }],
      ['market', (copy) => { copy.universe.markets = [firstMarket] }],
      ['liquidity', (copy) => { copy.universe.averageTradingValueMin = 100_000_000 }],
      ['Stage', (copy) => { copy.stageFilters.dayAStage = [1, 2] }],
    ]
    for (const [label, mutate] of changes) {
      const before: number = definition.evaluationVersion
      definition = await updateSavedTriggerDefinition(definition.id, {
        evaluationConfig: changedEvaluation(definition.evaluationConfig, mutate),
      })
      assert.equal(definition.evaluationVersion, before + 1, `${label} change increments evaluationVersion`)
    }

    const duplicateName = await createSavedTriggerDefinition({
      name: definition.name,
      evaluationConfig: definition.evaluationConfig,
      viewConfig: definition.viewConfig,
    })
    createdIds.push(duplicateName.id)
    assert.notEqual(duplicateName.id, definition.id, 'duplicate names are allowed; ID is identity')

    await archiveSavedTriggerDefinition(definition.id)
    await assert.rejects(() => getSavedTriggerDefinition(definition.id), SavedTriggerNotFoundError)
    assert.equal((await listSavedTriggerDefinitions()).some((item) => item.id === definition.id), false)
    await assert.rejects(() => getSavedTriggerDefinition('not-an-id'), SavedTriggerValidationError)
    await assert.rejects(
      () => getSavedTriggerDefinition('00000000-0000-4000-8000-000000000000'),
      SavedTriggerNotFoundError,
    )

    await assert.rejects(() => createSavedTriggerDefinition({
      name: ' ', evaluationConfig: configs.evaluationConfig, viewConfig: configs.viewConfig,
    }), SavedTriggerValidationError)
    await assert.rejects(() => createSavedTriggerDefinition({
      name: `${namePrefix}invalid-timeframe`,
      evaluationConfig: { ...configs.evaluationConfig, timeframe: 'WEEKLY' },
      viewConfig: configs.viewConfig,
    }), SavedTriggerValidationError)

    const legacyId = randomUUID()
    const legacySignature = 'legacy-monthly-signature'.padEnd(64, '0')
    const legacyConfig = structuredClone(configs.evaluationConfig) as Partial<SavedTriggerEvaluationConfig>
    delete legacyConfig.timeframe
    const legacyCore = legacyConfig.triggerCore as Partial<SavedTriggerEvaluationConfig['triggerCore']>
    delete legacyCore.spreadExpansionEnabled
    delete legacyCore.spreadLookbackIntervals
    delete legacyCore.minExpansionRatio
    delete legacyCore.requireBullishMaOrder
    delete legacyCore.belowZoneToleranceEnabled
    delete legacyCore.maxBelowZonePct
    await execRun(`INSERT INTO trigger_definitions (
      id, name, evaluation_config_json, view_config_json, evaluation_signature,
      evaluation_version, engine_version, score_version
    ) VALUES (?, ?, ?, ?, ?, 7, ?, ?)`, [
      legacyId, `${namePrefix}legacy-monthly`, JSON.stringify(legacyConfig),
      JSON.stringify(configs.viewConfig), legacySignature, engineVersion, scoreVersion,
    ])
    const legacyRead = await getSavedTriggerDefinition(legacyId)
    assert.equal(legacyRead.evaluationConfig.timeframe, 'MONTHLY', 'missing legacy timeframe means Monthly')
    assert.equal(legacyRead.evaluationConfig.triggerCore.spreadExpansionEnabled, false, 'missing legacy Spread means OFF')
    assert.equal(legacyRead.evaluationConfig.triggerCore.spreadLookbackIntervals, 4)
    assert.equal(legacyRead.evaluationConfig.triggerCore.minExpansionRatio, 0.7)
    assert.equal(legacyRead.evaluationConfig.triggerCore.requireBullishMaOrder, true)
    assert.equal(legacyRead.evaluationConfig.triggerCore.belowZoneToleranceEnabled, false)
    assert.equal(legacyRead.evaluationConfig.triggerCore.maxBelowZonePct, 3)
    await updateSavedTriggerDefinition(legacyId, {
      name: `${namePrefix}legacy-monthly-renamed`,
      evaluationConfig: legacyRead.evaluationConfig,
    })
    const legacyStored = await execGet<{
      evaluation_config_json: string
      evaluation_signature: string
      evaluation_version: number
    }>('SELECT evaluation_config_json, evaluation_signature, evaluation_version FROM trigger_definitions WHERE id=?', [legacyId])
    assert.equal(legacyStored?.evaluation_version, 7, 'semantic Monthly update must not bump a legacy version')
    assert.equal(legacyStored?.evaluation_signature, legacySignature, 'legacy Monthly signature must remain immutable')
    assert.equal(legacyStored?.evaluation_config_json, JSON.stringify(legacyConfig), 'legacy JSON must not be rewritten by a semantic no-op')

    const lowercaseLegacyId = randomUUID()
    const lowercaseLegacySignature = 'legacy-lowercase-monthly-signature'.padEnd(64, '0')
    const lowercaseLegacyConfig = { ...configs.evaluationConfig, timeframe: 'monthly' }
    await execRun(`INSERT INTO trigger_definitions (
      id, name, evaluation_config_json, view_config_json, evaluation_signature,
      evaluation_version, engine_version, score_version
    ) VALUES (?, ?, ?, ?, ?, 9, ?, ?)`, [
      lowercaseLegacyId, `${namePrefix}legacy-lowercase-monthly`, JSON.stringify(lowercaseLegacyConfig),
      JSON.stringify(configs.viewConfig), lowercaseLegacySignature, engineVersion, scoreVersion,
    ])
    const lowercaseLegacyRead = await getSavedTriggerDefinition(lowercaseLegacyId)
    assert.equal(lowercaseLegacyRead.evaluationConfig.timeframe, 'MONTHLY')
    await updateSavedTriggerDefinition(lowercaseLegacyId, { viewConfig: { sort: null, pageSize: 50 } })
    const lowercaseLegacyStored = await execGet<{ evaluation_signature: string; evaluation_version: number }>(
      'SELECT evaluation_signature, evaluation_version FROM trigger_definitions WHERE id=?',
      [lowercaseLegacyId],
    )
    assert.equal(lowercaseLegacyStored?.evaluation_version, 9)
    assert.equal(lowercaseLegacyStored?.evaluation_signature, lowercaseLegacySignature)
    await assert.rejects(() => createSavedTriggerDefinition({
      name: `${namePrefix}invalid`,
      evaluationConfig: changedEvaluation(configs.evaluationConfig, (copy) => { copy.universe.markets = ['unsupported-market'] }),
      viewConfig: configs.viewConfig,
    }), SavedTriggerValidationError)

    console.log(JSON.stringify({
      contract: 'saved-trigger-definition-v1',
      finalEvaluationVersion: definition.evaluationVersion,
      canonicalMarkets: configs.evaluationConfig.universe.markets,
      canonicalStages: configs.evaluationConfig.stageFilters,
      biweeklyRoundTrip: true,
      legacyMonthlyVersionPreserved: true,
      asOfPersisted: false,
      archiveMode: 'soft-delete',
    }))
    console.log('saved Trigger CRUD, canonicalization, versioning, archive, and as-of tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
