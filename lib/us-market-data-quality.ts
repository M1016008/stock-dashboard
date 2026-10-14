export type UsAnalyticalPriceRow = {
  ticker: string
  date: string
  volume: number | null
}

export const US_ANALYTICAL_PRICE_ROW_EXCLUSIONS = [
  {
    ticker: 'QMMM',
    startDate: '2025-09-29',
    reason: 'OFFICIAL_TRADING_HALT_ZERO_VOLUME',
    authority: 'NASDAQ',
    authorityUrl: 'https://ir.nasdaq.com/news-releases/news-release-details/nasdaq-halts-qmmm-holdings-limited',
  },
] as const

export const US_ACCEPTED_OBSERVED_PRICE_EVENTS = [
  {
    ticker: 'RGC',
    date: '2025-06-16',
    reason: 'POST_SPLIT_OBSERVED_TRADING',
    authority: 'ISSUER_SEC_FILING',
    authorityUrl: 'https://www.sec.gov/Archives/edgar/data/1829667/000121390025054936/ea024581601ex99-1_regencell.htm',
  },
] as const

function assertSqlAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Unsafe US market-data SQL alias: ${alias}`)
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function exclusionSql(alias: string, volumeSql: string): string {
  return US_ANALYTICAL_PRICE_ROW_EXCLUSIONS.map((policy) => `(
    ${alias}.ticker = ${sqlLiteral(policy.ticker)}
    AND ${alias}.date >= ${sqlLiteral(policy.startDate)}
    AND COALESCE(${volumeSql}, 0) <= 0
  )`).join('\n    OR ')
}

export function isUsAnalyticalPriceRowEligible(row: UsAnalyticalPriceRow): boolean {
  const ticker = row.ticker.trim().toUpperCase()
  return !US_ANALYTICAL_PRICE_ROW_EXCLUSIONS.some((policy) => (
    ticker === policy.ticker
    && row.date >= policy.startDate
    && Number(row.volume ?? 0) <= 0
  ))
}

export function usSourceAnalyticalPriceEligibleSql(alias: string): string {
  assertSqlAlias(alias)
  return `NOT (${exclusionSql(alias, `COALESCE(${alias}.adj_volume, ${alias}.volume)`)})`
}

export function usAnalyticsPriceEligibleSql(alias: string): string {
  assertSqlAlias(alias)
  return `NOT (${exclusionSql(alias, `${alias}.volume`)})`
}

export function usAnalyticsPriceIneligibleSql(alias: string): string {
  assertSqlAlias(alias)
  return exclusionSql(alias, `${alias}.volume`)
}

export function usAnalyticalPricePolicyWindowSql(alias: string): string {
  assertSqlAlias(alias)
  return US_ANALYTICAL_PRICE_ROW_EXCLUSIONS.map((policy) => `(
    ${alias}.ticker = ${sqlLiteral(policy.ticker)}
    AND ${alias}.date >= ${sqlLiteral(policy.startDate)}
  )`).join('\n    OR ')
}
