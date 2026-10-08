import type {
  DashboardTradeSignalMarket,
  DashboardTradeSignalRow,
  DashboardTradeSignalSide,
} from '@/lib/queries/dashboard-trade-signals'

export type DashboardIndustryLevel = '17' | '33'

type DashboardIndustryRow = Pick<
  DashboardTradeSignalRow,
  'market' | 'side' | 'industry17' | 'industry33'
>

export function dashboardIndustryValue(
  row: DashboardIndustryRow,
  level: DashboardIndustryLevel,
): string {
  return level === '17' ? row.industry17 : row.industry33
}

export function dashboardIndustryOptions(
  rows: DashboardIndustryRow[],
  market: DashboardTradeSignalMarket,
  side: DashboardTradeSignalSide,
  level: DashboardIndustryLevel,
): string[] {
  const values = new Set<string>()
  for (const row of rows) {
    if (row.market !== market || row.side !== side) continue
    const value = dashboardIndustryValue(row, level).trim()
    if (value) values.add(value)
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b, 'ja'))
}
