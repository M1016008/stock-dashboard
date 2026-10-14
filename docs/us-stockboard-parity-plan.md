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
- A 2026-10-14 recheck confirmed JP Valuation Serving through 2026-10-13 (4,201 tickers) and a
  completed 4,634-row Integrated Screener serving date. Production promotion remains pending only
  because the latest main line also contains the shared W3F source-data gate documented below.

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
- The Stage Screener client now requests the explicit `us-hex-columnar.v1` transport while the
  legacy and `compact=1` row contracts remain intact. On the 12,451-row live dataset, decoded JSON
  fell from 10.05 MB to 3.90 MB (61.1%) and gzip transfer from 2.15 MB to 1.61 MB (25.1%).
  Legacy-versus-decoded rows matched exactly, including null, zero and negative values. Browser QA
  at 1440, 1024, 768 and 390 px passed with one data request and no overflow or runtime errors.

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
  closed, and implicit latest-date selection skips anomalous holiday rows. The 2026-10-14 full replay
  rebuilt all seven completed-outcome horizons against the current active universe: mature-through
  dates are 2026-10-05 (5), 2026-09-28 (10), 2026-09-14 (20), 2026-08-14 (40), 2026-07-17 (60),
  2026-06-03 (90), and 2025-12-23 (200). Similarity evaluation now contains 101 dated rows across
  the 5/10/20/40-session horizons instead of an empty table.
- Claude Opus (`claude.ai`, firstParty, Pro) designed and implemented the local hierarchy and completed
  one screenshot-led 768px context-bar revision. Codex fixture/API/PIT tests, stock-detail regression,
  typecheck, production build and 1440/1024/768/390 browser QA pass with no page-level overflow,
  clipping, stuck loading state or application console error.
- Feature `e5015a5aabb18a520111a1f2acbfcf69a5fcfabb` was merged without conflict and pushed to
  main as `4f3cb53fe61b17647000f90d5ff7be8101e507c2`. Merge-head dedicated/shared regressions,
  parity audit, typecheck and Production build passed.
- The source-pipeline audit found two separate causes behind the former extreme aggregates. Expired
  and test symbols remained active because a successful Tiingo refresh only upserted returned rows;
  full successful refreshes now reconcile the complete US universe with the existing 14-day activity
  and investable-symbol contract. Operational model, physics, RL, similarity and serving evaluation
  queries are explicitly scoped to `current_active`, while raw historical price and label rows remain
  untouched. The weekly optimizer also preserves the primary StockBoard DB as
  `STOCKBOARD_SOURCE_DB_PATH` when child ML jobs switch `STOCKBOARD_DB_PATH` to the US analytics DB.
- The final 2026-10-14 universe reconciliation leaves 12,004 current-active rows out of 21,981 total,
  with zero stale-active and zero non-investable-active violations. The 2026-10-13 serving delta now
  contains 10,366 regular feature bases, 10,219 current-active physics feature rows, 2,520 physics
  candidates and 51,830 similar rows; the pipeline generation watermark is also 2026-10-13.
- Weekly rolling physics retraining intentionally starts from its bounded evaluation window. Baseline
  verification now treats the recorded generation payload as the immutable proof of the completed
  one-time full-history run while continuing to validate current model coverage, feature dates, feature
  set and adjusted-price basis. This removes the false failure that required every later rolling model
  to retain the 1990 baseline start date. A regression covers rolling models and missing baseline proof.
- No clipping or winsorization was introduced. Current-active audit still identifies genuine/provider
  edge cases: RGC has a Tiingo adjusted-price discontinuity around its corporate-action history, and
  QMMM has a very large observed move followed by zero-volume repeated quotes. These rows match the
  primary source and analytics copy, so changing or quarantining them is a source-of-truth policy
  decision rather than a calculation repair. Historical Explorer Production activation therefore
  remains pending even though stale serving coverage, empty similarity evaluation, and scheduler-path
  defects are resolved.

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

### W0 - Loading, empty and error state contracts (main, PASS)

- Status: implemented and verified on `codex/us-parity-w0-route-states`, then merged normally to
  main. The board row is `IMPLEMENTED` with Codex QA `PASS` and Git `MAIN`; Production remains
  `PENDING` behind the shared W3F source-data gate.
- Blocking findings from the visual review (scope of the final bounded revision):
  - Stage map (US and the shared JP component): during loading or error, the header count, the six
    Stage summary cells, the `未算出` cell and the `全投資対象（0）` option showed `0`, which looked
    like a real result. The error alert sat below the summary grid, filter bar and legend, so it
    was below the fold at 390 px. There was no retry.
  - MTF calendar: `条件に該当 0営業日` was shown while loading or failed. The alert sat in the body
    below the filter rows.
  - US Screener: the alert sat below the expanded filter panel, and the as-of badge still read a
    green `最新データ` next to the failure.
