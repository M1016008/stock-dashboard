import type { Client } from '@libsql/client'
import { ML_PHYSICS_FEATURE_SET, ML_PHYSICS_MODEL_TYPE } from '@/lib/backtest/ml-physics'
import { ML_PRIMARY_HORIZONS } from '@/lib/backtest/ml-horizons'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

export type MlPipelineMarket = 'JP' | 'US'
export type MlPipelineAction = 'verify-or-adopt' | 'mark-baseline' | 'mark-delta' | 'status'

export const ML_PIPELINE_NAME = 'core_forecast'
export const ML_PIPELINE_GENERATION_VERSION = 'full_history_then_delta_v2_calendar_stages'

type RangeRow = {
  minDate: string | null
  maxDate: string | null
  rows: number | null
}

type ModelRow = {
  modelType: string
  horizons: number | null
  models: number | null
  directions: number | null
  fullHistoryModels: number | null
  latestTrainStartDate: string | null
}

export type MlPipelineEvidence = {
  market: MlPipelineMarket
  sourceDate: string
  sourceStartDate: string | null
  sourceRows: number | null
  featureStartDate: string | null
  featureDate: string
  featureRows: number | null
  physicsStartDate: string | null
  physicsDate: string
  physicsRows: number | null
  normalModelHorizons: number
  physicsModelHorizons: number
  normalModelDirections: number
  physicsModelDirections: number
  normalModelCount: number
  physicsModelCount: number
  normalFullHistoryModels: number
  physicsFullHistoryModels: number
  normalTrainStartDate: string | null
  physicsTrainStartDate: string | null
  fullHistoryModelReady: boolean
  priceBasis: string | null
}

export type MlPipelineState = {
  market: MlPipelineMarket
  pipeline: string
  generationVersion: string
  status: string
  baselineSourceDate: string
  baselineStartDate: string | null
  lastDeltaSourceDate: string
  priceBasis: string | null
  featureSet: string
  baselineCompletedAt: number
  lastDeltaCompletedAt: number
  payloadJson: string
}

const NORMAL_MODEL_TYPE = 'logistic_regression_v1'

function numberValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function objectValue(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function hasAuditedFullHistoryBaseline(state: MlPipelineState | null): boolean {
  if (
    !state
    || state.status !== 'complete'
    || state.generationVersion !== ML_PIPELINE_GENERATION_VERSION
    || state.featureSet !== ML_PHYSICS_FEATURE_SET
  ) return false

  const payload = objectValue(state.payloadJson)
  const baseline = payload.baseline && typeof payload.baseline === 'object' && !Array.isArray(payload.baseline)
    ? payload.baseline as Record<string, unknown>
    : payload
  return baseline.fullHistoryModelReady === true
}

export function canRefreshLegacyBaselineForCalendarStages(state: MlPipelineState | null): boolean {
  if (
    !state
    || state.status !== 'complete'
    || state.generationVersion !== 'full_history_then_delta_v1'
    || state.featureSet !== ML_PHYSICS_FEATURE_SET
  ) return false

  const payload = objectValue(state.payloadJson)
  const baseline = payload.baseline && typeof payload.baseline === 'object' && !Array.isArray(payload.baseline)
    ? payload.baseline as Record<string, unknown>
    : payload
  return baseline.fullHistoryModelReady === true
}

async function range(
  client: Client,
  table: 'ohlcv_daily' | 'ml_feature_vectors' | 'ml_feature_vectors_v2',
  includeCounts: boolean,
  where = '',
  throughDate: string | null = null,
): Promise<RangeRow> {
  const rangeWhere = throughDate
    ? `${where || 'WHERE 1 = 1'} AND date <= ?`
    : where
  const sql = includeCounts
    ? `
      SELECT MIN(date) AS minDate, MAX(date) AS maxDate, COUNT(*) AS rows
      FROM ${table}
      ${rangeWhere}
    `
    : `
      SELECT
        (SELECT date FROM ${table} ${rangeWhere} ORDER BY date ASC LIMIT 1) AS minDate,
        (SELECT date FROM ${table} ${rangeWhere} ORDER BY date DESC LIMIT 1) AS maxDate,
        NULL AS rows
    `
  const args = throughDate
    ? (includeCounts ? [throughDate] : [throughDate, throughDate])
    : []
  const result = await client.execute({ sql, args })
  const row = result.rows[0]
  return {
    minDate: stringValue(row?.minDate),
    maxDate: stringValue(row?.maxDate),
    rows: includeCounts ? numberValue(row?.rows) : null,
  }
}

async function modelCoverage(client: Client): Promise<Map<string, ModelRow>> {
  const result = await client.execute({
    sql: `
      SELECT
        m.model_type AS modelType,
        COUNT(DISTINCT m.horizon_days) AS horizons,
        COUNT(*) AS models,
        COUNT(DISTINCT m.direction) AS directions,
        SUM(
          CASE
            -- yearly covers every training year with a bounded, stratified sample.
            WHEN json_extract(m.metrics_json, '$.mode') IN ('all_paged', 'all_paged_multi', 'yearly') THEN 1
            ELSE 0
          END
        ) AS fullHistoryModels,
        MAX(json_extract(m.metrics_json, '$.trainStartDate')) AS latestTrainStartDate
      FROM ml_models m
      WHERE m.model_type IN (?, ?)
        AND m.trained_at = (
          SELECT MAX(newer.trained_at)
          FROM ml_models newer
          WHERE newer.model_type = m.model_type
            AND newer.horizon_days = m.horizon_days
            AND newer.direction = m.direction
        )
      GROUP BY m.model_type
    `,
    args: [NORMAL_MODEL_TYPE, ML_PHYSICS_MODEL_TYPE],
  })
  return new Map(result.rows.map((row) => [String(row.modelType), {
    modelType: String(row.modelType),
    horizons: numberValue(row.horizons),
    models: numberValue(row.models),
    directions: numberValue(row.directions),
    fullHistoryModels: numberValue(row.fullHistoryModels),
    latestTrainStartDate: stringValue(row.latestTrainStartDate),
  }]))
}

async function metadataValue(client: Client, key: string): Promise<string | null> {
  try {
    const result = await client.execute({
      sql: 'SELECT value FROM us_analytics_metadata WHERE key = ? LIMIT 1',
      args: [key],
    })
    return stringValue(result.rows[0]?.value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return null
    throw error
  }
}

export async function ensureMlPipelineGenerationTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ml_pipeline_generations (
      market TEXT NOT NULL,
      pipeline TEXT NOT NULL,
      generation_version TEXT NOT NULL,
      status TEXT NOT NULL,
      baseline_source_date TEXT NOT NULL,
      baseline_start_date TEXT,
      last_delta_source_date TEXT NOT NULL,
      price_basis TEXT,
      feature_set TEXT NOT NULL,
      baseline_completed_at INTEGER NOT NULL,
      last_delta_completed_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (market, pipeline)
    )
  `)
}

export async function inspectMlPipelineEvidence(
  client: Client,
  market: MlPipelineMarket,
  options: { includeCounts?: boolean; requireFullHistoryModels?: boolean; sourceDate?: string | null } = {},
): Promise<MlPipelineEvidence> {
  const includeCounts = options.includeCounts === true
  const sourceDate = options.sourceDate?.trim() || null
  if (sourceDate && !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
    throw new Error(`${market} ML baseline check failed: invalid source date ${sourceDate}`)
  }
  const [source, features, physics, models, priceBasis] = await Promise.all([
    range(client, 'ohlcv_daily', includeCounts, '', sourceDate),
    range(client, 'ml_feature_vectors', includeCounts, '', sourceDate),
    range(
      client,
      'ml_feature_vectors_v2',
      includeCounts,
      `WHERE feature_set = '${ML_PHYSICS_FEATURE_SET.replaceAll("'", "''")}'`,
      sourceDate,
    ),
    modelCoverage(client),
    market === 'US' ? metadataValue(client, 'ohlcv_price_basis') : Promise.resolve(null),
  ])

  if (!source.maxDate) throw new Error(`${market} ML baseline check failed: ohlcv_daily is empty`)
  if (sourceDate && source.maxDate !== sourceDate) {
    throw new Error(`${market} ML baseline check failed: requested source=${sourceDate}, available=${source.maxDate}`)
  }
  if (features.maxDate !== source.maxDate) {
    throw new Error(`${market} ML baseline check failed: features=${features.maxDate ?? '-'}, price=${source.maxDate}`)
  }
  if (physics.maxDate !== source.maxDate) {
    throw new Error(`${market} ML baseline check failed: physics=${physics.maxDate ?? '-'}, price=${source.maxDate}`)
  }

  const requiredHorizons = ML_PRIMARY_HORIZONS.length
  const normalHorizons = numberValue(models.get(NORMAL_MODEL_TYPE)?.horizons)
  const physicsHorizons = numberValue(models.get(ML_PHYSICS_MODEL_TYPE)?.horizons)
  const normalDirections = numberValue(models.get(NORMAL_MODEL_TYPE)?.directions)
  const physicsDirections = numberValue(models.get(ML_PHYSICS_MODEL_TYPE)?.directions)
  const normalModelCount = numberValue(models.get(NORMAL_MODEL_TYPE)?.models)
  const physicsModelCount = numberValue(models.get(ML_PHYSICS_MODEL_TYPE)?.models)
  const normalFullHistoryModels = numberValue(models.get(NORMAL_MODEL_TYPE)?.fullHistoryModels)
  const physicsFullHistoryModels = numberValue(models.get(ML_PHYSICS_MODEL_TYPE)?.fullHistoryModels)
  const normalTrainStartDate = stringValue(models.get(NORMAL_MODEL_TYPE)?.latestTrainStartDate)
  const physicsTrainStartDate = stringValue(models.get(ML_PHYSICS_MODEL_TYPE)?.latestTrainStartDate)
  const expectedNormalModels = requiredHorizons * 2
  const expectedPhysicsModels = requiredHorizons * 3
  if (
    normalHorizons < requiredHorizons
    || physicsHorizons < requiredHorizons
    || normalDirections < 2
    || physicsDirections < 3
    || normalModelCount < expectedNormalModels
    || physicsModelCount < expectedPhysicsModels
  ) {
    throw new Error(
      `${market} ML baseline check failed: model coverage normal=${normalHorizons}h/${normalDirections}d/${normalModelCount}m, `
      + `physics=${physicsHorizons}h/${physicsDirections}d/${physicsModelCount}m`,
    )
  }
  const fullHistoryModelReady = (
    normalFullHistoryModels >= expectedNormalModels
    && physicsFullHistoryModels >= expectedPhysicsModels
    && normalTrainStartDate !== null
    && features.minDate !== null
    && normalTrainStartDate <= features.minDate
    && physicsTrainStartDate !== null
    && physics.minDate !== null
    && physicsTrainStartDate <= physics.minDate
  )
  if (options.requireFullHistoryModels === true && !fullHistoryModelReady) {
    throw new Error(
      `${market} ML baseline check failed: full-history model proof `
      + `normal=${normalFullHistoryModels}/${expectedNormalModels}, `
      + `physics=${physicsFullHistoryModels}/${expectedPhysicsModels}, `
      + `train_start normal=${normalTrainStartDate ?? '-'}<=${features.minDate ?? '-'}, `
      + `physics=${physicsTrainStartDate ?? '-'}<=${physics.minDate ?? '-'}`,
    )
  }
  if (market === 'US' && priceBasis !== US_ADJUSTED_PRICE_BASIS) {
    throw new Error(`${market} ML baseline check failed: price basis=${priceBasis ?? '-'}, expected=${US_ADJUSTED_PRICE_BASIS}`)
  }
  if (includeCounts && (!features.rows || !physics.rows || !source.rows)) {
    throw new Error(`${market} ML baseline check failed: full-history evidence is empty`)
  }

  return {
    market,
    sourceDate: source.maxDate,
    sourceStartDate: source.minDate,
    sourceRows: source.rows,
    featureStartDate: features.minDate,
    featureDate: features.maxDate,
    featureRows: features.rows,
    physicsStartDate: physics.minDate,
    physicsDate: physics.maxDate,
    physicsRows: physics.rows,
    normalModelHorizons: normalHorizons,
    physicsModelHorizons: physicsHorizons,
    normalModelDirections: normalDirections,
    physicsModelDirections: physicsDirections,
    normalModelCount,
    physicsModelCount,
    normalFullHistoryModels,
    physicsFullHistoryModels,
    normalTrainStartDate,
    physicsTrainStartDate,
    fullHistoryModelReady,
    priceBasis,
  }
}

