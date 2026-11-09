export type WorkspaceMarket = 'JP' | 'US'

export type WorkspaceSymbol = {
  market: WorkspaceMarket
  ticker: string
  name?: string | null
}

const RECENT_KEY = 'stockboard_recent_symbols_v1'
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

export function symbolHref(symbol: WorkspaceSymbol): string {
  const ticker = encodeURIComponent(symbol.ticker)
  return symbol.market === 'US' ? `/us/stock/${ticker}` : `/stock/${ticker}`
}
