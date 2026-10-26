export const SEC_EDGAR_MIN_REQUEST_INTERVAL_MS = 100
type Environment = Readonly<Record<string, string | undefined>>

export function requiredSecUserAgent(environment: Environment = process.env): string {
  const userAgent = environment.SEC_USER_AGENT?.trim()
  if (!userAgent || !userAgent.includes('@')) {
    throw new Error('SEC_USER_AGENT with an operator contact email is required in machine-local environment')
  }
  return userAgent
}

export function secRequestIntervalMs(environment: Environment = process.env): number {
  const requested = Number(environment.SEC_RATE_LIMIT_MS ?? 150)
  return Number.isFinite(requested)
    ? Math.max(SEC_EDGAR_MIN_REQUEST_INTERVAL_MS, Math.trunc(requested))
    : 150
}
