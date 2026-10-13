# US StockBoard JP Parity Program

Updated: 2026-10-14

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
- Live historical market cap activation requires SEC Companyfacts ingestion; the point-in-time shares contract is implemented but the machine-local SEC operator contact is not configured.
- Historical classification filters require effective-dated classification history.
- The current main candidate cannot serve the JP integrated Screener for 2026-10-14 because no
  Valuation Serving snapshot is available on or before that date. Production remains healthy;
  promotion is held until the candidate data gate is restored.

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

### W1 - Global navigation and market switching closure

- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) consolidated JP, US and commodity switching into
  one explicit route contract without mapping ticker identities across markets.
- Counterpart routes cover dashboards, momentum, sectors, MTF, screeners, Stage screeners,
  Trigger Discovery, AI research, MA Lens, transitions, backtests and chart drill. Shared and
  market-only routes fail conservatively to the target market home.
- Codex verified all 13 routing cases, keyboard focus, and JP-US-JP browser navigation. Browser QA
  passed at 1440, 1024, 768 and 390 px with one switch, one active market, zero body overflow and
  no Header-originated console or HTTP errors.
- Production promotion remains pending because the latest main candidate's JP integrated Screener
  is blocked by the separate Valuation Serving availability gate documented above.

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
- Feature `dbe70d1a292fa0f2cf96ef1dcf2726e39b51ea22` was merged without conflict and pushed to
  main as `83df80507149c2f6300182f89d00f7089f5067f8`. Merge-head typecheck, dedicated/shared
  regressions, parity audit and Production build passed.
- The pre-existing Storage Guard incident `f17df02e-9e3f-4bb7-9f50-ffa66e50220e` was formally
  reviewed and resolved after 21 stable identity observations. JP daily serving and the certified
  Large Holder snapshot were advanced to 2026-10-13 before the Production switch.
- W3E is live on main `b3f8624995bbac54a5147a573826a20005068c08` as build
  `I6Vw12p7dc0aYGzyP6Z1o`. Runtime topology and Storage Guard passed, Production smoke passed
  168/168, and browser QA found no page-level overflow or console error at 1440 and 390 px. A
  Chart Drill grid auto-minimum-width issue found during Production QA was fixed and protected by
  a regression assertion before the final deploy.

### W3F - Historical Outcome Explorer

- `/us/analysis/backtest` now starts with an interactive historical outcome explorer backed only by
  dated `serving_backtest_results`. It supports seven completed-outcome horizons, regular-session
  date selection, exact Stage and signal filters, outcome/return filters, deterministic summaries,
  pagination and expanded price/Stage/evidence detail. The existing model, physics, RL and similar-
  evaluation tables remain secondary and are not mixed into the explorer result set.
- Historical Exchange, sector and industry filters remain deliberately omitted because the available
  classification metadata is not effective-dated. Missing outcomes remain unavailable, observed zero
  remains zero, and no generated narrative or current-classification fallback is added.
- US holiday rows are excluded with the canonical market calendar. Explicit holiday queries fail
  closed, and implicit latest-date selection skips anomalous holiday rows. The 40-session view exposes
  224 regular-session dates from 2025-07-25 through 2026-06-15; the underlying market watermark is
  2026-10-12, so serving refresh remains a data gate rather than a UI parity gap.
- Claude Opus (`claude.ai`, firstParty, Pro) designed and implemented the local hierarchy and completed
  one screenshot-led 768px context-bar revision. Codex fixture/API/PIT tests, stock-detail regression,
  typecheck, production build and 1440/1024/768/390 browser QA pass with no page-level overflow,
  clipping, stuck loading state or application console error.
- Feature `e5015a5aabb18a520111a1f2acbfcf69a5fcfabb` was merged without conflict and pushed to
  main as `4f3cb53fe61b17647000f90d5ff7be8101e507c2`. Merge-head dedicated/shared regressions,
  parity audit, typecheck and Production build passed.
- Production activation remains pending. The historical explorer itself is QA-complete, but stale
  serving coverage, empty similarity evaluations and pre-existing extreme secondary model/RL values
  require source-pipeline review before a candidate can be promoted.

### W4 - Fundamentals, Valuation and Shareholder Return

- SEC Companyfacts now maps approved US-GAAP concepts into the shared normalized financial fact
  contract and reuses the existing quarter/LTM derivation engine without a schema migration. The
  importer is bounded, rate-limited and requires a machine-local operator contact before any SEC
  request or DB access.
- Historical serving is fail closed. Companyfacts lacks an exact EDGAR acceptance time, so filing
  dates are conservatively eligible only from the following JST date; later amendments keep their
  own publication boundary. Current-only universe shares are not used as historical valuation
  evidence.
- US Stock Detail now has five fundamentals views: Summary, Performance, Financials, Valuation and
  Shareholder Return. Missing, N/M, N/A and observed zero are distinct; forecasts, peer valuation
  and historical valuation ranges remain visibly unavailable instead of being inferred.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented the local presentation and completed
  one semantic revision. Codex SEC normalization/PIT, calculation, UI-contract, JP timeline
  regression, typecheck, production build and 1440/1024/768/390 browser QA passed, including loss,
  negative cash flow, zero dividend and partial-coverage fixtures.
- Feature `27b6ec3e2a925446fdd44a2dce3f645379ae1272` was merged without conflict and pushed to
  main as `084d296502da11f1c4baab02988117588d7dc742`. Live activation remains data-blocked:
  Production contains no verified US Companyfacts rows and `SEC_USER_AGENT` is not configured.
  Forecast consensus still requires a separately approved source. No Production deploy is claimed.

### W0F - Global acceptance matrix

- The current US route inventory was exercised at 1440, 1024, 768 and 390 px: Dashboard,
  Screener, Stage Screener, Transition Scanner, Historical Outcome Explorer, Market Momentum,
  Sector Analysis, Trigger Discovery, MTF Close Calendar, AI Lens and the AAPL Stock Detail
  overview/fundamentals/chart entry states. The 52 route-width checks finished without a fatal
  render, stuck loading state or application console error.
- Claude Opus (`claude.ai`, firstParty, Pro) completed two bounded presentation reviews. The US
  sector tables now keep numeric columns stable, show long SIC names on at most two lines and fit
  the 768 px content boundary. The Dashboard breadth labels and ML reference date no longer clip.
  Codex re-measured all four widths; whole-document horizontal overflow is zero.
- The friend read-only gateway now recognizes the two US Trigger Discovery JSON POST endpoints as
  read transports. Search and Mini Chart reads are forwarded, while saved definitions, mutations,
  private/admin paths and protocol upgrades remain fail closed. Gateway, UI-policy and US Trigger
  regression tests pass.
- Direct Production and the loopback gateway returned HTTP 200 for health, `/us` and
  `/us/stock/AAPL`; the public hostname redirected an unauthenticated request to Cloudflare Access
  as required. The authenticated external stock-detail/mobile route matrix remains open because the
  browser Access session had expired; authentication was not bypassed or re-created by the audit.
- Production promotion is not claimed in this wave. The latest main line also contains the W3F
  explorer whose serving data quality gate is still open, so the currently healthy Production build
  remains unchanged.
