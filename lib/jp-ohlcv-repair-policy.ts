export type JpOhlcvComparableRow = {
  ticker: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export const JP_OHLCV_PROTECTED_CONFLICT_KEYS = [
  { ticker: '1447', date: '2026-07-17' },
  { ticker: '2164', date: '2026-07-17' },
] as const

const PROTECTED_KEYS = new Set(
  JP_OHLCV_PROTECTED_CONFLICT_KEYS.map(({ ticker, date }) => `${ticker}:${date}`),
)

export class JpOhlcvProtectedConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JpOhlcvProtectedConflictError'
  }
}

export function jpOhlcvKey(row: Pick<JpOhlcvComparableRow, 'ticker' | 'date'>): string {
  return `${row.ticker}:${row.date}`
}

export function isJpOhlcvProtectedConflictKey(
  row: Pick<JpOhlcvComparableRow, 'ticker' | 'date'>,
): boolean {
  return PROTECTED_KEYS.has(jpOhlcvKey(row))
}

export function sameJpOhlcvRow(left: JpOhlcvComparableRow, right: JpOhlcvComparableRow): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-10)
  return left.ticker === right.ticker
    && left.date === right.date
    && near(left.open, right.open)
    && near(left.high, right.high)
    && near(left.low, right.low)
    && near(left.close, right.close)
    && left.volume === right.volume
}

export function protectedDatesForTicker(ticker: string): string[] {
  return JP_OHLCV_PROTECTED_CONFLICT_KEYS
    .filter((key) => key.ticker === ticker)
    .map((key) => key.date)
}