- Revision (display only; fetching, wire formats, filters, Stage/PMS semantics, PIT/422 behavior
  and normal-state counts are unchanged):
  - Stage map: `countsReady = !loading && !error`. While not ready, the header reads
    `件数を確認中` / `件数を取得できませんでした`. Stage cell counts, average PMS, the `未算出` count
    and every select option count show `—`, the `未算出` caption shows `確認中` / `取得失敗`, and the
    US universe/coverage footnote is hidden. The alert now sits directly under the heading, above
    the summary grid. It has a `再試行` button that bumps `retryVersion`, which re-runs the same
    fetch effect once per click. Loading, error and empty stay mutually exclusive.
  - MTF calendar: the header reads `条件に該当 確認中` / `条件に該当 取得失敗`. The single alert and
    the `再読み込み` button moved directly under the month header, above the filter rows, and the
    body is not rendered on error, so there is no duplicate. The rules-only notice and normal
    layout are unchanged.
  - US Screener: the alert and `再試行` moved directly under the result-count status row, above the
    applied-filter chips and the expanded filter panel. `fetchError` now takes precedence in the
    as-of badge (`取得失敗`, red), and the resolved AS OF date stays visible as context.
  - Browser audit: the empty-date case waits until the loading copy and `aria-busy` are gone and
    the empty text is actually rendered, then rechecks after 400 ms. Stage/MTF failure cases assert
    that the alert is fully inside the viewport, that no `0 投資対象`, `全投資対象（0）`,
    `条件に該当 0` or bare `0` appears in visible `main` text, and that the non-numeric state label is
    visible. The Screener case asserts that the alert sits above the filter panel's search input
    and that `最新データ` is not shown. All retry cases (now including both Stage maps) require
    exactly one additional request with the same URL per click. The Stage cases pass the
    `available-dates` request through, so only the map request is counted. The audit still uses
    only CDP response replacement, with no product fixture or query switch.
  - Source contract: `test:us-route-states` enforces the placeholders, the retry wiring, the
    failure-first badge, a single `role="alert"` per component, and the source order (alert before
    the Stage summary grid, before the MTF filter rows, and before the Screener filter panel and
    table). It also forbids the raw count expressions that produced the false zeros.
- `app/us/error.tsx` is now the shared Error Boundary for uncaught failures under `/us`. Before
  this, those failures fell through to `app/error.tsx`, whose only link returned to the JP
  dashboard. The boundary keeps the global header and navigation, replaces only the page body,
  and renders `components/us/UsRouteErrorState.tsx`. That component takes only a digest and a
  retry callback, so exception messages and stacks cannot reach the DOM. A digest is shown only
  if it is 1-64 alphanumeric/`_`/`-` characters. The only action is one native `再試行` button,
  which calls Next 16's `retry()` (re-fetch and re-render). There are no links, query-string
  switches, environment branches or fixtures. The boundary logs only through
  `logUsRouteError(error.digest)`, which writes a fixed `[us-route-error]` label and the safe digest
  (or `no-digest`) to the console. It never logs the exception object, message or stack.
- State contract decisions:
  - Loading uses `role="status"` / `aria-busy`. `app/us/loading.tsx` covers the whole subtree,
    and route-level skeletons or in-page indicators are more specific. The Stage map's in-page
    `読み込み中…` block now has the same status semantics.
  - Empty and unavailable stay explanatory (`EmptyState`, `未生成`, `未取得`, PIT-unavailable
    notices) and never use `role="alert"`. Missing values still render as `-`, `未取得` or
    `Number.NaN`, never as zero.
  - Expected failures are handled on screen with `role="alert"` and fixed copy, with a retry action
    where the route has one (Dashboard sections, Market Momentum, Sectors, Trigger Discovery,
    Transition Scanner, Historical Outcome Explorer, Stock Detail fundamentals, Screener, MTF
    calendar). API messages and exception text are not rendered.
  - Unexpected or uncaught failures go to the shared boundary. These cover Dashboard and Screener
    as-of resolution, Transition overview, Backtest evaluations, AI Lens (boundary only) and the
    Stock Detail quote/earnings preload.
- Shared-component fixes from Codex review, before the visual-review revision above (these affect
  JP and US only through error/loading accessibility and safe copy):
  - Stage map (`components/hex/HexStageMapView.tsx`): the error block is `role="alert"` with the
    fixed text `トレンドステージマップを取得できませんでした。…`. The fetched error string is kept in
    state only as a failure flag and is never rendered. The loading block is `role="status"`
    with `aria-busy`. Loading, empty and error stay mutually exclusive as before.
  - MTF calendar (`app/mtf-close-calendar/MtfCloseCalendarClient.tsx`): the error state is now a
    boolean. The message is a `role="alert"` paragraph with fixed copy, and the existing
    `再読み込み` retry and the US rules-only notice (`rulesOnly && !error`) are unchanged.
  - US Screener (`app/us/screener/UsScreenerClient.tsx`): API failures go into a separate
    `fetchError` state (`pit` for HTTP 422, otherwise `failed`) instead of the no-results
    `message`. A `role="alert"` with fixed copy and a `再試行` button renders above the
    horizontally scrolling table, so it stays reachable at 390 px. The no-results cell is
    hidden while the error shows, the result count reads `取得失敗` instead of `0件`, and the
    as-of badge reads `取得失敗` instead of `データなし`. The 422 copy and the PIT filter
    locking are unchanged. Successful zero-row responses still map only the two known API
    messages (snapshots not generated, no snapshot on or before the date) to Japanese copy. Any
    other message falls back to the standard no-results text and is not shown verbatim.
