import { createHash, randomUUID } from 'node:crypto'
import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  SAVED_TRIGGER_CONTRACT_VERSION,
  SAVED_TRIGGER_EVALUATION_CONFIG_VERSION,
  SAVED_TRIGGER_NAME_MAX_LENGTH,
  SavedTriggerValidationError,
  canonicalizeSavedTriggerEvaluationConfig,
  canonicalizeSavedTriggerViewConfig,
  savedTriggerVersions,
  type SavedTriggerDefinition,
  type SavedTriggerEvaluationConfig,
  type SavedTriggerViewConfig,
} from '@/lib/trigger-definition'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type TriggerDefinitionRow = {
  id: string
  name: string
  evaluation_config_json: string
  view_config_json: string
  evaluation_signature: string
  evaluation_version: number
  engine_version: number
  score_version: number
  created_at: number
  updated_at: number
  archived_at: number | null
}

export class SavedTriggerNotFoundError extends Error {
  constructor() {
    super('保存済みTriggerが見つかりません。')
    this.name = 'SavedTriggerNotFoundError'
  }
}

function isoDateTime(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(Number(epochSeconds) * 1000).toISOString()
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} is corrupted`)
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new SavedTriggerValidationError('name must be a string')
  const name = value.trim()
  if (!name) throw new SavedTriggerValidationError('name must not be empty')
  if (name.length > SAVED_TRIGGER_NAME_MAX_LENGTH) {
    throw new SavedTriggerValidationError(`name must be ${SAVED_TRIGGER_NAME_MAX_LENGTH} characters or fewer`)
  }
  return name
}

export function validateSavedTriggerId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new SavedTriggerValidationError('id must be a UUID')
}

function evaluationSignature(config: SavedTriggerEvaluationConfig): string {
  const canonicalPayload = JSON.stringify({
    version: SAVED_TRIGGER_EVALUATION_CONFIG_VERSION,
    config,
  })
  return createHash('sha256').update(canonicalPayload).digest('hex')
}

async function allowedMarkets(): Promise<Set<string | null>> {
  const rows = await execAll<{ market: string | null }>(`
    SELECT DISTINCT market_segment AS market
    FROM ticker_universe
    WHERE active=1
  `)
  return new Set(rows.map((row) => row.market?.trim() || null))
}

function rowToDefinition(row: TriggerDefinitionRow): SavedTriggerDefinition {
  return {
    id: row.id,
    name: row.name,
    evaluationConfig: canonicalizeSavedTriggerEvaluationConfig(
      parseJson(row.evaluation_config_json, 'evaluation_config_json'),
      { allowLegacyTimeframe: true },
    ),
    viewConfig: canonicalizeSavedTriggerViewConfig(
      parseJson(row.view_config_json, 'view_config_json'),
    ),
    evaluationVersion: Number(row.evaluation_version),
    engineVersion: Number(row.engine_version),
    scoreVersion: Number(row.score_version),
    evaluationSignature: row.evaluation_signature,
    createdAt: isoDateTime(row.created_at)!,
    updatedAt: isoDateTime(row.updated_at)!,
    archivedAt: isoDateTime(row.archived_at),
  }
}

const SELECT_COLUMNS = `
  id, name, evaluation_config_json, view_config_json, evaluation_signature,
  evaluation_version, engine_version, score_version, created_at, updated_at, archived_at
