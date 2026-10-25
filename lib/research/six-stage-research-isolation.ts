const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])
const RESEARCH_SCOPES = new Set(['development', 'test'])
const ISOLATED_DB_PATHS = [
  'STOCKBOARD_DB_PATH',
  'LOCAL_DB_PATH',
  'US_ANALYTICS_DB_PATH',
  'ANALOG_JP_DB_PATH',
  'ANALOG_US_DB_PATH',
  'SERVING_CACHE_DB_PATH',
] as const

export type SixStageResearchMode = 'real' | 'fixture'

function hasPinnedIsolatedRuntime(environment: NodeJS.ProcessEnv): boolean {
  const scope = environment.STOCKBOARD_RUNTIME_SCOPE?.trim()
  const root = environment.STOCKBOARD_ISOLATION_ROOT?.trim().replace(/\/$/, '')
  if (!scope || !RESEARCH_SCOPES.has(scope)) return false
  if (environment.NODE_ENV !== scope) return false
  if (environment.STOCKBOARD_ISOLATION_ATTESTED !== '1') return false
  if (!root || root === '/' || !root.startsWith('/')) return false
  if (environment.USE_LOCAL_DB !== '1' || environment.STOCKBOARD_DB_OPEN_FORBIDDEN !== '0') return false
  if (environment.STOCKBOARD_SHARE_MODE !== '0') return false
  if ((environment.STOCK_DATA_MOUNT_PATH ?? '') !== '' || (environment.STOCK_DATA_VOLUME_UUID ?? '') !== '') return false
  if ((environment.TURSO_DATABASE_URL ?? '') !== '' || (environment.TURSO_AUTH_TOKEN ?? '') !== '') return false
  if (environment.STOCK_DATA_INCIDENT_DIR !== `${root}/storage-incidents`) return false
  return ISOLATED_DB_PATHS.every((name) => environment[name]?.startsWith(`${root}/`))
}

function hostWithoutPort(value: string): string {
  const normalized = value.trim().replace(/^"|"$/g, '').toLowerCase()
  if (normalized.startsWith('[')) {
    const bracket = normalized.indexOf(']')
    return bracket > 0 ? normalized.slice(1, bracket) : normalized
  }
  const colon = normalized.indexOf(':')
  return colon >= 0 && colon === normalized.lastIndexOf(':')
    ? normalized.slice(0, colon)
    : normalized
}

function forwardedHosts(value: string | null): string[] {
  if (!value) return []
  return value.split(',')
    .map(hostWithoutPort)
    .filter((host): host is string => Boolean(host))
}

function containsOnlyLoopback(value: string | null): boolean {
  return forwardedHosts(value).every((host) => LOOPBACK_HOSTS.has(host))
}

export function isSixStageResearchRequestAllowed(args: {
  mode: SixStageResearchMode
  hostname: string
  headers: Headers
  environment?: NodeJS.ProcessEnv
}): boolean {
  const environment = args.environment ?? process.env
  const hostname = args.hostname.toLowerCase()
  const scope = environment.STOCKBOARD_RUNTIME_SCOPE?.trim()

  if (environment.NODE_ENV === 'production') return false
  if (!scope || !RESEARCH_SCOPES.has(scope)) return false
  if (!hasPinnedIsolatedRuntime(environment)) return false
  if (!LOOPBACK_HOSTS.has(hostname)) return false
  if (args.headers.has('cf-connecting-ip') || args.headers.has('cf-ray')) return false
  if (args.headers.has('forwarded')) return false
  if (!containsOnlyLoopback(args.headers.get('x-forwarded-for'))) return false

  const forwarded = forwardedHosts(args.headers.get('x-forwarded-host'))
  if (forwarded.some((host) => !LOOPBACK_HOSTS.has(host))) return false
  const realIp = args.headers.get('x-real-ip') ? hostWithoutPort(args.headers.get('x-real-ip')!) : null
  if (realIp && !LOOPBACK_HOSTS.has(realIp)) return false

  if (args.mode === 'real') return environment.SIX_STAGE_REAL_RESEARCH_ONLY === '1'
  return environment.STOCKBOARD_FIXTURE_ONLY === '1'
    || environment.SIX_STAGE_REAL_RESEARCH_ONLY === '1'
}

export function isSixStageResearchPath(pathname: string): boolean {
  return pathname === '/dev/six-stage-event-paths'
    || pathname === '/dev/six-stage-event-matching'
    || pathname === '/api/research/six-stage/event-paths'
    || pathname === '/api/research/six-stage/current-projection'
}

export function requiredSixStageResearchMode(pathname: string): SixStageResearchMode {
  return pathname === '/dev/six-stage-event-matching'
    || pathname === '/api/research/six-stage/current-projection'
    ? 'fixture'
    : 'real'
}
