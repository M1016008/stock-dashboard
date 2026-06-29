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
  BRK_B: 'Berkshire Hathaway Inc. Class B',
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
  BRK_B: ['BERKSHIRE', 'BUFFETT', 'BERKSHIRE HATHAWAY'],
  BRK: ['BERKSHIRE', 'BUFFETT', 'BERKSHIRE HATHAWAY'],
  JPM: ['JPMORGAN', 'JP MORGAN'],
}

function normalizeQuery(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ')
}

export function getUsDisplayName(ticker: string, rawName?: string | null): string {
  const normalized = ticker.trim().toUpperCase()
  const name = rawName?.trim()
  if (name && name.toUpperCase() !== normalized) return name
  return US_PRIMARY_NAMES[normalized] ?? name ?? normalized
}

export function findUsAliasTickers(query: string): string[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return []
  const matches = new Set<string>()
  for (const [ticker, aliases] of Object.entries(US_SEARCH_ALIASES)) {
    if (ticker.includes(normalized) || aliases.some((alias) => normalizeQuery(alias).includes(normalized) || normalized.includes(normalizeQuery(alias)))) {
      matches.add(ticker)
    }
  }
  return Array.from(matches).sort()
}
