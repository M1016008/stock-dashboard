export type WorkspaceMarket = 'JP' | 'US'

export type WorkspaceSymbol = {
  market: WorkspaceMarket
  ticker: string
  name?: string | null
}

const RECENT_KEY = 'stockboard_recent_symbols_v1'
const COMPARE_KEY = 'stockboard_compare_symbols_v1'
export const WORKSPACE_EVENT = 'stockboard-workspace-change'

function readList(key: string): WorkspaceSymbol[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is WorkspaceSymbol => (
        item
        && (item.market === 'JP' || item.market === 'US')
        && typeof item.ticker === 'string'
      ))
      .map((item) => ({
        market: item.market,
        ticker: item.ticker.trim().toUpperCase().replace(/\.T$/i, ''),
        name: typeof item.name === 'string' ? item.name : null,
      }))
  } catch {
    return []
  }
}

function writeList(key: string, items: WorkspaceSymbol[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(items))
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT))
}

export function getRecentSymbols(): WorkspaceSymbol[] {
  return readList(RECENT_KEY)
}

export function recordRecentSymbol(symbol: WorkspaceSymbol) {
  const ticker = symbol.ticker.trim().toUpperCase().replace(/\.T$/i, '')
  const key = `${symbol.market}:${ticker}`
  const next = [
    { ...symbol, ticker },
    ...readList(RECENT_KEY).filter((item) => `${item.market}:${item.ticker}` !== key),
  ].slice(0, 8)
  writeList(RECENT_KEY, next)
}

export function getCompareSymbols(): WorkspaceSymbol[] {
  return readList(COMPARE_KEY)
}

export function isComparedSymbol(market: WorkspaceMarket, ticker: string): boolean {
  const normalized = ticker.trim().toUpperCase().replace(/\.T$/i, '')
  return readList(COMPARE_KEY).some((item) => item.market === market && item.ticker === normalized)
}

export function toggleComparedSymbol(symbol: WorkspaceSymbol): boolean {
  const ticker = symbol.ticker.trim().toUpperCase().replace(/\.T$/i, '')
  const key = `${symbol.market}:${ticker}`
  const current = readList(COMPARE_KEY)
  const exists = current.some((item) => `${item.market}:${item.ticker}` === key)
  const next = exists
    ? current.filter((item) => `${item.market}:${item.ticker}` !== key)
    : [...current, { ...symbol, ticker }].slice(-4)
  writeList(COMPARE_KEY, next)
  return !exists
}

export function clearComparedSymbols() {
  writeList(COMPARE_KEY, [])
}

export function symbolHref(symbol: WorkspaceSymbol): string {
  const ticker = encodeURIComponent(symbol.ticker)
  return symbol.market === 'US' ? `/us/stock/${ticker}` : `/stock/${ticker}`
}
