# US StockBoard Data Source Matrix

Updated: 2026-10-12

| Domain | Canonical source | Current coverage | PIT contract | Status | Remaining action |
|---|---|---:|---|---|---|
| Daily price and volume | Tiingo EOD in `market_ohlcv_daily` | 11,970 tickers on 2026-10-09 | Date-keyed; adjusted-price generation must remain generation-consistent | DATA READY | Keep quality and corporate-action gates |
| Daily 6 Stage snapshots | Deterministic StockBoard engine in `market_daily_snapshots` | 11,946 tickers on 2026-10-09 | Date-keyed | DATA READY | Cross-market semantic regression |
| Stage transition aggregate | US analytics `stage_transitions` and `pattern_stats` | 216 transition cells; 169,547 horizon-pattern rows; six axes present | Aggregate tables power the overview only; dated scanner events are derived from adjacent observed snapshots | DATA READY | Keep aggregate and dated-event semantics separated |
| Backtest evaluation | US analytics evaluation and serving tables | Model evaluation 39 rows; physics 168; RL 63; similarity 0; serving coverage ends 2026-08-05 | Evaluation queries exclude rows after the current US price watermark; no selected-date query contract yet | DATA PARTIAL | Refresh serving coverage, add selected-date contract, and generate similarity evaluations |
| Stage screener serving | Indexed price-anchor pivot plus dated Stage snapshots | 12,437 investable rows on 2026-10-09 | Requested date resolves to latest snapshot on or before that date | DATA READY | Production is live; cold response and compact-payload reduction remain performance work |
| Stage transition scanner | US analytics `daily_snapshots` + `ohlcv_daily` + current `ticker_universe` labels | 49,409,559 snapshots; 1,193 changed tickers on 2026-10-09 | Transitions and liquidity are evaluated at each event date; missing stages are excluded without bridging; current active membership never filters history; Industry/Exchange filters are allowed only for the latest date | DATA READY | Production and authenticated friend access are verified; add effective-dated classification history before historical classification filters |
| PMS / PFS / PES | US analytics DB | 11,970 symbols on 2026-10-09 | Latest row on or before requested date | DATA READY | Per-symbol missing reason |
| ML feature vectors | US analytics DB | 10,391 tickers on 2026-10-09 | `as_of_date <= selected date` | DATA READY | UI and acceptance-metric parity |
| ML candidates | US analytics DB | 1,270 tickers on 2026-10-09 | `as_of_date <= selected date` | DATA READY | Broaden discovery wiring |
| Current similars | US analytics DB | 10,391 bases / 51,955 rows on 2026-10-09 | `as_of_date <= selected date` | DATA READY | US quality caveats |
| Universe identity | Tiingo metadata plus observed snapshots | 12,439 active; 21,973 total | Historical membership comes from dated snapshots, not current `active`; current exchange / asset-type metadata may be shown only as reference and cannot filter historical results | DATA PARTIAL | Add effective-dated exchange, asset-type, and delisting history before enabling those historical filters |
| SEC SIC classification | SEC submissions-derived `market_classifications` | 7,363 tickers; 6,888 active sector / 6,422 active industry | Current rows use sentinel `0000-01-01` and are not historical evidence | DATA PARTIAL | Add effective-dated history before historical filters |
| Shares outstanding | Current `market_universe.shares_outstanding` | Partial | Current-only; prohibited for historical market cap | DATA PARTIAL | SEC XBRL instant facts with publication timestamps |
| Earnings calendar | `market_earnings_calendar`, Finnhub contract | Finnhub approved as the source on 2026-10-12; 0 US rows; machine-local credential not configured; scheduler absent | Historical query contract uses `imported_at` cutoff at the selected date and is fixture-tested | DATA MISSING | Configure the approved Finnhub credential outside Git, then validate ingestion and event UI before any Production scheduling |
| Financial statements | Intended `normalized_financial_facts` | No verified US rows | Filing publication time must be on or before selected date | DATA MISSING | SEC Companyfacts ingestion |
| Forecasts | Intended `financial_forecast_snapshots` | No verified US rows | Forecast publication time must be on or before selected date | DATA MISSING | Requires approved forecast source |
| Dividends / splits | Existing market data storage | Stored foundation, UI coverage unverified | Event announcement/effective dates must be separate | DATA PARTIAL | Audit and wire shareholder return |
| Institutional ownership | None approved for serving | 0 | Filing publication timestamp required | DATA MISSING | Decide SEC 13F and 13D/G product scope |
| Insider activity | None approved for serving | 0 | SEC filing acceptance timestamp required | DATA MISSING | Consider Form 4 after ownership scope |
| Short interest | None approved | 0 | Publication date required | DATA MISSING | Approved/licensed source required |
| US sector hierarchy | SEC SIC | Partial | Current-only until effective dating exists | DATA SUBSTITUTE | Preserve taxonomy label; do not call it GICS |
| Friend access | Cloudflare Access + read-only gateway | JP live; authenticated US Dashboard, Screener and Stage Transition views live | Same-origin reads; mutations, admin routes and protocol upgrades fail closed by route semantics | DATA PARTIAL | Complete the authenticated US stock-detail route inventory and external mobile matrix |