- Stock Detail correction: the earlier residual ("quote failure shown as not found") was wrong.
  `getUsQuote` exceptions in `app/us/stock/[ticker]/page.tsx` are not caught there, so they
  reach `app/us/error.tsx`. A `null` quote means there is no daily data yet, which is a real
  no-data state. The page then passes only fixed copy as `initialError`. The page always passes
  `initialQuote` or `initialError`, so the client-side quote refetch never runs on this route.
  The test now checks this as part of the empty contract. Stock Detail code is unchanged.
- `npm run test:us-route-states` lists all 13 entrypoints and fails if any `app/us/**/page.tsx` is
  missing from the inventory. It checks each entrypoint's loading, empty and error branches, and
  it checks forbidden patterns that would render raw failure text in the Stage map, MTF
  calendar and Screener. It rejects error boundaries under `/us` that read
  `error.message`/`stack`/`cause`, log the error object, or use environment or query switches. It
  also renders the boundary with a secret-bearing exception to prove no raw text, exactly one
  keyboard-operable retry button, an alert region and no navigation link. It spies on the console
  to show that only the fixed label and a safe digest are logged. It needs no DB, network or
  browser. Mutation checks confirmed that each of these fails the test: logging the error
  object, rendering the raw Stage map or MTF error, dropping any of the three new alert roles or
  the Stage map loading status, showing the Screener no-results cell during an error, unwiring
  Screener retry, and echoing an unknown Screener API message. Earlier mutations (rendering the
  message, an unsanitized digest, deleting the boundary) still fail it as well.
- Deterministic verification: `test:us-route-states`, the full TypeScript typecheck
  (`tsc --noEmit`), `test:us-screener-pit`, `test:us-screener-filters`,
  `test:us-stock-detail-parity`, `test:us-hex-serving`, `test:mtf-close-calendar`,
  `scripts/test-us-stage-screener-transport.ts` and `scripts/test-us-mtf-close-calendar-ui.ts`
  pass. The webpack Production build also passes with the canonical read-only storage contract.
- Final deterministic verification after the bounded revision: `test:us-route-states`, the full
  TypeScript typecheck (`tsc --noEmit`), `test:us-screener-pit`, `test:us-screener-filters`,
  `test:us-stock-detail-parity`, `test:us-hex-serving`, `test:mtf-close-calendar`,
  `scripts/test-us-stage-screener-transport.ts` and `scripts/test-us-mtf-close-calendar-ui.ts`
  all pass. The webpack Production build also passes with the canonical read-only storage
  contract.
- `npm run audit:us-route-states-browser` uses Chrome DevTools Protocol and a loopback candidate;
  it does not add a product query switch or fixture route. It replaces only the selected browser
  API response with a 503 payload containing a sentinel secret and verifies that the sentinel
  never reaches the page or console. The final run passed 12 browser cases:
  - US Screener, US Stage Screener and US MTF Calendar at 1440 and 390 px;
  - the shared JP Stage Screener and JP MTF Calendar at 1440 px;
  - a real Screener no-data date at 1440 and 390 px, with no alert semantics;
  - the shared US Error Boundary at 1440 and 390 px against an isolated invalid US analytics DB.
  Error/empty states were mutually exclusive, document overflow was zero, and each Screener,
  Stage-map and MTF retry issued exactly one additional request to the same URL. No raw API
  message or DB path appeared. The boundary exposed one retry action, no navigation link, and
  keyboard focus produced a solid 3 px outline. Its screenshot is captured before keyboard
  traversal so the global search popover cannot obscure the boundary; reachability is asserted
  separately after capture.
- Normal candidate browsing of US Screener, US/JP Stage Screener and US/JP MTF Calendar passed
  cold and warm runs (10 audits total): HTTP/request failures, duplicate application requests,
  console errors and layout overflow were all zero. The healthy Production service was not
  changed during this QA.
- Claude Opus 5.5 performed the final read-only visual review of the revised 1440/390 screenshots.
  Its initial FAIL was traced to the audit's post-Tab screenshot ordering, not the product UI; after
  capture was moved before keyboard traversal, the clean boundary screenshot received `PASS` with
  no remaining visual blocker.
