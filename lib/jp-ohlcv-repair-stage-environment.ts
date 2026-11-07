import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'

// Stage children resolve every database from these variables. The JP and
// serving-cache/analog paths are pinned; the legacy JP alias, the US analytics
// and analog paths, and the MA trajectory shadow paths are removed so nothing
// inherited from the caller can point a stage at another database. Basenames
// are the production ones.
export const JP_REPAIR_MAIN_BASENAME = 'stockboard.db'
export const JP_REPAIR_SERVING_CACHE_BASENAME = 'stockboard-serving-cache.db'
// The one-time repair targets the JP analog index the deployed reader opens:
// analog-sequence-jp-v2.db at meta version 2. The repository-wide
// MA_SEQUENCE_VERSION is 3 and is not changed; the repair never publishes v3.
export const JP_REPAIR_ANALOG_CONTRACT = { basename: 'analog-sequence-jp-v2.db', metaVersion: 2 } as const
export const JP_REPAIR_ANALOG_BASENAME = JP_REPAIR_ANALOG_CONTRACT.basename
export const JP_REPAIR_STAGE_UNSET_ENVIRONMENT = [
  'LOCAL_DB_PATH',
  'US_ANALYTICS_DB_PATH',
  'ANALOG_US_DB_PATH',
  'MA_TRAJECTORY_SHADOW_DB_PATH',
  'MA_TRAJECTORY_SHADOW_DB_PATH_JP',
  'STOCKBOARD_SOURCE_DB_PATH',
  'READONLY_SQLITE_DB_PATH',
  'PHASE16D_SOURCE_FIXTURE_DB',
  'STOCKBOARD_DB_ROLE',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
] as const

export function jpRepairStageEnvironment(base: NodeJS.ProcessEnv, paths: {
  database: string
  servingCache: string
  analog: string
  analogMetaVersion: number
}): NodeJS.ProcessEnv {
  if (path.basename(paths.servingCache) !== JP_REPAIR_SERVING_CACHE_BASENAME
      || path.basename(paths.analog) !== JP_REPAIR_ANALOG_CONTRACT.basename
      || paths.analogMetaVersion !== JP_REPAIR_ANALOG_CONTRACT.metaVersion
      || ![paths.database, paths.servingCache, paths.analog].every((file) => path.isAbsolute(file))) {
    throw new Error('stage database paths must be absolute and use the production basenames and the approved analog meta version')
  }
  const environment: NodeJS.ProcessEnv = {
    ...base,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: paths.database,
    SERVING_CACHE_DB_PATH: paths.servingCache,
    ANALOG_JP_DB_PATH: paths.analog,
    JP_REPAIR_ANALOG_META_VERSION: String(paths.analogMetaVersion),
  }
  for (const name of JP_REPAIR_STAGE_UNSET_ENVIRONMENT) delete environment[name]
  return environment
}

// Opens the analog index read-only and returns its completed meta version.
// Throws unless it is the approved contract version, so a v3 build (or any
// other version) can never be accepted into the v2 analog file.
export function assertJpRepairAnalogMeta(analogPath: string): { version: number; sourceDate: string | null } {
  const db = new DatabaseSync(analogPath, { readOnly: true })
  try {
    const meta = new Map((db.prepare("SELECT key, value FROM analog_sequence_meta WHERE key IN ('version','completed','source_date')")
      .all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
    const version = Number(meta.get('version'))
    if (version !== JP_REPAIR_ANALOG_CONTRACT.metaVersion || meta.get('completed') !== '1') {
      throw new Error(`analog meta must be completed version ${JP_REPAIR_ANALOG_CONTRACT.metaVersion}; found version ${meta.get('version') ?? 'none'} completed ${meta.get('completed') ?? 'none'}`)
    }
    return { version, sourceDate: meta.get('source_date') ?? null }
  } finally {
    db.close()
  }
}