export async function readMlPipelineState(
  client: Client,
  market: MlPipelineMarket,
): Promise<MlPipelineState | null> {
  await ensureMlPipelineGenerationTable(client)
  const result = await client.execute({
    sql: `
      SELECT
        market,
        pipeline,
        generation_version AS generationVersion,
        status,
        baseline_source_date AS baselineSourceDate,
        baseline_start_date AS baselineStartDate,
        last_delta_source_date AS lastDeltaSourceDate,
        price_basis AS priceBasis,
        feature_set AS featureSet,
        baseline_completed_at AS baselineCompletedAt,
        last_delta_completed_at AS lastDeltaCompletedAt,
        payload_json AS payloadJson
      FROM ml_pipeline_generations
      WHERE market = ? AND pipeline = ?
      LIMIT 1
    `,
    args: [market, ML_PIPELINE_NAME],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    market,
    pipeline: String(row.pipeline),
    generationVersion: String(row.generationVersion),
    status: String(row.status),
    baselineSourceDate: String(row.baselineSourceDate),
    baselineStartDate: stringValue(row.baselineStartDate),
    lastDeltaSourceDate: String(row.lastDeltaSourceDate),
    priceBasis: stringValue(row.priceBasis),
    featureSet: String(row.featureSet),
    baselineCompletedAt: numberValue(row.baselineCompletedAt),
    lastDeltaCompletedAt: numberValue(row.lastDeltaCompletedAt),
    payloadJson: String(row.payloadJson ?? '{}'),
  }
}

export async function recordMlPipelineBaseline(
  client: Client,
  evidence: MlPipelineEvidence,
  options: { adoptedExisting?: boolean } = {},
): Promise<void> {
  if (!evidence.fullHistoryModelReady) {
    throw new Error(`${evidence.market} ML baseline cannot be recorded without full-history model proof`)
  }
  await ensureMlPipelineGenerationTable(client)
  const now = Math.floor(Date.now() / 1000)
  await client.execute({
    sql: `
      INSERT INTO ml_pipeline_generations (
        market, pipeline, generation_version, status,
        baseline_source_date, baseline_start_date, last_delta_source_date,
        price_basis, feature_set, baseline_completed_at, last_delta_completed_at,
        payload_json, updated_at
      ) VALUES (?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, pipeline) DO UPDATE SET
        generation_version = excluded.generation_version,
        status = excluded.status,
        baseline_source_date = excluded.baseline_source_date,
        baseline_start_date = excluded.baseline_start_date,
        last_delta_source_date = excluded.last_delta_source_date,
        price_basis = excluded.price_basis,
        feature_set = excluded.feature_set,
        baseline_completed_at = excluded.baseline_completed_at,
        last_delta_completed_at = excluded.last_delta_completed_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `,
    args: [
      evidence.market,
      ML_PIPELINE_NAME,
      ML_PIPELINE_GENERATION_VERSION,
      evidence.sourceDate,
      evidence.featureStartDate,
      evidence.sourceDate,
      evidence.priceBasis,
      ML_PHYSICS_FEATURE_SET,
      now,
      now,
      JSON.stringify({ ...evidence, adoptedExisting: options.adoptedExisting === true }),
      now,
    ],
  })
}

export async function recordMlPipelineDelta(
  client: Client,
  market: MlPipelineMarket,
  evidence: MlPipelineEvidence,
): Promise<void> {
  const state = await readMlPipelineState(client, market)
  if (!state || state.status !== 'complete' || state.generationVersion !== ML_PIPELINE_GENERATION_VERSION) {
    throw new Error(`${market} ML delta cannot be recorded before a completed ${ML_PIPELINE_GENERATION_VERSION} baseline`)
  }
  const previousPayload = objectValue(state.payloadJson)
  const baselinePayload = previousPayload.baseline && typeof previousPayload.baseline === 'object'
    ? previousPayload.baseline
    : previousPayload
  const now = Math.floor(Date.now() / 1000)
  await client.execute({
    sql: `
      UPDATE ml_pipeline_generations
      SET last_delta_source_date = ?,
          last_delta_completed_at = ?,
          price_basis = ?,
          payload_json = ?,
          updated_at = ?
      WHERE market = ? AND pipeline = ?
    `,
    args: [
      evidence.sourceDate,
      now,
      evidence.priceBasis,
      JSON.stringify({ baseline: baselinePayload, latestDelta: evidence, updateMode: 'delta' }),
      now,
      market,
      ML_PIPELINE_NAME,
    ],
  })
}

export async function verifyOrAdoptMlPipelineBaseline(
  client: Client,
  market: MlPipelineMarket,
): Promise<{ state: MlPipelineState; adopted: boolean }> {
  const existing = await readMlPipelineState(client, market)
  if (existing) {
    if (existing.status !== 'complete' || existing.generationVersion !== ML_PIPELINE_GENERATION_VERSION) {
      throw new Error(
        `${market} ML baseline generation is incompatible: status=${existing.status}, version=${existing.generationVersion}`,
      )
    }
    if (existing.featureSet !== ML_PHYSICS_FEATURE_SET) {
      throw new Error(
        `${market} ML baseline feature set is incompatible: actual=${existing.featureSet}, expected=${ML_PHYSICS_FEATURE_SET}`,
      )
    }
    if (market === 'US' && existing.priceBasis !== US_ADJUSTED_PRICE_BASIS) {
      throw new Error(
        `${market} ML baseline price basis is incompatible: actual=${existing.priceBasis ?? '-'}, expected=${US_ADJUSTED_PRICE_BASIS}`,
      )
    }
    await inspectMlPipelineEvidence(client, market, {
      requireFullHistoryModels: true,
      sourceDate: existing.baselineSourceDate,
    })
    return { state: existing, adopted: false }
  }

  const evidence = await inspectMlPipelineEvidence(client, market, {
    includeCounts: true,
    requireFullHistoryModels: true,
  })
  await recordMlPipelineBaseline(client, evidence, { adoptedExisting: true })
  const adopted = await readMlPipelineState(client, market)
  if (!adopted) throw new Error(`${market} ML baseline adoption failed`)
  return { state: adopted, adopted: true }
}
