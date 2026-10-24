import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OWC_DEVELOPMENT_ROOT, assertOwcDevelopmentVolume } from '../../lib/runtime/isolation'

export { OWC_DEVELOPMENT_ROOT }
const SYSTEM_TEMP_ROOT = fs.realpathSync(os.tmpdir())

/**
 * Isolation envelope for synthetic-only harnesses (benchmarks, equivalence
 * checks, browser QA fixtures).
 *
 * Contract:
 *  - every database, cache, incident and artifact path lives in a fresh
 *    directory under the internal-volume temp root, never under /Volumes;
 *  - production storage identity (mount path / volume UUID), cloud database
 *    credentials and every paid / third-party API key are removed from the
 *    process (or child) environment before application modules are loaded;
 *  - NODE_ENV is never `production`, so the external-storage guard cannot be
 *    engaged against real hardware and no shared FAILED_SAFE latch can be
 *    written.
 *
 * `.env.local` is never read by anything in this module.
 */

/** Variables that carry production identity or credentials for external services. */
export const FORBIDDEN_ENVIRONMENT_VARIABLES: readonly string[] = [
  'STOCK_DATA_MOUNT_PATH',
  'STOCK_DATA_VOLUME_UUID',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'JQUANTS_API_KEY',
  'TIINGO_API_KEY',
  'FINNHUB_API_KEY',
  'EDINET_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'LARGE_HOLDER_ADMIN_TOKEN',
  'ANALOG_SEARCH_PROXY_URL',
  'STOCKBOARD_SHARE_MODE',
  'STOCKBOARD_SHARE_BASIC_USER',
  'STOCKBOARD_SHARE_BASIC_PASSWORD',
]

/** Variables that must resolve inside the synthetic runtime directory when present. */
export const PATH_ENVIRONMENT_VARIABLES: readonly string[] = [
  'STOCKBOARD_DB_PATH',
  'LOCAL_DB_PATH',
  'US_ANALYTICS_DB_PATH',
  'SERVING_CACHE_DB_PATH',
  'STOCK_DATA_INCIDENT_DIR',
  'ANALOG_JP_DB_PATH',
  'ANALOG_US_DB_PATH',
  'MA_TRAJECTORY_SHADOW_DB_PATH',
  'MA_TRAJECTORY_ARTIFACT_DIR',
  'STOCKBOARD_PATH_RESEARCH_DIR',
  'STOCKBOARD_OUTCOME_ANALYSIS_DIR',
  'STOCKBOARD_ML_DATASET_DIR',
  'STOCKBOARD_HISTORICAL_SCAN_DIR',
  'LARGE_HOLDER_RANKING_CURRENT_PATH',
  'LARGE_HOLDER_RANKING_SNAPSHOT_PATH',
  'LARGE_HOLDER_REVIEW_LEDGER_PATH',
  'LARGE_HOLDER_OPERATIONS_DIR',
  'LARGE_HOLDER_EVIDENCE_DIR',
]

/** Variables a child process may inherit from the parent shell. */
const CHILD_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'CHROME_PATH', 'SCREENSHOT_DIR',
]

export interface SyntheticRuntime {
  /** Realpath of the fresh runtime directory under the internal temp root. */
  readonly root: string
  readonly dbPath: string
  readonly servingCachePath: string
  readonly usAnalyticsDbPath: string
  readonly incidentDir: string
  /** Environment overrides that bind every path variable to `root`. */
  readonly env: Readonly<Record<string, string>>
  cleanup(): void
}

export function internalTempRoot(): string {
  return SYSTEM_TEMP_ROOT
}

/**
 * Internal-volume scratch roots. `/tmp` is accepted because several existing
 * fixtures hard-code it; it resolves to /private/tmp on the system volume.
 */
