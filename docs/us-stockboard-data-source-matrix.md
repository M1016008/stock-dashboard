# US StockBoard Data Source Matrix

Updated: 2026-10-12

| Domain | Canonical source | Current coverage | PIT contract | Status | Remaining action |
|---|---|---:|---|---|---|
| Daily price and volume | Tiingo EOD in `market_ohlcv_daily` | 11,970 tickers on 2026-10-09 | Date-keyed; adjusted-price generation must remain generation-consistent | DATA READY | Keep quality and corporate-action gates |
| Daily 6 Stage snapshots | Deterministic StockBoard engine in `market_daily_snapshots` | 11,946 tickers on 2026-10-09 | Date-keyed | DATA READY | Cross-market semantic regression |
| Stage screener serving | Indexed price-anchor pivot plus dated Stage snapshots | 12,437 investable rows on 2026-10-09 | Requested date resolves to latest snapshot on or before that date | CODE READY | Candidate cold response 4.29s; compact payload 10.04MB plain / 2.15MB gzip; continue performance work |
| PMS / PFS / PES | US analytics DB | 11,970 symbols on 2026-10-09 | Latest row on or before requested date | DATA READY | Per-symbol missing reason |
| ML feature vectors | US analytics DB | 10,391 tickers on 2026-10-09 | `as_of_date <= selected date` | DATA READY | UI and acceptance-metric parity |
| ML candidates | US analytics DB | 1,270 tickers on 2026-10-09 | `as_of_date <= selected date` | DATA READY | Broaden discovery wiring |
| Current similars | US analytics DB | 10,391 bases / 51,955 rows on 2026-10-09 | `as_of_date <= selected date` | DATA READY | US quality caveats |
| Universe identity | Tiingo metadata plus observed snapshots | 12,439 active; 21,973 total | Historical membership comes from dated snapshots, not current `active` | DATA PARTIAL | Add effective-dated delisting ledger if needed |
| SEC SIC classification | SEC submissions-derived `market_classifications` | 7,363 tickers; 6,888 active sector / 6,422 active industry | Current rows use sentinel `0000-01-01` and are not historical evidence | DATA PARTIAL | Add effective-dated history before historical filters |
| Shares outstanding | Current `market_universe.shares_outstanding` | Partial | Current-only; prohibited for historical market cap | DATA PARTIAL | SEC XBRL instant facts with publication timestamps |
| Earnings calendar | `market_earnings_calendar`, Finnhub contract | Live coverage requires re-verification | Historical queries require `imported_at` cutoff at selected date | DATA PARTIAL | Coverage audit and event UI |
| Financial statements | Intended `normalized_financial_facts` | No verified US rows | Filing publication time must be on or before selected date | DATA MISSING | SEC Companyfacts ingestion |
| Forecasts | Intended `financial_forecast_snapshots` | No verified US rows | Forecast publication time must be on or before selected date | DATA MISSING | Requires approved forecast source |
| Dividends / splits | Existing market data storage | Stored foundation, UI coverage unverified | Event announcement/effective dates must be separate | DATA PARTIAL | Audit and wire shareholder return |
| Institutional ownership | None approved for serving | 0 | Filing publication timestamp required | DATA MISSING | Decide SEC 13F and 13D/G product scope |
| Insider activity | None approved for serving | 0 | SEC filing acceptance timestamp required | DATA MISSING | Consider Form 4 after ownership scope |
| Short interest | None approved | 0 | Publication date required | DATA MISSING | Approved/licensed source required |
| US sector hierarchy | SEC SIC | Partial | Current-only until effective dating exists | DATA SUBSTITUTE | Preserve taxonomy label; do not call it GICS |
| Friend access | Cloudflare Access + read-only gateway | JP live; US unverified | Same-origin reads; mutations blocked by route semantics | UNVERIFIED | Full US route smoke and write-bypass audit |

## Rules

1. A current metadata value is never silently presented as point-in-time evidence.
2. A future filing, forecast, earnings import, ownership filing, or peer statistic is never used for a selected historical date.
3. Missing data remains unavailable; Claude and deterministic presentation code do not invent values.
4. US equivalents preserve the JP feature's analytical intent, not necessarily its Japanese regulatory label.
5. Paid, licensed, or legally ambiguous sources remain blocked until the user approves the source.
