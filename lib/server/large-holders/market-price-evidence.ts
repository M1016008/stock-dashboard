import type { client } from '@/lib/db/client'
import type { LargeHolderFiling, HolderFact } from '@/lib/large-holders/filing'
import type { MarketPriceEvidence } from '@/lib/large-holders/market-price-eligibility'

type Executor = Pick<typeof client, 'execute'>

export async function marketPriceEvidence(
  db: Executor, filing: LargeHolderFiling, holder: HolderFact, ticker: string | null,
): Promise<MarketPriceEvidence> {
  const reference = holder.referenceDate ?? filing.referenceDate ?? filing.obligationDate
  const empty: MarketPriceEvidence = {
    issuerCodeMatches: false, listedAtReference: false, uniquePriceInstrument: false,
    priceDate: null, close: null, classAmbiguous: true,
  }
  if (!ticker || !reference || reference > filing.submittedAt.slice(0, 10)) return empty
  const sourceListed = filing.issuerListing === '上場'
  const instrument = await db.execute({
    sql: `SELECT t.ticker, t.market_segment, h.first_trade_date, h.last_trade_date,
      (SELECT count(*) FROM ticker_universe t2 WHERE t2.ticker=t.ticker) AS matching_count
      FROM ticker_universe t LEFT JOIN historical_universe h ON h.ticker=t.ticker
      WHERE t.ticker=?`, args: [ticker],
  })
  const record = instrument.rows[0]
  const listedAtReference = Boolean(sourceListed && record && record.first_trade_date
    && String(record.first_trade_date) <= reference && String(record.last_trade_date) >= reference)
  const price = listedAtReference ? await db.execute({
    sql: `SELECT date, close FROM ohlcv_daily WHERE ticker=? AND date<=?
      ORDER BY date DESC LIMIT 1`, args: [ticker, reference],
  }) : null
  const latest = price?.rows[0]
  const priceDate = latest?.date && Date.parse(`${reference}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`) <= 7 * 86_400_000
    ? String(latest.date) : null
  return {
    issuerCodeMatches: filing.issuerSecurityCode === ticker || filing.issuerSecurityCode === `${ticker}0`,
    listedAtReference,
    uniquePriceInstrument: record?.matching_count === 1 && !!record.market_segment,
    priceDate,
    close: priceDate && latest?.close != null ? Number(latest.close) : null,
    // A present-holding note identifying several share classes cannot be
    // allocated to this listed ticker by the broad direct-security row.
    classAmbiguous: /優先株|種類株|複数種類|別種類|投資口.*株式/.test(holder.holdingNote ?? ''),
  }
}
