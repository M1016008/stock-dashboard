export const US_SEC_SIC_TAXONOMY = 'US_SEC_SIC'

export function sectorFromSic(sic: string | number | null | undefined): {
  sectorCode: string
  sectorName: string
} {
  const n = Number(sic)
  if (!Number.isFinite(n)) return { sectorCode: 'UNKNOWN', sectorName: 'Unknown' }
  if (n >= 100 && n <= 999) return { sectorCode: 'AGR', sectorName: 'Agriculture, Forestry & Fishing' }
  if (n >= 1000 && n <= 1499) return { sectorCode: 'MINING', sectorName: 'Mining' }
  if (n >= 1500 && n <= 1799) return { sectorCode: 'CONSTRUCTION', sectorName: 'Construction' }
  if (n >= 2000 && n <= 3999) return { sectorCode: 'MANUFACTURING', sectorName: 'Manufacturing' }
  if (n >= 4000 && n <= 4999) return { sectorCode: 'TRANSPORT_UTIL', sectorName: 'Transportation, Communications & Utilities' }
  if (n >= 5000 && n <= 5199) return { sectorCode: 'WHOLESALE', sectorName: 'Wholesale Trade' }
  if (n >= 5200 && n <= 5999) return { sectorCode: 'RETAIL', sectorName: 'Retail Trade' }
  if (n >= 6000 && n <= 6799) return { sectorCode: 'FINANCE', sectorName: 'Finance, Insurance & Real Estate' }
  if (n >= 7000 && n <= 8999) return { sectorCode: 'SERVICES', sectorName: 'Services' }
  if (n >= 9000 && n <= 9999) return { sectorCode: 'PUBLIC_ADMIN', sectorName: 'Public Administration' }
  return { sectorCode: 'UNKNOWN', sectorName: 'Unknown' }
}

export function normalizeUsClassificationTicker(ticker: string): string {
  return ticker.trim().toUpperCase()
}

export function usClassificationTickerAliases(ticker: string): string[] {
  const normalized = normalizeUsClassificationTicker(ticker)
  return Array.from(new Set([
    normalized,
    normalized.replaceAll('.', '-'),
    normalized.replaceAll('-', '.'),
  ]))
}
