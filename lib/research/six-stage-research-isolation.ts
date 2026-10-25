const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const RESEARCH_SCOPES = new Set(['development', 'test', 'preview'])

export type SixStageResearchMode = 'real' | 'fixture'

function firstForwardedHost(value: string | null): string | null {
  if (!value) return null
  return value.split(',')[0]?.trim().split(':')[0]?.toLowerCase() || null
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
  if (!LOOPBACK_HOSTS.has(hostname)) return false
  if (args.headers.has('cf-connecting-ip') || args.headers.has('cf-ray')) return false

  const forwardedHost = firstForwardedHost(args.headers.get('x-forwarded-host'))
  if (forwardedHost && !LOOPBACK_HOSTS.has(forwardedHost)) return false

  if (args.mode === 'real') return environment.SIX_STAGE_REAL_RESEARCH_ONLY === '1'
  return environment.STOCKBOARD_FIXTURE_ONLY === '1'
    || environment.SIX_STAGE_REAL_RESEARCH_ONLY === '1'
}

export function isSixStageResearchPath(pathname: string): boolean {
  return pathname === '/dev/six-stage-event-paths'
    || pathname === '/dev/six-stage-event-matching'
    || pathname === '/api/research/six-stage/event-paths'
}

export function requiredSixStageResearchMode(pathname: string): SixStageResearchMode {
  return pathname === '/dev/six-stage-event-matching' ? 'fixture' : 'real'
}
