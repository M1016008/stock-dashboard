import path from 'node:path'

export type IsolatedRuntimeKind = 'development' | 'test' | 'build'

export const SCRUBBED_RUNTIME_CREDENTIALS = [
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'JQUANTS_API_KEY',
  'EDINET_API_KEY',
  'FINNHUB_API_KEY',
  'TIINGO_API_KEY',
  'SEC_USER_AGENT',
  'OPENAI_API_KEY',
  'TRIGGER_GMAIL_OAUTH_CLIENT_ID',
  'TRIGGER_GMAIL_OAUTH_CLIENT_SECRET',
  'LARGE_HOLDER_ADMIN_TOKEN',
  'STOCKBOARD_SHARE_BASIC_USER',
  'STOCKBOARD_SHARE_BASIC_PASSWORD',
] as const

const ISOLATED_DB_PATHS = {
  STOCKBOARD_DB_PATH: ['data', 'stockboard.db'],
  LOCAL_DB_PATH: ['data', 'stockboard.db'],
  US_ANALYTICS_DB_PATH: ['data', 'stockboard-us.db'],
  ANALOG_JP_DB_PATH: ['data', 'analog-jp.db'],
  ANALOG_US_DB_PATH: ['data', 'analog-us.db'],
  SERVING_CACHE_DB_PATH: ['data', 'serving-cache.db'],
  MA_TRAJECTORY_SHADOW_DB_PATH: ['data', 'ma-trajectory-shadow.db'],
  MA_TRAJECTORY_SHADOW_DB_PATH_JP: ['data', 'ma-trajectory-shadow-jp.db'],
  STOCKBOARD_SOURCE_DB_PATH: ['fixtures', 'source.db'],
  READONLY_SQLITE_DB_PATH: ['fixtures', 'readonly.db'],
  PHASE16D_SOURCE_FIXTURE_DB: ['fixtures', 'phase16d-source.db'],
} as const

const ISOLATED_DATA_DIRS = {
  STOCKBOARD_HISTORICAL_SCAN_DIR: ['artifacts', 'historical-scans'],
  STOCKBOARD_OUTCOME_ANALYSIS_DIR: ['artifacts', 'outcome-analysis'],
} as const

function resolvedIsolationRoot(root: string): string {
  const resolved = path.resolve(root)
  if (!path.isAbsolute(root) || resolved === path.parse(resolved).root || resolved.startsWith('/Volumes/')) {
    throw new Error('Isolated runtime root must be an absolute local directory below the filesystem root')
  }
  return resolved
}

function expectedEnvironment(kind: IsolatedRuntimeKind, root: string): Record<string, string> {
  const expected: Record<string, string> = {
    NODE_ENV: kind === 'build' ? 'production' : kind,
    STOCKBOARD_RUNTIME_SCOPE: kind,
    STOCKBOARD_ISOLATION_ROOT: root,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_ROLE: '',
    EXTERNAL_STORAGE_REQUIRED: kind === 'build' ? 'true' : 'false',
    STOCK_DATA_MOUNT_PATH: '',
    STOCK_DATA_VOLUME_UUID: '',
    STOCK_DATA_INCIDENT_DIR: path.join(root, 'storage-incidents'),
    STOCKBOARD_DB_OPEN_FORBIDDEN: kind === 'build' ? '1' : '0',
    OPENAI_ASSISTANT_ENABLED: '0',
    STOCKBOARD_SHARE_MODE: '0',
    STOCKBOARD_SHARE_ALLOW_ADMIN: '0',
  }

  for (const [name, segments] of Object.entries(ISOLATED_DB_PATHS)) {
    expected[name] = path.join(root, ...segments)
  }
  for (const [name, segments] of Object.entries(ISOLATED_DATA_DIRS)) {
    expected[name] = path.join(root, ...segments)
  }
  for (const name of SCRUBBED_RUNTIME_CREDENTIALS) expected[name] = ''
  return expected
}

export function createIsolatedRuntimeEnvironment(
  kind: IsolatedRuntimeKind,
  root: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolvedRoot = resolvedIsolationRoot(root)
  return { ...inherited, ...expectedEnvironment(kind, resolvedRoot) }
}

export function assertIsolatedRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): IsolatedRuntimeKind {
  const kind = environment.STOCKBOARD_RUNTIME_SCOPE as IsolatedRuntimeKind | undefined
  if (kind !== 'development' && kind !== 'test' && kind !== 'build') {
    throw new Error('Database isolation requires STOCKBOARD_RUNTIME_SCOPE=development, test, or build')
  }

  const root = resolvedIsolationRoot(environment.STOCKBOARD_ISOLATION_ROOT?.trim() ?? '')
  const expected = expectedEnvironment(kind, root)
  for (const [name, value] of Object.entries(expected)) {
    if ((environment[name] ?? '') !== value) {
      throw new Error(`Unsafe isolated runtime environment: ${name} must be pinned by the isolation launcher`)
    }
  }
  return kind
}

export function assertDatabaseOpenAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.STOCKBOARD_RUNTIME_SCOPE) assertIsolatedRuntimeEnvironment(environment)
  if (environment.STOCKBOARD_DB_OPEN_FORBIDDEN === '1') {
    throw new Error('Database opens are forbidden in the isolated build environment')
  }
}

export function nonProductionIncidentDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  const scope = environment.STOCKBOARD_RUNTIME_SCOPE
  const isolatedBuild = scope === 'build' && environment.STOCKBOARD_DB_OPEN_FORBIDDEN === '1'
  const nonProduction = scope === 'development'
    || scope === 'test'
    || environment.NODE_ENV === 'development'
    || environment.NODE_ENV === 'test'
  if (!nonProduction && !isolatedBuild) return null

  const configuredRoot = environment.STOCKBOARD_ISOLATION_ROOT?.trim()
  if (configuredRoot) {
    try {
      return path.join(resolvedIsolationRoot(configuredRoot), 'storage-incidents')
    } catch {
      // Invalid isolation configuration must not fall back to shared Production state.
    }
  }
  const label = scope === 'test' || scope === 'build' ? scope : 'development'
  return path.join(path.resolve(cwd), '.stockboard-runtime', label, 'storage-incidents')
}
