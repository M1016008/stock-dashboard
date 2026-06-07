export const UNIVERSE_FILTER_PARAM = 'universe'

export type UniverseFilterId = 'nikkei225'
export type UniverseFilterValue = UniverseFilterId | null

export interface UniverseFilterMeta {
  id: UniverseFilterId
  label: string
  shortLabel: string
  description: string
  sourceUrl: string
  sourceUpdatedAt: string
  tickers: readonly string[]
}

// Source: Nikkei Indexes official component list, updated 2026-06-05.
// https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225
export const NIKKEI225_TICKERS = [
  '4151', '4502', '4503', '4506', '4507', '4519', '4523', '4568', '4578',
  '285A', '4062', '6479', '6501', '6503', '6504', '6506', '6526', '6645', '6701', '6702', '6723', '6724', '6752', '6753', '6758', '6762', '6770', '6841', '6857', '6861', '6902', '6920', '6954', '6963', '6971', '6976', '6981', '7735', '7751', '7752', '8035',
  '543A', '7201', '7202', '7203', '7211', '7261', '7267', '7269', '7270', '7272',
  '4543', '4902', '6146', '7731', '7733', '7741',
  '9432', '9433', '9434', '9984',
  '5831', '7186', '8304', '8306', '8308', '8309', '8316', '8331', '8354', '8411',
  '8253', '8591', '8697',
  '8601', '8604',
  '8630', '8725', '8750', '8766', '8795',
  '1332',
  '2002', '2269', '2282', '2501', '2502', '2503', '2801', '2802', '2871', '2914',
  '3086', '3092', '3099', '3382', '7453', '7532', '8233', '8252', '8267', '9843', '9983',
  '2413', '2432', '3659', '3697', '4307', '4324', '4385', '4661', '4689', '4704', '4751', '4755', '6098', '6178', '6532', '7974', '9602', '9735', '9766',
  '1605',
  '3401', '3402',
  '3861',
  '3405', '3407', '4004', '4005', '4021', '4042', '4043', '4061', '4063', '4183', '4188', '4208', '4452', '4901', '4911', '6988',
  '5019', '5020',
  '5101', '5108',
  '5201', '5214', '5233', '5301', '5332', '5333',
  '5401', '5406', '5411',
  '3436', '5706', '5711', '5713', '5714', '5801', '5802', '5803',
  '2768', '8001', '8002', '8015', '8031', '8053', '8058',
  '1721', '1801', '1802', '1803', '1808', '1812', '1925', '1928', '1963',
  '5631', '6103', '6113', '6273', '6301', '6302', '6305', '6326', '6361', '6367', '6471', '6472', '6473', '7004', '7011', '7013',
  '7012',
  '7832', '7911', '7912', '7951',
  '3289', '8801', '8802', '8804', '8830',
  '9001', '9005', '9007', '9008', '9009', '9020', '9021', '9022',
  '9064', '9147',
  '9101', '9104', '9107',
  '9201', '9202',
  '9501', '9502', '9503',
  '9531', '9532',
] as const

export const MARKET_UNIVERSE_FILTERS = {
  nikkei225: {
    id: 'nikkei225',
    label: '日経平均225',
    shortLabel: '日経225',
    description: '日経平均株価の採用銘柄だけに絞り込みます。',
    sourceUrl: 'https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225',
    sourceUpdatedAt: '2026-06-05',
    tickers: NIKKEI225_TICKERS,
  },
} as const satisfies Record<UniverseFilterId, UniverseFilterMeta>

const NIKKEI225_SET = new Set<string>(NIKKEI225_TICKERS)

export function parseUniverseFilter(value: unknown): UniverseFilterValue {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase().replace(/[_\s-]+/g, '')
  if (normalized === 'nikkei225' || normalized === 'n225') return 'nikkei225'
  return null
}

export function getUniverseFilterMeta(filter: UniverseFilterValue): UniverseFilterMeta | null {
  return filter ? MARKET_UNIVERSE_FILTERS[filter] : null
}

export function getUniverseTickerSet(filter: UniverseFilterValue): ReadonlySet<string> | null {
  if (filter === 'nikkei225') return NIKKEI225_SET
  return null
}

export function isTickerInUniverse(ticker: string | null | undefined, filter: UniverseFilterValue): boolean {
  const set = getUniverseTickerSet(filter)
  if (!set) return true
  return ticker ? set.has(ticker.toUpperCase().replace(/\.T$/i, '')) : false
}

export function filterRowsByUniverse<T>(
  rows: readonly T[],
  filter: UniverseFilterValue,
  getTicker: (row: T) => string | null | undefined = (row) => (row as { ticker?: string }).ticker,
): T[] {
  const set = getUniverseTickerSet(filter)
  if (!set) return [...rows]
  return rows.filter((row) => {
    const ticker = getTicker(row)
    return ticker ? set.has(ticker.toUpperCase().replace(/\.T$/i, '')) : false
  })
}

export function universeSqlCondition(
  columnSql: string,
  filter: UniverseFilterValue,
): { sql: string; params: string[] } {
  const meta = getUniverseFilterMeta(filter)
  if (!meta) return { sql: '', params: [] }
  return {
    sql: `${columnSql} IN (${meta.tickers.map(() => '?').join(', ')})`,
    params: [...meta.tickers],
  }
}

export function addUniverseToHref(href: string, filter: UniverseFilterValue): string {
  if (!filter) return href
  const hashIndex = href.indexOf('#')
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : ''
  const queryIndex = beforeHash.indexOf('?')
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : ''
  const params = new URLSearchParams(query)
  params.set(UNIVERSE_FILTER_PARAM, filter)
  const qs = params.toString()
  return `${path}${qs ? `?${qs}` : ''}${hash}`
}
