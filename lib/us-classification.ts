export const US_SEC_SIC_TAXONOMY = 'US_SEC_SIC'

const SIC_MAJOR_GROUP_NAMES: Record<string, string> = {
  '01': 'Agricultural Production - Crops',
  '02': 'Agricultural Production - Livestock',
  '07': 'Agricultural Services',
  '08': 'Forestry',
  '09': 'Fishing, Hunting & Trapping',
  '10': 'Metal Mining',
  '12': 'Coal Mining',
  '13': 'Oil & Gas Extraction',
  '14': 'Nonmetallic Minerals',
  '15': 'General Building Contractors',
  '16': 'Heavy Construction',
  '17': 'Special Trade Contractors',
  '20': 'Food & Kindred Products',
  '21': 'Tobacco Products',
  '22': 'Textile Mill Products',
  '23': 'Apparel & Other Textile Products',
  '24': 'Lumber & Wood Products',
  '25': 'Furniture & Fixtures',
  '26': 'Paper & Allied Products',
  '27': 'Printing & Publishing',
  '28': 'Chemicals & Allied Products',
  '29': 'Petroleum & Coal Products',
  '30': 'Rubber & Plastics Products',
  '31': 'Leather & Leather Products',
  '32': 'Stone, Clay & Glass Products',
  '33': 'Primary Metal Industries',
  '34': 'Fabricated Metal Products',
  '35': 'Industrial Machinery & Equipment',
  '36': 'Electronic & Electrical Equipment',
  '37': 'Transportation Equipment',
  '38': 'Instruments & Related Products',
  '39': 'Miscellaneous Manufacturing',
  '40': 'Railroad Transportation',
  '41': 'Local & Interurban Transit',
  '42': 'Motor Freight & Warehousing',
  '43': 'Postal Service',
  '44': 'Water Transportation',
  '45': 'Air Transportation',
  '46': 'Pipelines, Except Natural Gas',
  '47': 'Transportation Services',
  '48': 'Communications',
  '49': 'Electric, Gas & Sanitary Services',
  '50': 'Wholesale Trade - Durable Goods',
  '51': 'Wholesale Trade - Nondurable Goods',
  '52': 'Building Materials & Garden Supplies',
  '53': 'General Merchandise Stores',
  '54': 'Food Stores',
  '55': 'Automotive Dealers & Service Stations',
  '56': 'Apparel & Accessory Stores',
  '57': 'Furniture & Home Furnishings Stores',
  '58': 'Eating & Drinking Places',
  '59': 'Miscellaneous Retail',
  '60': 'Depository Institutions',
  '61': 'Nondepository Credit Institutions',
  '62': 'Security & Commodity Brokers',
  '63': 'Insurance Carriers',
  '64': 'Insurance Agents & Brokers',
  '65': 'Real Estate',
  '67': 'Holding & Other Investment Offices',
  '70': 'Hotels & Other Lodging Places',
  '72': 'Personal Services',
  '73': 'Business Services',
  '75': 'Automotive Repair & Services',
  '76': 'Miscellaneous Repair Services',
  '78': 'Motion Pictures',
  '79': 'Amusement & Recreation Services',
  '80': 'Health Services',
  '81': 'Legal Services',
  '82': 'Educational Services',
  '83': 'Social Services',
  '84': 'Museums, Botanical & Zoological Gardens',
  '86': 'Membership Organizations',
  '87': 'Engineering, Accounting & Management Services',
  '88': 'Private Households',
  '89': 'Miscellaneous Services',
  '91': 'Executive, Legislative & General Government',
  '92': 'Justice, Public Order & Safety',
  '93': 'Public Finance, Taxation & Monetary Policy',
  '94': 'Administration of Human Resources',
  '95': 'Environmental Quality & Housing',
  '96': 'Administration of Economic Programs',
  '97': 'National Security & International Affairs',
  '99': 'Nonclassifiable Establishments',
}

export function sicMajorGroupFromCode(
  sic: string | number | null | undefined,
): { code: string; name: string } | null {
  const raw = String(sic ?? '').trim()
  if (!/^\d{1,4}$/.test(raw)) return null
  const code = raw.padStart(4, '0').slice(0, 2)
  return {
    code,
    name: SIC_MAJOR_GROUP_NAMES[code] ?? `SIC Major Group ${code}`,
  }
}

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
