const US_PRIMARY_NAMES: Record<string, string> = {
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft Corporation',
  NVDA: 'NVIDIA Corporation',
  AMZN: 'Amazon.com, Inc.',
  META: 'Meta Platforms, Inc.',
  GOOGL: 'Alphabet Inc. Class A',
  GOOG: 'Alphabet Inc. Class C',
  GOGL: 'Golden Ocean Group Ltd',
  TSLA: 'Tesla, Inc.',
  AVGO: 'Broadcom Inc.',
  'BRK-A': 'Berkshire Hathaway Inc. Class A',
  'BRK-B': 'Berkshire Hathaway Inc. Class B',
  BRK: 'Berkshire Hathaway Inc.',
  JPM: 'JPMorgan Chase & Co.',
  LLY: 'Eli Lilly and Company',
  V: 'Visa Inc.',
  MA: 'Mastercard Incorporated',
  NFLX: 'Netflix, Inc.',
  COST: 'Costco Wholesale Corporation',
  XOM: 'Exxon Mobil Corporation',
  WMT: 'Walmart Inc.',
  ORCL: 'Oracle Corporation',
}

const US_SEARCH_ALIASES: Record<string, string[]> = {
  GOOGL: ['ALPHABET', 'GOOGLE', 'GOOGLE CLASS A', 'ALPHABET CLASS A'],
  GOOG: ['ALPHABET', 'GOOGLE', 'GOOGLE CLASS C', 'ALPHABET CLASS C'],
  AAPL: ['APPLE', 'IPHONE'],
  MSFT: ['MICROSOFT'],
  NVDA: ['NVIDIA', 'エヌビディア'],
  AMZN: ['AMAZON'],
  META: ['META', 'FACEBOOK', 'INSTAGRAM'],
  TSLA: ['TESLA'],
  'BRK-A': ['BERKSHIRE', 'BUFFETT', 'BERKSHIRE HATHAWAY', 'BERKSHIRE CLASS A'],
  'BRK-B': ['BERKSHIRE', 'BUFFETT', 'BERKSHIRE HATHAWAY', 'BERKSHIRE CLASS B'],
  BRK: ['BERKSHIRE', 'BUFFETT', 'BERKSHIRE HATHAWAY'],
  JPM: ['JPMORGAN', 'JP MORGAN'],
}

function normalizeQuery(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ')
}

function normalizeSymbolQuery(value: string): string {
  return normalizeQuery(value).replace(/[._/\\-]+/g, '-')
}

export function getUsDisplayName(ticker: string, rawName?: string | null): string {
  const normalized = ticker.trim().toUpperCase()
  const name = rawName?.trim()
  if (name && name.toUpperCase() !== normalized) return name
  return US_PRIMARY_NAMES[normalized] ?? name ?? normalized
}

export function getUsSecondaryName(ticker: string, rawName?: string | null): string | null {
  const normalized = ticker.trim().toUpperCase()
  const displayName = getUsDisplayName(normalized, rawName).trim()
  return displayName.toUpperCase() === normalized ? null : displayName
}

export function findUsAliasTickers(query: string): string[] {
  const normalized = normalizeQuery(query)
  const normalizedSymbol = normalizeSymbolQuery(query)
  if (!normalized) return []
  const matches = new Set<string>()
  for (const [ticker, aliases] of Object.entries(US_SEARCH_ALIASES)) {
    if (
      normalizeSymbolQuery(ticker).includes(normalizedSymbol)
      || aliases.some((alias) => normalizeQuery(alias).includes(normalized) || normalized.includes(normalizeQuery(alias)))
    ) {
      matches.add(ticker)
    }
  }
  return Array.from(matches).sort()
}
