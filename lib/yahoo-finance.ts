// lib/yahoo-finance.ts
import YahooFinance from 'yahoo-finance2'
import type { StockQuote, OHLCV, Fundamentals } from '@/types/stock'

// yahoo-finance2 v3 はインスタンス化が必要 (旧 v2 はシングルトンの default export だった)。
// ライブラリの TypeScript 型と実体ズレを吸収するため any 経由でインスタンス化する。
const yahooFinance: any = new (YahooFinance as any)()

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

function isJPTicker(ticker: string): boolean {
  // 4桁数字ならJP、.Tで終わる場合もJP
  return /^\d{4}$/.test(ticker) || ticker.endsWith('.T')
}

function normalizeTicker(ticker: string): string {
  if (/^\d{4}$/.test(ticker)) return `${ticker}.T`
  return ticker
}

export async function getQuote(ticker: string): Promise<StockQuote> {
  const t = normalizeTicker(ticker)
  const market = isJPTicker(t) ? 'JP' : 'US'
  const currency = market === 'JP' ? 'JPY' : 'USD'

  try {
    // yahoo-finance2 のオーバーロード解決に難があるため any 経由で受ける
    const result: any = await yahooFinance.quote(t, {
      fields: [
        'regularMarketPrice',
        'regularMarketChange',
        'regularMarketChangePercent',
        'regularMarketVolume',
        'marketCap',
        'shortName',
        'longName',
        'fiftyTwoWeekHigh',
        'fiftyTwoWeekLow',
        'averageDailyVolume10Day',
        'fullExchangeName',
      ],
    })

    return {
      ticker: t,
      market,
      currency,
      name: result?.shortName ?? result?.longName ?? t,
      price: result?.regularMarketPrice ?? 0,
      change: result?.regularMarketChange ?? 0,
      changePercent: result?.regularMarketChangePercent ?? 0,
      volume: result?.regularMarketVolume ?? 0,
      marketCap: result?.marketCap ?? undefined,
      fiftyTwoWeekHigh: result?.fiftyTwoWeekHigh ?? undefined,
      fiftyTwoWeekLow: result?.fiftyTwoWeekLow ?? undefined,
      averageDailyVolume10Day: result?.averageDailyVolume10Day ?? undefined,
      exchange: result?.fullExchangeName ?? undefined,
    }
  } catch (error) {
    console.error(`getQuote error for ${t}:`, error)
    throw error
  }
}

export async function getHistory(
  ticker: string,
  period: '1mo' | '3mo' | '6mo' | '1y' | '2y'
): Promise<OHLCV[]> {
  const t = normalizeTicker(ticker)

  const periodMap: Record<string, number> = {
    '1mo': 30,
    '3mo': 90,
    '6mo': 180,
    '1y': 365,
    '2y': 730,
  }

  const daysBack = periodMap[period]
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - daysBack)

  try {
    const result: any = await yahooFinance.chart(t, {
      period1: startDate,
      interval: '1d',
    })

    const quotes: any[] = result?.quotes ?? []
    return quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({
        date: new Date(q.date).toISOString().split('T')[0],
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume ?? 0,
      }))
  } catch (error) {
    console.error(`getHistory error for ${t}:`, error)
    throw error
  }
}

export async function getFundamentals(ticker: string): Promise<Fundamentals> {
  const t = normalizeTicker(ticker)
  const result: Fundamentals = {}

  try {
    const quoteSummary: any = await yahooFinance.quoteSummary(t, {
      modules: [
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
        'assetProfile',
      ],
    })

    const summaryDetail = quoteSummary.summaryDetail
    const keyStats = quoteSummary.defaultKeyStatistics
    const financialData = quoteSummary.financialData
    const assetProfile = quoteSummary.assetProfile

    // PER
    result.per = summaryDetail?.trailingPE ?? keyStats?.trailingEps ? undefined : undefined
    if (summaryDetail?.trailingPE) result.per = summaryDetail.trailingPE
    // PBR
    if (keyStats?.priceToBook) result.pbr = keyStats.priceToBook
    // ROE
    if (financialData?.returnOnEquity) result.roe = financialData.returnOnEquity * 100
    // EPS
    if (keyStats?.trailingEps) result.eps = keyStats.trailingEps
    // 配当利回り
    if (summaryDetail?.dividendYield) result.dividendYield = summaryDetail.dividendYield * 100
    // 売上高
    if (financialData?.totalRevenue) result.revenue = financialData.totalRevenue
    // 営業利益
    if (financialData?.operatingCashflow) result.operatingIncome = financialData.operatingCashflow

    // 業種（米国株）
    if (!t.endsWith('.T')) {
      if (assetProfile && 'sector' in assetProfile) {
        result.sectorEn = (assetProfile as any).sector ?? undefined
        result.industry = (assetProfile as any).industry ?? undefined
      }
    }
  } catch (error) {
    console.error(`getFundamentals error for ${t}:`, error)
    // エラーでも空のオブジェクトを返す（エラーにしない）
  }

  return result
}

export async function searchTickers(
  query: string
): Promise<{ ticker: string; name: string; market: 'JP' | 'US' }[]> {
  try {
    const result: any = await yahooFinance.search(query, { newsCount: 0, quotesCount: 10 })
    const quotes: any[] = result?.quotes ?? []

    return quotes
      .filter((q) => q.quoteType === 'EQUITY')
      .slice(0, 10)
      .map((q) => ({
        ticker: q.symbol as string,
        name: (q.shortname ?? q.longname ?? q.symbol) as string,
        market: isJPTicker(q.symbol) ? 'JP' : 'US',
      }))
  } catch (error) {
    console.error('searchTickers error:', error)
    return []
  }
}

// 複数銘柄を並列取得（レート制限対策: 100msの間隔）
export async function getMultipleQuotes(tickers: string[]): Promise<StockQuote[]> {
  const results: StockQuote[] = []
  for (const ticker of tickers) {
    try {
      const quote = await getQuote(ticker)
      results.push(quote)
    } catch (error) {
      console.error(`getMultipleQuotes error for ${ticker}:`, error)
    }
    await delay(100)
  }
  return results
}
