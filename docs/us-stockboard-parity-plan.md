# US StockBoard JP Parity Program

Updated: 2026-10-13

The machine-readable source of truth is `docs/us-stockboard-parity-board.json`. Run
`npm run audit:us-jp-parity` after every wave. The data contract is maintained in
`docs/us-stockboard-data-source-matrix.md`.

## Dependency waves

| Wave | Scope | Gate |
|---|---|---|
| W0 | Inventory, persistent board, data contracts, PIT and future-leakage guards | Board validation, PIT tests, typecheck, build |
| W1 | Stock Detail technical workspace: overview, chart, 6 Stage, Stage History, momentum, scenario, similars | Claude browser review, multi-ticker, four viewports, semantic regression |
| W2 | Dashboard, Screener, Preview, Search, Historical date | Data parity, request/performance budget, historical cross-page parity |
| W3 | Earnings, transitions, backtest, AI, market momentum, sectors, triggers, MTF calendar | Source coverage, PIT, market-calendar and global milestone QA |
| W4 | Fundamentals, valuation and shareholder return | SEC fact contract and forecast-source stop condition |
| W5 | Institutional ownership and US-specific substitutes | Source/licensing approval, final closure loop |

## Current blockers

- Forecast consensus requires an approved source.
- Short-interest serving requires an approved/licensed source.
- Institutional ownership scope requires a product choice between 13F, 13D/G, and insider Form 4 views.
- Historical market cap requires point-in-time shares outstanding.
- Historical classification filters require effective-dated classification history.

These blockers do not stop technical, discovery, chart, Stage, scenario, ML, responsive,
performance, or historical-price parity work.

## Completed evidence

### W0 - PIT contract

- Main and Production: `230faeab1743acc31acbf93c3608d47deb2c244e`
- US screener requests use the explicit PIT contract and reject unsupported future data.
- Typecheck, production build, PIT contract tests, API PIT tests and Production smoke passed.

### W1 - Stock Detail technical workspace

- Claude Code `claude-opus-5-5` (`claude.ai`, firstParty, Pro) completed the editorial audit,
  implementation and final visual self-review.
- Overview, chart controls, current 6 Stage, Stage History, Physical Momentum/MA, scenario and
  similar-analysis presentation now share the JP analytical reading order without changing the
  underlying Stage, momentum, scenario or similarity calculations.
- Historical mode no longer substitutes the latest quote or a synthetic zero-percent move when
  the requested date is unavailable.
- Browser QA covered AAPL, JPM, CAT, XOM, JNJ, KO, TSLA, PLTR, RIVN and SOFI. AAPL was checked at
  1440, 1024, 768 and 390 px; page overflow, console errors, failed requests and duplicate ML
  status requests were all zero in the final run.
- Dedicated Stock Detail parity tests, relevant shared regressions, typecheck and production build
  passed. The W1 implementation is live in Production; authenticated friend-access stock-detail
  coverage remains tracked by the global access matrix.

### W2 - Dashboard, Screener, Preview, Search and Historical Date

- Main and Production code: `ba722f3cad9e7a8cb0237be055ac77019846d18d`; Production build:
  `MLW5-_svrKcq3zQxHNNF6`.
- Canonical Storage Guard preflight passed. Candidate and Production read-only smoke each passed
  160/160, with health healthy and storage available after the switch.
- Latest and historical Dashboard/Screener views passed at 1440, 1024, 768 and 390 px with no
  body overflow, console error, failed request or date leakage. Search and preview checks covered
  AAPL, MSFT, NVDA, TSLA and BRK-B, including BRK.B alias normalization.
- Authenticated friend access loaded current US Dashboard and 200-row Screener data through
  Cloudflare Access. Gateway regression passed for safe read forwarding and fail-closed writes,
  admin routes and upgrades; the full stock-detail and external mobile route matrix remains open.

### W3A - Stage Screener Serving and Transition Scanner

- Stage Screener serving now uses an indexed price-anchor pivot and a compact response contract.
  Candidate cold time is about 4.0 seconds for 12,437 rows; its roughly 10 MB plain payload remains
  a tracked performance residual rather than a closed parity claim.
- The US Transition Scanner now searches dated observed transitions without bridging missing Stage
  rows. It supports exact and Any paths, periods, liquidity filters, sorting, pagination and US
  ticker drill-down; current Industry/Exchange filters are fail-closed outside the latest date.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) completed implementation and screenshot self-review.
  Codex PIT, API, multi-viewport and performance QA passed, including one Production-mode request
  per scanner load and 160/160 candidate read-only smoke.
- Main `b3d49be88d7c7885fc5f23bfb5c3a7ff3611435a` is live as build
  `g_ZGu4KOOKQSHow0h0AXl`. Promoted-candidate and Production read-only smoke each passed 160/160;
  Production health/storage are healthy/available, and authenticated friend access loaded the
  overview and dated scanner data while the read-only gateway continued to fail closed on writes.

