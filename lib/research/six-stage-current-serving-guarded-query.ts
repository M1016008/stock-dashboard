import type { Client, InValue } from '@libsql/client'
import path from 'node:path'
import { sqlStatementMayMutate } from '@/lib/db/sql-mutation'
import type { CurrentServingQuery } from '@/lib/research/six-stage-current-serving-adapter'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import { requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'
import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'

export type CurrentServingProjectionReaders = {
  lockQuery: CurrentServingQuery
  sourceQuery: CurrentServingQuery
  paths: { jp: string; source: string }
  close: () => void
}

type ProjectionEnvironment = Readonly<Record<string, string | undefined>>

function requiredPath(environment: ProjectionEnvironment, names: string[]): string {
  for (const name of names) {
    const configured = environment[name]?.trim()
    if (configured) return resolveConfiguredStoragePath(path.resolve(configured))
  }
  throw new Error(`CURRENT_PROJECTION_REQUIRED_DB_PATH:${names.join('|')}`)
}

export function resolveCurrentServingProjectionDatabasePaths(
  selectedMarket: 'JP' | 'US',
  environment: ProjectionEnvironment = process.env,
): { jp: string; source: string } {
  const jp = requiredPath(environment, ['STOCKBOARD_DB_PATH'])
  const sourceOverride = environment.STOCKBOARD_SOURCE_DB_PATH?.trim()
  if (sourceOverride && resolveConfiguredStoragePath(path.resolve(sourceOverride)) !== jp) {
    throw new Error('CURRENT_PROJECTION_PRIMARY_DATABASE_PATH_CONFLICT')
  }
  const source = selectedMarket === 'JP'
    ? jp
    : requiredPath(environment, ['US_ANALYTICS_DB_PATH'])
  if (selectedMarket === 'US' && source === jp) {
    throw new Error('CURRENT_PROJECTION_MARKET_DATABASES_NOT_ISOLATED')
  }
  return { jp, source }
}

function queryOnlyValue(row: Record<string, unknown> | undefined): number {
  if (!row) return 0
  const value = row.query_only ?? row['query_only'] ?? Object.values(row)[0]
  return Number(value)
}

export async function enforceCurrentServingQueryOnly(client: Client): Promise<void> {
  await client.execute('PRAGMA query_only=ON')
  const result = await client.execute('PRAGMA query_only')
  if (queryOnlyValue(result.rows[0] as Record<string, unknown> | undefined) !== 1) {
    throw new Error('CURRENT_PROJECTION_QUERY_ONLY_NOT_ENFORCED')
  }
}

export function currentServingQueryOnlyQuery(client: Client): CurrentServingQuery {
  return async <T extends Record<string, unknown>>(
    sql: string,
    args: readonly (string | number | null)[] = [],
  ): Promise<T[]> => {
    if (sqlStatementMayMutate(sql)) throw new Error('CURRENT_PROJECTION_MUTATING_SQL_REJECTED')
    const result = await client.execute({ sql, args: [...args] as InValue[] })
    return result.rows.map((row) => ({ ...row }) as unknown as T)
  }
}

async function openGuardedQueryOnlyClient(dbPath: string, jobType: string): Promise<Client> {
  if (!requiresExternalStorageGuard(dbPath)) {
    throw new Error('CURRENT_PROJECTION_EXTERNAL_STORAGE_GUARD_REQUIRED')
  }
  const client = openExistingGuardedClient(dbPath, jobType)
  try {
    await enforceCurrentServingQueryOnly(client)
    return client
  } catch (error) {
    client.close()
    throw error
  }
}

export async function openCurrentServingProjectionReaders(
  selectedMarket: 'JP' | 'US',
  environment: ProjectionEnvironment = process.env,
): Promise<CurrentServingProjectionReaders> {
  const paths = resolveCurrentServingProjectionDatabasePaths(selectedMarket, environment)
  const jpClient = await openGuardedQueryOnlyClient(
    paths.jp,
    'six-stage-current-serving-projection-jp-read',
  )
  let sourceClient = jpClient
  try {
    if (selectedMarket === 'US') {
      sourceClient = await openGuardedQueryOnlyClient(
        paths.source,
        'six-stage-current-serving-projection-us-read',
      )
    }
    return {
      lockQuery: currentServingQueryOnlyQuery(jpClient),
      sourceQuery: currentServingQueryOnlyQuery(sourceClient),
      paths,
      close: () => {
        if (sourceClient !== jpClient) sourceClient.close()
        jpClient.close()
      },
    }
  } catch (error) {
    if (sourceClient !== jpClient) sourceClient.close()
    jpClient.close()
    throw error
  }
}