## Rules

1. A current metadata value is never silently presented as point-in-time evidence.
2. A future filing, forecast, earnings import, ownership filing, or peer statistic is never used for a selected historical date.
3. Missing data remains unavailable; Claude and deterministic presentation code do not invent values.
4. US equivalents preserve the JP feature's analytical intent, not necessarily its Japanese regulatory label.
5. Paid, licensed, or legally ambiguous sources remain blocked until the user approves the source.

## W3 runtime evidence

- `/api/us/hex?timeframe=daily` on 2026-10-12: HTTP 200, cold 4.81s, warm 0.02s, 11.94MB uncompressed / 2.21MB gzip. The current row contract repeats three always-null ML fields and duplicate sector aliases for every asset, while the cold query joins separate price anchors for each return horizon. Remove redundant transport fields first, then optimize the period-return query without changing return semantics.
- `/us/stage-screener`: 1440px and 390px browser smoke passed with no body overflow, console error, failed request, or HTTP error.
- `/us/analysis/transitions`: current distribution, all-history six-axis matrix, and 60-day pattern percentiles render. The matrix now separates neutral stage-maintenance cells from off-diagonal changes, and every current pattern drills into the dated scanner.
- The US Transition Scanner serves observed adjacent-snapshot events with period, exact/Any code, price, volume, turnover, sorting, pagination and ticker drill-down. A month `Any -> 111111` query returned 516 events in 0.99s server time; a current-day `Any -> Any` query returned 1,193 events in 1.21s. Production-mode browser requests were deduplicated to one API request.
- PIT enforcement does not filter historical events by current `active` membership. Current Industry/Exchange metadata may be displayed as reference, but classification filters are disabled in the client and rejected by the API for week/month/custom searches.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the change-focused hierarchy, off-diagonal matrix scale and compact mobile result list. Candidate browser QA passed at 1440, 1024, 768 and 390 px with no body overflow, console/HTTP error or stuck loading state; candidate read-only smoke passed 160/160.
- Main `b3d49be88d7c7885fc5f23bfb5c3a7ff3611435a` was deployed as build `g_ZGu4KOOKQSHow0h0AXl`. Canonical Storage Guard preflight passed; promoted-candidate and Production read-only smoke each passed 160/160, and Production health/storage remained healthy/available.
- Authenticated `stock.marketframe.jp/us/analysis/transitions` loaded both the 30-pattern overview and the 32-row current transition result through Cloudflare Access. Gateway regression confirmed safe reads while writes, admin routes and upgrades remain fail closed.
- `/us/analysis/backtest`: summary tables render, but serving coverage ends 2026-08-05 and `ml_similarity_evaluations` has 0 rows; it is not yet equivalent to the JP interactive date/horizon/filter/detail workflow.

## W2 runtime evidence

- US Dashboard latest and 2026-10-04 weekend requests resolved to 2026-10-09 and the prior US session 2026-10-02 respectively. The dashboard kept price, six-stage, candidate, and ML dates aligned, and historical stock links/previews preserved the resolved date.
- US Screener current and historical requests passed at 1440, 1024, 768, and 390 pixels with no body overflow, console error, failed request, or HTTP error. Historical current-only exchange, asset-type, SIC, and market-cap controls were removed before the analytical request, and no HTTP 422 occurred.
- Candidate browser timings on the warm local Production build were 0.58s for latest Dashboard, 0.42s for historical Dashboard, 1.37s for a 200-row uncached current Screener query, and 0.01s for the cached historical Screener query.
- Stock preview cross-check passed for AAPL, MSFT, NVDA, TSLA, and BRK-B. All had a 2026-10-09 price/stage date and six populated stage axes; BRK.B normalized to BRK-B in Screener search.
- Main commit `ba722f3cad9e7a8cb0237be055ac77019846d18d` was deployed as build `MLW5-_svrKcq3zQxHNNF6`. Canonical Storage Guard checks passed, both candidate and Production read-only smoke passed 160/160, and Production health/storage remained healthy/available.
- Authenticated `stock.marketframe.jp/us` and `/us/screener` loaded current US data through Cloudflare Access and the read-only gateway. The Screener returned 200 rows for 2026-10-09; the gateway regression confirmed safe reads are forwarded while writes, admin routes, and upgrades fail closed.
