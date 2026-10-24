import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type IsolatedRuntimeKind = 'development' | 'test' | 'build' | 'preview'

export const OWC_DEVELOPMENT_MOUNT = '/Volumes/OWC Express 1M2 80G'
export const OWC_DEVELOPMENT_ROOT = `${OWC_DEVELOPMENT_MOUNT}/development`
export const OWC_DEVELOPMENT_VOLUME_UUID = '11FDA3F5-D89E-414D-9B95-C2069FF0B204'

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

const PASSTHROUGH_RUNTIME_ENVIRONMENT = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'NEXT_TELEMETRY_DISABLED',
] as const

type VerifiedOwcMount = {
  realPath: string
  device: number
  birthtimeMs: number
}

let verifiedOwcMount: VerifiedOwcMount | null = null

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

export function resolveThroughExistingAncestor(root: string): string {
  const missing: string[] = []
  let current = path.resolve(root)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missing.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

export function assertOwcDevelopmentVolume(): void {
  if (!fs.existsSync(OWC_DEVELOPMENT_MOUNT)) throw new Error('OWC development volume is not mounted')
  const mount = fs.realpathSync(OWC_DEVELOPMENT_MOUNT)
  const mountStat = fs.statSync(mount)
  if (mount !== OWC_DEVELOPMENT_MOUNT || mountStat.dev === fs.statSync('/').dev) {
    throw new Error('OWC development mount is not a distinct external filesystem')
  }
  if (verifiedOwcMount
    && verifiedOwcMount.realPath === mount
    && verifiedOwcMount.device === mountStat.dev
    && verifiedOwcMount.birthtimeMs === mountStat.birthtimeMs) return
  const plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', mount], { timeout: 8_000 })
  const uuid = execFileSync('/usr/bin/plutil', ['-extract', 'VolumeUUID', 'raw', '-o', '-', '-'], {
    input: plist, encoding: 'utf8', timeout: 8_000,
  }).trim()
  if (uuid !== OWC_DEVELOPMENT_VOLUME_UUID) throw new Error('OWC development volume UUID mismatch')
  verifiedOwcMount = { realPath: mount, device: mountStat.dev, birthtimeMs: mountStat.birthtimeMs }
}

function copyBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
): void {
  const distDir = inherited.NEXT_DIST_DIR?.trim()
  if (distDir) {
    if (!/^\.next[A-Za-z0-9._-]*$/.test(distDir)) {
      throw new Error('NEXT_DIST_DIR must be a .next-prefixed directory name inside the current worktree')
    }
    const candidate = path.resolve(process.cwd(), distDir)
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error('NEXT_DIST_DIR must not be a symbolic link')
    }
    environment.NEXT_DIST_DIR = distDir
  }
  const buildCpus = inherited.STOCKBOARD_BUILD_CPUS?.trim()
  if (buildCpus) {
    const parsed = Number(buildCpus)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
      throw new Error('STOCKBOARD_BUILD_CPUS must be an integer from 1 to 32')
    }
    environment.STOCKBOARD_BUILD_CPUS = String(parsed)
  }
}

function resolvedIsolationRoot(root: string): string {
  const resolved = resolveThroughExistingAncestor(root)
  const relativeToOwcDevelopment = path.relative(OWC_DEVELOPMENT_ROOT, resolved)
  const isOwcDevelopmentChild = relativeToOwcDevelopment !== ''
    && relativeToOwcDevelopment !== '..'
    && !relativeToOwcDevelopment.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToOwcDevelopment)
  if (isOwcDevelopmentChild) assertOwcDevelopmentVolume()
  if (!path.isAbsolute(root)
    || resolved === path.parse(resolved).root
    || (resolved.startsWith('/Volumes/') && !isOwcDevelopmentChild)) {
    throw new Error('Isolated runtime root must be an absolute local directory below the filesystem root')
  }
  return resolved
}

function expectedEnvironment(kind: IsolatedRuntimeKind, root: string): Record<string, string> {
  const expected: Record<string, string> = {
    NODE_ENV: kind === 'build' || kind === 'preview' ? 'production' : kind,
    STOCKBOARD_RUNTIME_SCOPE: kind,
    STOCKBOARD_ISOLATION_ROOT: root,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_ROLE: '',
    EXTERNAL_STORAGE_REQUIRED: kind === 'build' ? 'true' : 'false',
    STOCK_DATA_MOUNT_PATH: '',
    STOCK_DATA_VOLUME_UUID: '',
    STOCK_DATA_INCIDENT_DIR: path.join(root, 'storage-incidents'),
    STOCKBOARD_DB_OPEN_FORBIDDEN: kind === 'build' ? '1' : '0',
    NEXT_TELEMETRY_DISABLED: '1',
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
  const environment: NodeJS.ProcessEnv = { NODE_ENV: kind === 'build' || kind === 'preview' ? 'production' : kind }
  for (const name of PASSTHROUGH_RUNTIME_ENVIRONMENT) {
    if (inherited[name] !== undefined) environment[name] = inherited[name]
  }
  if (kind === 'build' || kind === 'development' || kind === 'preview') copyBuildEnvironment(environment, inherited)
  environment.HOME = path.join(resolvedRoot, 'home')
  environment.TMPDIR = path.join(resolvedRoot, 'tmp')
  environment.XDG_CACHE_HOME = path.join(resolvedRoot, 'cache')
  return { ...environment, ...expectedEnvironment(kind, resolvedRoot) }
}

export function assertIsolatedRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): IsolatedRuntimeKind {
  const kind = environment.STOCKBOARD_RUNTIME_SCOPE as IsolatedRuntimeKind | undefined
  if (kind !== 'development' && kind !== 'test' && kind !== 'build' && kind !== 'preview') {
    throw new Error('Database isolation requires STOCKBOARD_RUNTIME_SCOPE=development, test, build, or preview')
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
    || scope === 'preview'
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