export function internalScratchRoots(): string[] {
  const roots = new Set<string>([internalTempRoot()])
  try { roots.add(fs.realpathSync('/tmp')) } catch { /* /tmp is absent on this host */ }
  return [...roots]
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve through the deepest existing ancestor so symlinked temp roots compare correctly. */
function resolveThroughExistingAncestor(candidate: string): string {
  const absolute = path.resolve(candidate)
  const missing: string[] = []
  let current = absolute
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missing.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

export function isSyntheticPath(
  candidate: string,
  roots: string | readonly string[] = internalScratchRoots(),
): boolean {
  const resolved = resolveThroughExistingAncestor(candidate)
  if ((resolved === '/Volumes' || resolved.startsWith('/Volumes/'))
    && resolved !== OWC_DEVELOPMENT_ROOT
    && !isInside(OWC_DEVELOPMENT_ROOT, resolved)) return false
  const allowed = typeof roots === 'string' ? [roots] : roots
  return allowed.some((root) => resolved === root || isInside(root, resolved))
}

export function createSyntheticRuntime(label: string): SyntheticRuntime {
  const tempRoot = internalTempRoot()
  if (tempRoot === '/Volumes' || tempRoot.startsWith('/Volumes/')) {
    throw new Error(`Refusing synthetic runtime: temp root ${tempRoot} is on an external volume`)
  }
  return createRuntimeUnder(tempRoot, label)
}

/** Persistent/heavy benchmark workers may use only the dedicated OWC development tree. */
export function createOwcDevelopmentRuntime(label: string, parent: string): SyntheticRuntime {
  assertOwcDevelopmentVolume()
  const resolvedParent = resolveThroughExistingAncestor(parent)
  if (!isInside(OWC_DEVELOPMENT_ROOT, resolvedParent)) {
    throw new Error(`Refusing OWC benchmark runtime outside ${OWC_DEVELOPMENT_ROOT}`)
  }
  fs.mkdirSync(resolvedParent, { recursive: true })
  return createRuntimeUnder(resolvedParent, label)
}

function createRuntimeUnder(parent: string, label: string): SyntheticRuntime {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48) || 'synthetic'
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `stockboard-${safeLabel}-`)))
  const incidentDir = path.join(root, 'incidents')
  const tempDir = path.join(root, 'tmp')
  fs.mkdirSync(incidentDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  const dbPath = path.join(root, 'stockboard.db')
  const servingCachePath = path.join(root, 'serving-cache.db')
  const usAnalyticsDbPath = path.join(root, 'stockboard-us.db')
  const env: Record<string, string> = {
    EXTERNAL_STORAGE_REQUIRED: 'false',
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: dbPath,
    SERVING_CACHE_DB_PATH: servingCachePath,
    US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
    STOCK_DATA_INCIDENT_DIR: incidentDir,
    ANALOG_JP_DB_PATH: path.join(root, 'analog-jp.db'),
    ANALOG_US_DB_PATH: path.join(root, 'analog-us.db'),
    MA_TRAJECTORY_SHADOW_DB_PATH: path.join(root, 'ma-trajectory-shadow.db'),
    MA_TRAJECTORY_ARTIFACT_DIR: path.join(root, 'ma-trajectory'),
    STOCKBOARD_PATH_RESEARCH_DIR: path.join(root, 'path-research'),
    STOCKBOARD_OUTCOME_ANALYSIS_DIR: path.join(root, 'outcome-analysis'),
    STOCKBOARD_ML_DATASET_DIR: path.join(root, 'ml-datasets'),
    STOCKBOARD_HISTORICAL_SCAN_DIR: path.join(root, 'historical-scan'),
    LARGE_HOLDER_RANKING_CURRENT_PATH: path.join(root, 'large-holder-current.json'),
    LARGE_HOLDER_RANKING_SNAPSHOT_PATH: path.join(root, 'large-holder-snapshot.json'),
    LARGE_HOLDER_REVIEW_LEDGER_PATH: path.join(root, 'large-holder-review.ndjson'),
    LARGE_HOLDER_OPERATIONS_DIR: path.join(root, 'large-holder-operations'),
    LARGE_HOLDER_EVIDENCE_DIR: path.join(root, 'large-holder-evidence'),
    STOCKBOARD_DB_READ_CONCURRENCY: '0',
    // The driver exposes this OWC path to legacy workers through a short
    // temporary symlink, so SQLite spills stay off the internal SSD too.
    TMPDIR: tempDir,
  }
  return {
    root, dbPath, servingCachePath, usAnalyticsDbPath, incidentDir, env,
    cleanup() {
      if (!isInside(parent, root)) throw new Error(`Refusing to remove ${root}: outside ${parent}`)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export interface IsolationViolation {
  readonly variable: string
  readonly reason: string
}

export function findIsolationViolations(
  env: NodeJS.ProcessEnv = process.env,
  roots: string | readonly string[] = internalScratchRoots(),
): IsolationViolation[] {
  const violations: IsolationViolation[] = []
  if (env.NODE_ENV === 'production') {
    violations.push({ variable: 'NODE_ENV', reason: 'production would engage the external-storage guard' })
  }
  if (env.EXTERNAL_STORAGE_REQUIRED === 'true') {
    violations.push({ variable: 'EXTERNAL_STORAGE_REQUIRED', reason: 'must not require external storage in a synthetic run' })
  }
  for (const name of FORBIDDEN_ENVIRONMENT_VARIABLES) {
    if (env[name] !== undefined && env[name] !== '') {
      violations.push({ variable: name, reason: 'production identity or credential is present' })
    }
  }
  for (const name of PATH_ENVIRONMENT_VARIABLES) {
    const value = env[name]
    if (value === undefined || value === '') continue
    if (!isSyntheticPath(value, roots)) {
      violations.push({ variable: name, reason: 'path is outside the internal scratch roots' })
    }
  }
  return violations
}

/** Throws (listing variable names only, never values) unless the environment is synthetic-only. */
export function assertSyntheticEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  roots: string | readonly string[] = internalScratchRoots(),
): void {
  const violations = findIsolationViolations(env, roots)
  if (violations.length === 0) return
  const detail = violations.map((violation) => `${violation.variable}: ${violation.reason}`).join('; ')
  throw new Error(`Synthetic isolation violated — ${detail}`)
}

/**
 * Scrub forbidden variables from this process, bind every path variable to the
 * runtime, and verify. Must run before application modules are imported.
 */
export function applySyntheticEnvironment(
  runtime: SyntheticRuntime,
  overrides: Readonly<Record<string, string>> = {},
): void {
  for (const name of FORBIDDEN_ENVIRONMENT_VARIABLES) delete process.env[name]
  delete process.env.STOCKBOARD_DB_ROLE
  delete process.env.LOCAL_DB_PATH
  Object.assign(process.env, { NODE_ENV: 'test' }, runtime.env, overrides)
  assertSyntheticEnvironment(process.env, runtime.root)
}

/** Environment for a child process (tsx, next dev, headless browser driver). Allowlist based. */
export function syntheticChildEnv(
  runtime: SyntheticRuntime,
  overrides: Readonly<Record<string, string>> = {},
  nodeEnv: 'test' | 'development' = 'development',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv }
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, { NODE_ENV: nodeEnv }, runtime.env, overrides)
  assertSyntheticEnvironment(env, runtime.root)
  return env
}