`

export async function listSavedTriggerDefinitions(): Promise<SavedTriggerDefinition[]> {
  const rows = await execAll<TriggerDefinitionRow>(`
    SELECT ${SELECT_COLUMNS}
    FROM trigger_definitions
    WHERE archived_at IS NULL
    ORDER BY updated_at DESC, name, id
  `)
  return rows.map(rowToDefinition)
}

export async function getSavedTriggerDefinition(id: string): Promise<SavedTriggerDefinition> {
  validateSavedTriggerId(id)
  const row = await execGet<TriggerDefinitionRow>(`
    SELECT ${SELECT_COLUMNS}
    FROM trigger_definitions
    WHERE id=? AND archived_at IS NULL
  `, [id])
  if (!row) throw new SavedTriggerNotFoundError()
  return rowToDefinition(row)
}

export async function getSavedTriggerDefinitionForHistory(id: string): Promise<SavedTriggerDefinition> {
  validateSavedTriggerId(id)
  const row = await execGet<TriggerDefinitionRow>(`
    SELECT ${SELECT_COLUMNS}
    FROM trigger_definitions
    WHERE id=?
  `, [id])
  if (!row) throw new SavedTriggerNotFoundError()
  return rowToDefinition(row)
}

export async function createSavedTriggerDefinition(input: {
  name: unknown
  evaluationConfig: unknown
  viewConfig: unknown
}): Promise<SavedTriggerDefinition> {
  const name = normalizeName(input.name)
  const evaluationConfig = canonicalizeSavedTriggerEvaluationConfig(input.evaluationConfig, {
    allowedMarkets: await allowedMarkets(),
  })
  const viewConfig = canonicalizeSavedTriggerViewConfig(input.viewConfig)
  const signature = evaluationSignature(evaluationConfig)
  const { engineVersion, scoreVersion } = savedTriggerVersions()
  const id = randomUUID()
  await execRun(`
    INSERT INTO trigger_definitions (
      id, name, evaluation_config_json, view_config_json, evaluation_signature,
      evaluation_version, engine_version, score_version, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch(), NULL)
  `, [
    id,
    name,
    JSON.stringify(evaluationConfig),
    JSON.stringify(viewConfig),
    signature,
    engineVersion,
    scoreVersion,
  ])
  return getSavedTriggerDefinition(id)
}

export async function updateSavedTriggerDefinition(id: string, input: {
  name?: unknown
  evaluationConfig?: unknown
  viewConfig?: unknown
}): Promise<SavedTriggerDefinition> {
  const existing = await getSavedTriggerDefinition(id)
  const name = input.name === undefined ? existing.name : normalizeName(input.name)
  const evaluationConfig = input.evaluationConfig === undefined
    ? existing.evaluationConfig
    : canonicalizeSavedTriggerEvaluationConfig(input.evaluationConfig, {
        allowedMarkets: await allowedMarkets(),
      })
  const viewConfig = input.viewConfig === undefined
    ? existing.viewConfig
    : canonicalizeSavedTriggerViewConfig(input.viewConfig)
  const signature = evaluationSignature(evaluationConfig)
  // Legacy Monthly definitions may have no timeframe (or the former lowercase
  // value) in their stored JSON/signature. Compare canonical meaning first so a
  // name/view-only update cannot create a phantom evaluation version.
  const evaluationChanged = JSON.stringify(evaluationConfig) !== JSON.stringify(existing.evaluationConfig)
  const currentVersions = savedTriggerVersions()
  const engineVersion = evaluationChanged ? currentVersions.engineVersion : existing.engineVersion
  const scoreVersion = evaluationChanged ? currentVersions.scoreVersion : existing.scoreVersion
  if (evaluationChanged) {
    await execRun(`
      UPDATE trigger_definitions SET
        name=?, evaluation_config_json=?, view_config_json=?,
        evaluation_version=evaluation_version + 1, evaluation_signature=?,
        engine_version=?, score_version=?, updated_at=unixepoch()
      WHERE id=? AND archived_at IS NULL
    `, [
      name, JSON.stringify(evaluationConfig), JSON.stringify(viewConfig), signature,
      engineVersion, scoreVersion, id,
    ])
  } else {
    // Preserve the legacy JSON and signature byte-for-byte when its semantics
    // are unchanged. Read paths still expose canonical MONTHLY to callers.
    await execRun(`
      UPDATE trigger_definitions SET name=?, view_config_json=?, updated_at=unixepoch()
      WHERE id=? AND archived_at IS NULL
    `, [name, JSON.stringify(viewConfig), id])
  }
  return getSavedTriggerDefinition(id)
}

export async function archiveSavedTriggerDefinition(id: string): Promise<void> {
  await getSavedTriggerDefinition(id)
  await execRun(`
    UPDATE trigger_definitions
    SET archived_at=unixepoch(), updated_at=unixepoch()
    WHERE id=? AND archived_at IS NULL
  `, [id])
}

export const savedTriggerDefinitionContractVersion = SAVED_TRIGGER_CONTRACT_VERSION
