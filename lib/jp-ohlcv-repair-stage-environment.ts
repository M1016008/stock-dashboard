import path from 'node:path'

// Stage children resolve every database from these variables. The JP and
// serving-cache/analog paths are pinned; the legacy JP alias, the US analytics
// and analog paths, and the MA trajectory shadow paths are removed so nothing
// inherited from the caller can point a stage at another database. Basenames
// are the production ones.
export const JP_REPAIR_SERVING_CACHE_BASENAME = 'stockboard-serving-cache.db'
export const JP_REPAIR_ANALOG_BASENAME = 'analog-jp.db'
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
}): NodeJS.ProcessEnv {
  if (path.basename(paths.servingCache) !== JP_REPAIR_SERVING_CACHE_BASENAME
      || path.basename(paths.analog) !== JP_REPAIR_ANALOG_BASENAME
      || ![paths.database, paths.servingCache, paths.analog].every((file) => path.isAbsolute(file))) {
    throw new Error('stage database paths must be absolute and use the production basenames')
  }
  const environment: NodeJS.ProcessEnv = {
    ...base,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: paths.database,
    SERVING_CACHE_DB_PATH: paths.servingCache,
    ANALOG_JP_DB_PATH: paths.analog,
  }
  for (const name of JP_REPAIR_STAGE_UNSET_ENVIRONMENT) delete environment[name]
  return environment
}
