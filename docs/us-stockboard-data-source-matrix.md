# US StockBoard Data Source Matrix

Updated: 2026-10-15

| Domain | Canonical source | Current coverage | PIT contract | Status | Remaining action |
|---|---|---:|---|---|---|
| Daily price and volume | Tiingo EOD in `market_ohlcv_daily`; reversible source availability in `market_source_availability` | 11,947 of 12,026 current-active investable tickers on 2026-10-14 (99.34% raw coverage). The availability table is live but has no classified evidence yet, so effective coverage equals raw coverage | Raw source rows are immutable. Exact Tiingo ticker-not-found evidence controls availability. W3J accepts the official RGC 2025-06-16 post-split session and excludes only QMMM zero-volume rows from analytical copies during its official halt; positive-volume resumption becomes eligible automatically | DATA PARTIAL | Continue reversible evidence collection for the 79 unclassified missing tickers; never rewrite raw RGC/QMMM history |
| Daily 6 Stage snapshots | Deterministic StockBoard engine in `market_daily_snapshots` | 11,741 eligible current-active tickers on 2026-10-13 (100% eligible coverage) | Date-keyed | DATA READY | Cross-market semantic regression |
| Data freshness and route coverage contract | Server-derived `/api/us/status` plus each route's existing analysis-date display | One compact contract strip on 11 US analysis routes; OHLCV raw/effective coverage is 11,947/12,026 (99.34%, PARTIAL) and eligible snapshots are 11,922/11,922 (100%) on 2026-10-14 | The shared strip reports source watermarks and coverage only. Raw coverage is always retained; effective coverage removes only confirmed permanent source exclusions. Route-specific AS OF dates remain authoritative; current-only SIC/Exchange values are never substituted on historical dates, and no wall-clock stale state is inferred | DATA READY | W3J is live. Continue source-availability evidence collection; the MTF strip reports the passed US Oracle as one-symbol (`NASDAQ:AAPL`) scope only |
| Stage transition aggregate | US analytics `stage_transitions` and `pattern_stats` | 216 transition cells; 175,191 horizon-pattern rows; six axes present | Aggregate tables power the overview only; dated scanner events are derived from adjacent observed snapshots | DATA READY | Keep aggregate and dated-event semantics separated |
| Backtest evaluation | US analytics `serving_backtest_results`, evidence and evaluation tables | Seven outcome horizons through their mature dates; the W3J rebuild and candidate gate passed in Production | Selected date and detail reads use dated serving rows only; canonical US holidays are excluded and rejected; current classifications are omitted because no effective-dated history exists. W3J keeps the observed RGC move, removes QMMM halt carries only from analytics, and applies no clipping or winsorization | DATA READY | None for the current source-quality gate; broaden model depth only under separately validated contracts |
| ML prediction history and completed outcomes | US analytics `ml_predictions` plus adjusted `ohlcv_daily`; outcomes are computed read-only at request time | 6,938 predictions across 43 dates and 783 tickers before the W3J rebuild; 3,473 up rows/530 tickers and 3,465 down rows/631 tickers; current records use one 40-session horizon; persisted `ml_prediction_outcomes` rows remain 0 | Requested-date reads require `as_of_date <= date`, `created_at` and model `trained_at` no later than the New York market-date cutoff, and outcome prices no later than the requested date. A completed outcome requires all 40 eligible future observed sessions; incomplete horizons remain pending | DATA PARTIAL | The PIT/read-only serving contract is complete. Rebuild under W3J, then add only approved model horizons and broader ranked-candidate depth |
| Stage screener serving | Indexed price-anchor pivot plus dated Stage snapshots | 12,437 investable rows on 2026-10-09 | Requested date resolves to latest snapshot on or before that date | DATA READY | Production is live; cold response and compact-payload reduction remain performance work |
| Stage transition scanner | US analytics `daily_snapshots` + `ohlcv_daily` + current `ticker_universe` labels | 49,409,559 snapshots; 1,193 changed tickers on 2026-10-09 | Transitions and liquidity are evaluated at each event date; missing stages are excluded without bridging; current active membership never filters history; Industry/Exchange filters are allowed only for the latest date | DATA READY | Production and authenticated friend access are verified; add effective-dated classification history before historical classification filters |
| Market momentum | US analytics `physical_momentum`, `daily_snapshots`, `ohlcv_daily` plus primary DB identity | 5,950 investable PMS rows on 2026-10-09; 5,936 with 6 Stage | Price, Stage and PMS/PFS/PES resolve on the requested date; current exchange and SIC metadata are omitted from historical views rather than backfilled | DATA READY | Production is live; retain the current fail-closed historical classification boundary |
| Sector and industry analysis | Primary DB current `US_SEC_SIC` classification joined to latest US analytics | 5,506 classified momentum rows; 10 broad groups including SIC-unknown; 388 four-digit SIC industries on 2026-10-09 | Latest date only; a selected historical date does not display, aggregate or filter by current classifications | DATA SUBSTITUTE | Add effective-dated SEC SIC history before historical sector/industry analysis |
| Trigger discovery | Deterministic US price/Stage/PMS serving with market-scoped saved definitions, evaluations and notification settings | Current and single-date search across 1D/2D/3D/5D/1W/2W/3W/5W/1M/2M/3M/5M; result mini charts use the same requested date; saved definitions and explicit latest-date evaluations are isolated from JP records | Search and chart anchors resolve on or before the requested date; current Exchange/SIC metadata is not used as historical evidence; loading a saved definition searches the latest date without creating an evaluation, and evaluation reuse keeps the existing signature contract | DATA READY | Add US period scans and effective-dated classification filters; current/single-date persistence is complete |
| MTF close calendar | Observed US dates in `market_ohlcv_daily` plus deterministic US exchange holiday rules | 6,754 regular-session dates from 2000-01-04 through 2026-10-09; all 12 D/W/M close boundaries and future projections are served. US TradingView Oracle `NASDAQ:AAPL` (1D, regular session, `America/New_York`) observed 2025-01-02 through 2026-10-13: 446 dates x 12 timeframes = 5,352 comparisons, 0 mismatches (fixture `PASS`) | Observed rows are used only inside their coverage; future dates are labeled projections, unscheduled closures are not invented, and anomalous holiday/weekend rows are excluded. Dates outside the Oracle period are rule projections, not observed Oracle results | DATA READY | None for the AAPL Oracle scope; no cross-symbol validation beyond AAPL is claimed |
| Watchlist quotes | Market-local quote APIs backed by canonical JP and US EOD stores | JP and US symbols can coexist in one current-market list; US rows expose adjusted-EOD semantics and USD | Quotes retain their own market date and currency; price discontinuities are not presented as daily returns | DATA READY | Current-market feature; no historical watchlist contract |
| Comparison and composite charts | Canonical JP daily OHLCV and adjusted US daily OHLCV | Up to four JP/US symbols in the comparison dock; same-market formulas and normalized comparison series | Each series preserves its market and corporate-action generation; mixed-market arithmetic fails closed without dated FX | DATA READY | Import daily USD/JPY before enabling mixed JP/US arithmetic |
| Chart drill | Canonical adjusted US daily OHLCV | US ticker presets and generated questions use adjusted open/high/low/close/volume | The selected candle and context window come from one adjusted generation with no current-data substitution | DATA READY | None for the current deterministic exercise contract |
| AI research | US price, Stage, PMS/PFS/PES, physical ML, similarity, universe identity and SEC SIC | Market-aware US research prompts and results; unsupported fundamentals, earnings and historical-anchor conditions remain visible | Router and tools reject JP-only filters and do not reuse JP data for a US request | DATA PARTIAL | Add approved PIT fundamentals and earnings sources before enabling those tools |
| PMS / PFS / PES | US analytics DB | 9,493 current-active symbols on 2026-10-13 | Latest row on or before requested date | DATA READY | Per-symbol missing reason |
| ML feature vectors | US analytics DB | 10,219 current-active tickers on 2026-10-13 | `as_of_date <= selected date` | DATA READY | UI and acceptance-metric parity |
| ML candidates | US analytics DB | 160 directional and 2,520 physics candidate rows on 2026-10-13 | `as_of_date <= selected date` | DATA READY | Broaden discovery wiring |
| Current similars | US analytics DB | 10,366 bases / 51,830 rows on 2026-10-13 | `as_of_date <= selected date` | DATA READY | US quality caveats |
| Universe identity | Tiingo metadata plus observed snapshots | 12,004 active; 21,981 total after the 2026-10-14 cutoff reconciliation; stale-active and non-investable-active violations both 0 | Historical membership comes from dated snapshots, not current `active`; current exchange / asset-type metadata may be shown only as reference and cannot filter historical results | DATA PARTIAL | Full successful universe refreshes now reconcile disappeared symbols and test-symbol exclusions. Add effective-dated exchange, asset-type, and delisting history before enabling historical metadata filters |
| SEC SIC classification | SEC submissions-derived `market_classifications` | 7,363 tickers; 6,888 active sector / 6,422 active industry | Current rows use sentinel `0000-01-01` and are not historical evidence | DATA PARTIAL | Add effective-dated history before historical filters |
| Shares outstanding | SEC Companyfacts `dei:EntityCommonStockSharesOutstanding` normalized in `normalized_financial_facts` | Normalizer and PIT-serving contract implemented; live US facts are not ingested yet | Filing date is stored conservatively at end-of-day UTC, so a date-only JST query can use the fact only from the following day | DATA PARTIAL | Configure the machine-local SEC operator contact and validate live coverage before replacing current-only universe shares |
| Earnings calendar | `market_earnings_calendar`, approved Finnhub contract | 0 US rows; machine-local credential not configured; scheduler absent | Historical query contract uses `imported_at` cutoff at the selected date and is fixture-tested | DATA BLOCKED | Configure the approved Finnhub credential outside Git, then validate ingestion and event UI before any Production scheduling |

