export type MarketCode = 'JP' | 'US'

export const DEFAULT_MARKET: MarketCode = 'JP'

export function normalizeMarket(value: string | null | undefined): MarketCode {
  return value?.toUpperCase() === 'US' ? 'US' : 'JP'
}

export function marketPath(market: MarketCode, path = ''): string {
  if (market === 'JP') return path || '/'
  const suffix = path && path !== '/' ? path : ''
  return `/us${suffix}`
}

export function normalizeTickerForMarket(ticker: string, market: MarketCode): string {
  const decoded = decodeURIComponent(ticker).trim()
  if (market === 'JP') return decoded.replace(/\.T$/i, '')
  return decoded.replace(/\s+/g, '').toUpperCase()
}

export function isValidTickerForMarket(ticker: string, market: MarketCode): boolean {
  const normalized = ticker.trim().toUpperCase()
  if (market === 'JP') return /^(?:\d{4}|\d{3}[A-Z])$/.test(normalized)
  return /^[A-Z0-9.^-]{1,16}$/.test(normalized)
}

export function marketLabel(market: MarketCode): string {
  return market === 'US' ? '米国株' : '日本株'
}

export function currencyForMarket(market: MarketCode): 'JPY' | 'USD' {
  return market === 'US' ? 'USD' : 'JPY'
}