### W3B - Market Momentum and SEC SIC Analysis

- A shared deterministic read model now combines fresh US analytics price, Stage and PMS/PFS/PES
  with primary-DB identity and latest SEC SIC metadata. Indexed date anchors keep the latest live
  read near two seconds instead of scanning the full analytics history.
- `/us/market-momentum` provides market pulse, breadth, Exchange and SEC broad-sector context,
  deterministic initial/continuation/stall/drop lanes, a compact comparison table and historical
  date mode. Current classifications never leak into historical aggregation or filtering.
- `/us/sectors` reads from SEC broad sector to four-digit SIC industry with coverage states,
  metric switching, map/ranking views and Screener drill-down. The UI names SEC SIC explicitly and
  does not present it as GICS; historical sector/industry analysis fails closed until an
  effective-dated classification source exists.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) designed and implemented the local hierarchy and
  completed screenshot-led mobile refinement. Codex typecheck, deterministic data/UI contracts,
  navigation regression and 1440/1024/768/390/1920 browser QA pass.
- Main `34e65a469a3c34460da1139765c4592bf8b734d7` is live as build
  `f1Dx19LuuJj40tU6R3HKv`. Canonical Storage Guard passed, Production read-only smoke passed
  162/162, and Production browser QA passed at 1440 and 390 px. Cloudflare Access still gates the
  public host; the read-only gateway serves both routes and rejects writes with
  `READ_ONLY_ACCESS`.

### W3C - Trigger Discovery

- `/us/trigger-discovery` now exposes deterministic current and single-date Trigger search across
  all 12 supported timeframes, with Stage/status/MA-spread conditions, result filtering, sorting,
  pagination and requested-date mini charts.
- Historical Exchange/SIC filtering remains fail closed because the available classification rows
  are current-only. Saved Trigger definitions, evaluations, notifications and period scans remain
  unavailable until the JP-only persistence schema receives an explicit market-scoped migration.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the US-local hierarchy.
  Codex dedicated tests, typecheck, build and 1440/1024/768/390 browser QA passed; candidate
  read-only smoke passed 164/164.
- Main `058a3843f2a2ab924377a21b5b0ca33838342bf9` is live as build
  `9tgwUia7mtxi-MoyTi8AS`. Storage Guard/runtime audit passed and Production smoke passed 165/165
  with health healthy and storage available.

### W3D - MTF Close Calendar

- `/us/mtf-close-calendar` now serves all 12 daily, weekly and monthly close boundaries using
  observed US regular-session dates from 2000-01-04 through 2026-10-09, with future dates shown as
  distinct holiday-rule projections in `America/New_York` market time.
- Source anomalies on weekends and regular exchange holidays are filtered before bucket creation.
  The shared bucket engine and JP route remain unchanged; the JP TradingView fixture still passes
  5,100 comparisons with zero mismatches.
- US-specific TradingView Oracle validation is intentionally not claimed. Exporting a US Oracle
  CSV/fixture and requiring zero mismatches is the only remaining MTF parity item.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the local presentation
  and completed one mobile label revision. Codex tests, typecheck, build, multi-viewport browser QA
  and candidate read-only smoke passed 167/167.
- Main `164ecaa8d6f64d457b37b3c1f047ff66cdf56b11` is live as build
  `FivzkmcEB1yyMKBYEru1r`. Storage Guard/runtime audit passed, Production smoke passed 168/168,
  local Production browser QA passed at 1440 and 390 px, and the read-only gateway served both the
  page and API while mutation routes remained fail closed.

### W3E - Shared Watchlist, Comparison, Charts, Drill and AI Research

- Watchlist rows preserve JP/US market labels, dates and currencies, pause polling in hidden tabs,
  batch quote reads and do not turn corporate-action discontinuities into false daily returns.
- The shared comparison dock has one deterministic four-symbol limit across both markets. Same-market
  custom formulas use canonical JP prices or adjusted US OHLCV; mixed-market arithmetic fails closed
  until dated USD/JPY data exists.
- Chart Drill now supports an explicit US mode and builds questions from one adjusted OHLCV generation.
  The US header, presets, exercise copy, selected candle and answer history remain market-local.
- AI Research recognizes dotted and dashed US tickers, reports the available US analytical tools and
  rejects JP-only universe filters. Missing US fundamentals, earnings and historical anchors remain
  explicit limitations rather than JP fallback or invented evidence.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) completed implementation review and one screenshot-led
  refinement. Dedicated/shared regressions, typecheck and build pass; browser QA at 1440, 1024, 768
  and 390 px found no page-level overflow, failed request, console error or fixed-dock occlusion.
- Git integration, Production candidate smoke and friend-access verification remain the W3E release gate.