W3J official-event evidence:

- RGC split-adjusted trading was scheduled for the 2025-06-16 market open in the
  [issuer announcement](https://regencellbioscience.com/regencell-bioscience-holdings-limited-announces-forward-stock-split/);
  the effected 38-for-1 split is also in the
  [SEC-filed release](https://www.sec.gov/Archives/edgar/data/1829667/000121390025054936/ea024581601ex99-1_regencell.htm).
- The [SEC QMMM suspension](https://www.sec.gov/enforcement-litigation/trading-suspensions/34-104113-ts)
  began on 2025-09-29. The [Nasdaq halt](https://ir.nasdaq.com/news-releases/news-release-details/nasdaq-halts-qmmm-holdings-limited)
  continued after the SEC window, and Nasdaq's
  [2026 delisting notice](https://ir.nasdaq.com/news-releases/news-release-details/correction-qmmm-holdings-limited-notified-anticipated-delisting)
  still described the security as halted.
- Production main `117c0af68d43df41266de3cd222d192131b30f51` is live as build
  `wbMosR9BI03lHvCNH4Du-`. The versioned policy is
  `us_market_data_quality_v1`; canonical Storage Guard passed and the final
  read-only Production smoke passed 169/169.
- Raw QMMM history remains immutable at 562 rows, including 263 zero-volume
  rows from the 2025-09-29 halt onward. The analytical database contains 299
  observed QMMM sessions through 2025-09-26 and zero post-halt rows across
  OHLCV, snapshots, technical/model features, forward labels and both ML
  feature generations. The RGC 2025-06-16 observed split session remains in
  both raw and analytical stores.
- Targeted QMMM regeneration restored 63 weekly rows, 721 technical signals,
  299 model/ML-v1/ML-v2 feature rows, 1,668 forward-return, forward-extrema,
  training-label and short-label rows, 518 RL-v1 states and 5,004 RL-v2
  states. Serving candidates remain absent until a normal current-date run
  selects them; stale candidates were not recreated.
| Financial statements | SEC Companyfacts normalized in `normalized_financial_facts` | Normalizer, idempotent importer, derived-quarter/LTM facts, API and five-view UI are implemented; Production has 0 verified US fact rows because `SEC_USER_AGENT` is not configured | Companyfacts has a filing date but no exact acceptance time; facts are deliberately unavailable on the filing date and become eligible the following JST date. Amendments retain their later filing boundary | DATA PARTIAL | Configure a machine-local SEC operator contact, run bounded ingestion, then audit US-GAAP/IFRS coverage before Production activation |
| Forecasts | Intended `financial_forecast_snapshots` | No verified US rows | Forecast publication time must be on or before selected date | DATA BLOCKED | Requires an approved forecast source and publication-timestamp contract |
| Dividends / splits | Tiingo EOD dividend records plus SEC Companyfacts cash-dividend and repurchase facts | Trailing dividend, observed zero, payout and buyback presentation are implemented and fixture-QA'd; live SEC repurchase coverage awaits ingestion | Price-date dividend history is used only through the selected date; a zero dividend is shown only when the EOD coverage spans the complete trailing year | DATA PARTIAL | Validate live Tiingo coverage and SEC repurchase facts after Companyfacts ingestion; split event semantics remain separate |
| Institutional ownership | Separate official SEC Form 13F data sets and Schedule 13D/G structured filings | 0 published rows; source contract implemented and fixture-tested | SEC filing acceptance timestamp; 13F requires evidence-backed CUSIP mapping and 13D/G requires the machine-local SEC operator contact | DATA BLOCKED | Complete CUSIP mapping evidence, configure the operator contact outside Git, ingest bounded fixtures/live samples and audit coverage |
| Insider activity | None approved for serving | 0 | SEC filing acceptance timestamp required | DATA MISSING | Consider Form 4 after ownership scope |
| Short interest | Official Nasdaq consolidated and corresponding NYSE short-interest products | 0 published rows; public FINRA OTC data and daily short-sale volume are explicitly excluded | Official publication date and twice-monthly schedule | DATA BLOCKED | Obtain licensed source access and usage rights, then validate listed-universe coverage |
| US sector hierarchy | SEC SIC | 5,506 / 5,950 latest momentum rows classified (92.5%); 9 named broad sectors and 388 four-digit industries | Current-only until effective dating exists | DATA SUBSTITUTE | Preserve taxonomy label; do not call it GICS; keep historical grouping fail-closed |
| Friend access | Cloudflare Access + read-only gateway | Authenticated US Dashboard, AAPL five-view Stock Detail, Transition, Trigger, Backtest, AI Lens, Market Momentum and Sector Analysis passed externally on Desktop; Dashboard, AAPL five views and the major analysis routes also passed at 390px | Same-origin GET/HEAD and explicit read-only JSON POST routes; mutations, AI sends, admin routes and protocol upgrades fail closed by route semantics | DATA READY | None for the current read-only scope |

## Rules

1. A current metadata value is never silently presented as point-in-time evidence.
2. A future filing, forecast, earnings import, ownership filing, or peer statistic is never used for a selected historical date.
3. Missing data remains unavailable; Claude and deterministic presentation code do not invent values.
4. US equivalents preserve the JP feature's analytical intent, not necessarily its Japanese regulatory label.
5. Paid, licensed, or legally ambiguous sources remain blocked until the user approves the source.

## W4 worktree evidence

- SEC Companyfacts is normalized into the shared financial fact contract without adding a schema
  migration. Approved US-GAAP concepts cover revenue, profit, EPS, balance sheet, cash flow,
  shares, dividends, repurchases and capex. Overlapping fallback concepts are deduplicated by
  filing context while non-overlapping history is retained.
- The PIT policy is intentionally conservative because Companyfacts exposes `filed` but not the
  exact EDGAR acceptance timestamp: a date-only JST analysis cannot see a filing until the next
  date. Amendment facts retain their own later filing boundary, and future filings are excluded.
- The US Stock Detail fundamentals workspace provides Summary, Performance, Financials,
  Valuation and Shareholder Return views. Forecasts, peer distributions and historical valuation
  ranges are explicitly unavailable; the UI makes no cheap/expensive or strength/weakness claim
  without an approved comparison basis.
- Missing, not meaningful and observed zero remain distinct. Negative earnings produce N/M rather
  than a zero PER; zero dividends are shown only after a complete trailing-year EOD coverage check.
  FCF combines matching-period cash flow and capex, and ROE uses LTM net income over average opening
  and closing equity.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented the local information hierarchy and
  completed one semantic revision. Codex fixture, PIT, calculation, UI-contract, JP financial
  timeline regression, typecheck, production build and 1440/1024/768/390 browser QA passed without
  page overflow, console error, failed request or duplicate fundamentals request.
- Live ingestion remains blocked only by the absent machine-local `SEC_USER_AGENT` operator contact.
  The batch fails before network or DB access when it is missing. No contact, credential, API key,
  SEC payload, fixture or Production DB row is stored in Git.

## W3 runtime evidence

- `/us/analysis/backtest` now provides a dated Historical Outcome Explorer ahead of the existing
  evaluation tables. It supports 5/10/20/40/60/90/200-session horizons, date stepping, ticker/name,
  exact Stage/signal, target and return-range filters, deterministic summary rates, pagination and
  expanded up/down outcome detail with price/Stage/evidence context.
- The explorer does not join current universe classifications into history. Exchange, SEC SIC sector
  and industry controls are omitted and rejected by the API. Missing outcomes stay unavailable,
  observed zero stays zero, null returns sort last, and generated narrative remains disabled.
- Canonical US market-calendar checks remove anomalous regular-holiday rows from coverage. Explicit
  holiday requests fail closed; implicit latest-date resolution also skips holiday rows. Live reads
  covered AAPL, JPM, CAT, XOM, JNJ, TSLA and RIVN, and a query plus full filtered summary completed in
  roughly 0.06 seconds against the 417 GB analytics database.
- Claude Opus (`claude.ai`, firstParty, Pro) implemented the product hierarchy and completed one
  screenshot-led responsive revision. Codex fixture/API/PIT tests, stock-detail regression, typecheck,
  production build and 1440/1024/768/390 browser QA passed with no page overflow, clipped context value,
  stuck loading state or application console error.
- W3J resolves the RGC/QMMM source-quality policy from official evidence. RGC remains an observed
  post-split market move; QMMM halt carries remain in raw Tiingo history but are not analytical sessions.
  The later W3J closeout completed the versioned cleanup, dependent rebuild and candidate gate and is
  live in Production. No value is clipped, winsorized or rewritten.

- The shared Watchlist now keeps JP and US quote semantics distinct, batches refreshes, pauses polling
  while hidden, and suppresses false daily returns around detected price discontinuities. The comparison
  dock enforces one global four-symbol limit without silently evicting an existing selection.
- US custom/composite charts and Chart Drill use adjusted OHLCV consistently, including adjusted
  intraday bounds and volume for split-sensitive exercises. US-only formulas are live; mixed-market
  arithmetic returns an explicit data-contract error because the current database has no daily USD/JPY
  rows, rather than combining incomparable JPY and USD values.
- AI Research recognizes US ticker syntax and market context, exposes supported price/Stage/momentum/
  similarity/SEC-SIC capabilities, and fails closed for JP-only filters, earnings, fundamentals and
  historical anchors. It never silently runs a US question against the JP universe.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) reviewed the shared-tool presentation and completed
  one bounded revision for dock clearance, mobile headings, Chart Drill context and control alignment.
  Codex dedicated tests, shared regressions, typecheck, build and 1440/1024/768/390 browser QA passed
  with no page-level overflow, console error, failed request or fixed-dock content occlusion.

- `/us/mtf-close-calendar` serves all 12 D/W/M close boundaries from observed US regular-session
  dates and extends beyond the data watermark with explicitly dashed holiday-rule projections.
  The page uses `America/New_York`, excludes extended hours, names observed coverage, and states
  that unscheduled closures are not projected.
- The US session loader starts at the shared 2000-01-04 bucket anchor, uses an indexed date walk,
  and filters anomalous weekend/regular-holiday source rows before building buckets. Current
  coverage contains 6,754 regular sessions through 2026-10-09.
- Shared JP bucket semantics remain unchanged. The existing JP Oracle fixture still passes 425
  dates x 12 timeframes = 5,100 comparisons with zero mismatches; this evidence is not presented
  as US-specific TradingView parity.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the market-local
  presentation and completed one bounded mobile count-label revision. Codex tests, typecheck,
  build, 1440/1024/768/390 browser QA and candidate read-only smoke passed 167/167.
- Main `164ecaa8d6f64d457b37b3c1f047ff66cdf56b11` was deployed as build
  `FivzkmcEB1yyMKBYEru1r`. Storage Guard/runtime audit passed, Production smoke passed 168/168,
  and Production browser QA passed at 1440 and 390 px without overflow, console errors or failed
  requests. The read-only gateway served the page/API with HTTP 200, rejected a mutation route,
  and Cloudflare Access continued to gate unauthenticated external traffic.
- W3I US Oracle: `NASDAQ:AAPL`, `1D`, regular exchange session, `America/New_York`, directly
  observed 2025-01-02 through 2026-10-13. 446 confirmed trading dates x 12 timeframes = 5,352
  comparisons; every timeframe (D through 5M) has zero mismatches. The US fixture
  `fixtures/mtf-close-calendar/tradingview-close-dates-us.json` is `PASS` and is independent of the
  JP fixture, which still passes 425 dates / 5,100 comparisons with zero mismatches.
- The only engine correction is New-Year week ownership: a week spanning New Year belongs to the
  year of its Monday, so US Dec 31 -> Jan 2 stays in one multi-week bar while JP year-end -> next
  Monday remains a close boundary. Dates outside each observed period remain rule projections, and
  no validation beyond AAPL is claimed. The US page and coverage strip no longer show `UNVERIFIED`.

- `/us/trigger-discovery` provides current and explicit single-date deterministic Trigger search,
  12 timeframes, Stage/status/MA-spread conditions, result filtering, sorting, pagination and
  same-date mini charts. Current classifications are never projected into historical queries.
- Market-scoped saved definitions, explicit latest-date evaluations, evaluation history and
  notification settings are implemented. The additive migration defaults existing rows to JP,
  all APIs scope by market, and US definition loads run a search without creating an evaluation.
  US period scans remain explicitly unavailable rather than reusing the JP historical workflow.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the US-local information
  hierarchy. Codex deterministic/API/UI tests, typecheck, build and multi-viewport browser QA
  passed. Candidate read-only smoke passed 164/164 after the canonical Large Holder state returned
  to CURRENT.
- Main `058a3843f2a2ab924377a21b5b0ca33838342bf9` was deployed as build
  `9tgwUia7mtxi-MoyTi8AS`. Canonical Storage Guard and runtime environment audit passed for every
  Production process; Production smoke passed 165/165 with health/storage healthy/available.

- `/us/market-momentum` reads price, 6 Stage and PMS/PFS/PES from the fresh US analytics DB, while identity and current SEC SIC context come from the primary DB. The 2026-10-09 latest view covers 5,950 investable rows and separates market pulse, breadth, Exchange, SEC broad sector and four deterministic momentum lanes.
- `/us/sectors` exposes the current SEC SIC taxonomy explicitly as a GICS substitute: 5,506 of 5,950 momentum rows are classified, with 138 SIC-unknown rows and 444 unmatched rows kept visible as coverage states. The current view ranks 9 named broad sectors and 388 four-digit SIC industries; small samples remain marked rather than silently dropped.
- Historical requests keep dated market momentum, price and Stage data, but current Exchange/SEC SIC values are not displayed, aggregated or used for filtering. The Sector route fails closed with an effective-dated-classification explanation instead of projecting today's taxonomy backward.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented the market-to-sector-to-industry hierarchy and completed one screenshot-led mobile revision. Codex browser QA covered 1440, 1024, 768, 390 and 1920 px with no body overflow, failed request or stuck loading state; dedicated read-model, UI-contract, navigation and regression tests passed.
- Main `34e65a469a3c34460da1139765c4592bf8b734d7` was deployed as build `f1Dx19LuuJj40tU6R3HKv`. Canonical Storage Guard preflight passed and Production read-only smoke passed 162/162; health/storage remained healthy/available. Production browser QA covered 1440 and 390 px with no body overflow, console error, failed request or stuck loading state. Cloudflare Access still gates the public host, the read-only gateway returned HTTP 200 for both new routes, and a write probe remained blocked with HTTP 405 `READ_ONLY_ACCESS`.

- `/api/us/hex?timeframe=daily` on 2026-10-12: HTTP 200, cold 4.81s, warm 0.02s, 11.94MB uncompressed / 2.21MB gzip. The current row contract repeats three always-null ML fields and duplicate sector aliases for every asset, while the cold query joins separate price anchors for each return horizon. Remove redundant transport fields first, then optimize the period-return query without changing return semantics.
- `/us/stage-screener`: 1440px and 390px browser smoke passed with no body overflow, console error, failed request, or HTTP error.
- `/us/analysis/transitions`: current distribution, all-history six-axis matrix, and 60-day pattern percentiles render. The matrix now separates neutral stage-maintenance cells from off-diagonal changes, and every current pattern drills into the dated scanner.
- The US Transition Scanner serves observed adjacent-snapshot events with period, exact/Any code, price, volume, turnover, sorting, pagination and ticker drill-down. A month `Any -> 111111` query returned 516 events in 0.99s server time; a current-day `Any -> Any` query returned 1,193 events in 1.21s. Production-mode browser requests were deduplicated to one API request.
- PIT enforcement does not filter historical events by current `active` membership. Current Industry/Exchange metadata may be displayed as reference, but classification filters are disabled in the client and rejected by the API for week/month/custom searches.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the change-focused hierarchy, off-diagonal matrix scale and compact mobile result list. Candidate browser QA passed at 1440, 1024, 768 and 390 px with no body overflow, console/HTTP error or stuck loading state; candidate read-only smoke passed 160/160.
- Main `b3d49be88d7c7885fc5f23bfb5c3a7ff3611435a` was deployed as build `g_ZGu4KOOKQSHow0h0AXl`. Canonical Storage Guard preflight passed; promoted-candidate and Production read-only smoke each passed 160/160, and Production health/storage remained healthy/available.
- Authenticated `stock.marketframe.jp/us/analysis/transitions` loaded both the 30-pattern overview and the 32-row current transition result through Cloudflare Access. Gateway regression confirmed safe reads while writes, admin routes and upgrades remain fail closed.
- `/us/analysis/backtest`: the interactive date/horizon/filter/detail workflow is implemented and QA'd;
  serving freshness, empty similarity evaluations and extreme secondary aggregate values remain
  explicit Production data gates.

## W2 runtime evidence

- US Dashboard latest and 2026-10-04 weekend requests resolved to 2026-10-09 and the prior US session 2026-10-02 respectively. The dashboard kept price, six-stage, candidate, and ML dates aligned, and historical stock links/previews preserved the resolved date.
- US Screener current and historical requests passed at 1440, 1024, 768, and 390 pixels with no body overflow, console error, failed request, or HTTP error. Historical current-only exchange, asset-type, SIC, and market-cap controls were removed before the analytical request, and no HTTP 422 occurred.
- Candidate browser timings on the warm local Production build were 0.58s for latest Dashboard, 0.42s for historical Dashboard, 1.37s for a 200-row uncached current Screener query, and 0.01s for the cached historical Screener query.
- Stock preview cross-check passed for AAPL, MSFT, NVDA, TSLA, and BRK-B. All had a 2026-10-09 price/stage date and six populated stage axes; BRK.B normalized to BRK-B in Screener search.
- Main commit `ba722f3cad9e7a8cb0237be055ac77019846d18d` was deployed as build `MLW5-_svrKcq3zQxHNNF6`. Canonical Storage Guard checks passed, both candidate and Production read-only smoke passed 160/160, and Production health/storage remained healthy/available.
- Authenticated `stock.marketframe.jp/us` and `/us/screener` loaded current US data through Cloudflare Access and the read-only gateway. The Screener returned 200 rows for 2026-10-09; the gateway regression confirmed safe reads are forwarded while writes, admin routes, and upgrades fail closed.
