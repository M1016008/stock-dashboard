export const FRIEND_READ_ONLY_ACCESS_MODE = 'friend-read-only' as const

export const FRIEND_READ_ONLY_JSON_POST_PATHS = new Set([
  '/api/chart-drill/answer',
  '/api/custom-charts/evaluate',
  '/api/integrated-screener',
  '/api/integrated-screener/reason',
  '/api/trigger-discovery/historical-scan',
  '/api/trigger-discovery/mini-charts',
  '/api/trigger-discovery/outcome-segment-comparisons',
  '/api/trigger-discovery/search',
])

export const FRIEND_PRIVATE_PATH_PREFIXES = [
  '/admin',
  '/large-holders/admin',
  '/api/admin',
  '/api/large-holders/admin',
] as const

export function isFriendReadonlyJsonPostPath(pathname: string): boolean {
  return FRIEND_READ_ONLY_JSON_POST_PATHS.has(pathname)
}

export function isFriendPrivatePath(pathname: string): boolean {
  const normalized = pathname.toLowerCase().replaceAll('\\', '/')
  return FRIEND_PRIVATE_PATH_PREFIXES.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ))
}

export function isFriendReadonlyRequestAllowed(method: string, requestUrl: string): boolean {
  let url: URL
  try {
    url = new URL(requestUrl, 'http://friend-access.invalid')
  } catch {
    return false
  }
  if (isFriendPrivatePath(url.pathname)) return false
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return true
  return normalizedMethod === 'POST' && isFriendReadonlyJsonPostPath(url.pathname)
}
