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
- Short-interest serving requires licensed Nasdaq/NYSE exchange-product access; daily short-sale
  volume and FINRA's OTC-only API are not accepted substitutes.
- Institutional ownership is split into separate SEC 13F manager-position and Schedule 13D/G
  beneficial-owner products. Production remains blocked by evidence-backed CUSIP mapping and the
  machine-local SEC operator contact.
- The approved Finnhub earnings source remains blocked by the absent machine-local credential.
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
  because the latest main line also requires the W3J analytical cleanup, rebuild and candidate gate.

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

### W3H - Trigger Discovery cold-query optimization

- Monthly Trigger searches now resolve exact market month-end observations once, then build the same
  adjusted/raw close series with the existing deterministic MA engine. A candidate uses the optimized
  path only when every expected completed market month is present, the latest row matches its candidate
  price date, and no observation gap exceeds 60 days; otherwise it falls back to the unchanged legacy
  query. The public route contract, `maPath: generic`, Stage semantics, mini charts and cache behavior
  remain unchanged.
- Using `market_daily_snapshots` was explicitly rejected: its split heuristic and missing close column
  cannot prove bit-identical parity with the existing Trigger series. The chosen lookup remains grounded
  in canonical `market_ohlcv`, and the exact lookup uses the existing `(market, date, ticker)` index.
- Read-only canonical-data parity passed for 2026-10-13 MA20/25, 2026-10-01 MA15/20,
  2026-09-30 MA5/10 and 2024-03-01 MA3/25. The latest run compared 2,769 candidate observation maps,
  including 293 strict fallbacks, and reproduced all 109 matches, rejection counts and result ordering.
  A dedicated fixture also covers incomplete month ends, 60/61-day gaps, recent listings, stale anchors,
  null adjusted prices, empty rows, de-duplication and multiple MA-period pairs.
- Five fresh-process current searches completed in 5.846, 3.699, 3.786, 3.666 and 3.680 seconds
  (median 3.680 seconds), down from the original 9.852-second cold baseline. Warm route-cache behavior
  remains unchanged. EXPLAIN confirms the exact month-end lookup uses
  `market_ohlcv_market_date_ticker_idx` and the recent range uses
  `market_ohlcv_market_ticker_date_idx`.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) audited, implemented and completed a final read-only
  review. Codex verified fixture and canonical-data parity, error-path fallback, query plans, dedicated
  regressions, typecheck and build. No schema, source data, calculation, API or persistence change was
  introduced. The later W3J closeout completed the analytical cleanup, rebuild and candidate gate and
  promoted this path to Production.

### W3D - MTF Close Calendar

- `/us/mtf-close-calendar` now serves all 12 daily, weekly and monthly close boundaries using
  observed US regular-session dates from 2000-01-04 through 2026-10-09, with future dates shown as
  distinct holiday-rule projections in `America/New_York` market time.
- Source anomalies on weekends and regular exchange holidays are filtered before bucket creation.
  The shared bucket engine and JP route remain unchanged; the JP TradingView fixture still passes
  5,100 comparisons with zero mismatches.
- US-specific TradingView Oracle validation was not claimed in W3D. It was completed in W3I
  (below) for `NASDAQ:AAPL` only.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the local presentation
  and completed one mobile label revision. Codex tests, typecheck, build, multi-viewport browser QA
  and candidate read-only smoke passed 167/167.
- Main `164ecaa8d6f64d457b37b3c1f047ff66cdf56b11` is live as build
  `FivzkmcEB1yyMKBYEru1r`. Storage Guard/runtime audit passed, Production smoke passed 168/168,
  local Production browser QA passed at 1440 and 390 px, and the read-only gateway served both the
  page and API while mutation routes remained fail closed.

### W3I - US MTF TradingView Oracle

- US Oracle: `NASDAQ:AAPL`, `1D`, regular exchange session, exchange timezone `America/New_York`.
  The directly observed period is 2025-01-02 through 2026-10-13: 446 confirmed trading dates x 12
  timeframes = 5,352 TF-date comparisons. D, 2D, 3D, 5D, W, 2W, 3W, 5W, M, 2M, 3M and 5M each have
  zero mismatches (total 0). The committed fixture
  `fixtures/mtf-close-calendar/tradingview-close-dates-us.json` is `PASS`.
- The only engine correction is New-Year week ownership: a week spanning New Year stays attached to
  the year in which its Monday falls. US Dec 31 -> Jan 2 therefore remains inside one multi-week bar,
  while a JP year-end followed by the next Monday is still a close boundary. The JP `TSE:7203`
  fixture still passes 425 dates x 12 timeframes = 5,100 comparisons with zero mismatches.
- Dates outside each observed period are produced by the validated bucket rules and are labeled as
  projections, not as directly observed Oracle results. No cross-symbol validation beyond AAPL is
  claimed.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) replaced the US page notice and coverage-strip
  `UNVERIFIED` status with the exact validated scope, kept the existing component structure, and
  pinned the disclosed scope to the US fixture in the UI regressions. Feature commit `4a61d12a`
  was merged normally as `682ac7c6` and pushed to main. Production promotion remains pending
  behind the W3J analytical cleanup, rebuild and candidate gate.

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
- No clipping or winsorization was introduced. The current-active audit isolated two source events:
  RGC's 2025-06-16 post-split market session and QMMM's zero-volume repeated quotes beginning with the
  2025-09-29 SEC suspension and continuing under the subsequent Nasdaq halt. W3J resolves their policy
  without rewriting the primary source: RGC remains observed and QMMM halt carries are excluded only
  from the analytical copy. The later W3J closeout applied that versioned policy, rebuilt dependent
  analytics and passed the candidate gate for Production.
- Data-quality feature `78fda1f4f24cbb533c9a192fdc24ddcf20a5d5dd` was merged without conflict as
  `3a0c1209f93ad47f9b73be7db54f37c5a853e755` and pushed to main after dedicated data-quality,
  pipeline-generation, automation, backtest, analytics, market-intelligence and status-health tests,
  TypeScript, diff checks and the Production build passed. W3J subsequently resolved the source policy;
  its versioned analytical cleanup, rebuild and candidate gate subsequently completed in Production.

### W3J - Official-event analytical price policy

- Official evidence resolves both W3F edge cases. Regencell stated that RGC would begin trading on a
  38-for-1 split-adjusted basis at the 2025-06-16 open, and its SEC-filed release confirms the split.
  The observed 2025-06-16 volume and price move therefore remain analytical evidence. They are not
  clipped, winsorized or recast as a corporate-action error.
- The SEC suspended QMMM from 2025-09-29 through 2025-10-10. Nasdaq then announced that the halt would
  continue until its information request was satisfied; its 2026 delisting notice still described the
  security as halted. Tiingo's 262 zero-volume, unchanged rows from 2025-09-29 through 2026-10-13 are
  retained in raw `market_ohlcv_daily` but are not observed analytical sessions. A later positive-volume
  row is eligible automatically, so the rule does not manufacture a permanent end date.
- `lib/us-market-data-quality.ts` is the versioned policy registry. `build-us-analytics-db.ts` filters
  the US analytical OHLCV and Stage copy and removes prior ineligible base rows. The one-shot
  `maintenance:us-market-data-quality:{dry-run,apply}` task is US-analytics-role guarded, defaults to
  dry-run, preserves the primary database and clears only QMMM-derived analytical rows so the full
  model/evaluation/serving chain can be rebuilt from eligible observations.
- Focused unit, SQL-selection, temporary primary-to-analytics copy and maintenance apply regressions
  cover the RGC acceptance, QMMM exclusion, positive-volume recovery, raw-source immutability and
  dependent-row cleanup. The 2026-10-15 real analytics dry-run found 262 ineligible OHLCV rows,
  262 matching Stage snapshots and 25,316 total base/derived rows to replace, with raw-source writes 0.
  The approved apply, full dependent rebuild, candidate QA and normal deployment sequence subsequently
  completed under the W3J Production closeout below.

### W3G - Point-in-time ML prediction history

- US Stock Detail now reads prediction history from a market-specific, read-only endpoint instead of
  presenting an empty history. Each completed outcome is derived deterministically from the prediction
  date's adjusted close and the next requested number of observed US sessions; incomplete horizons stay
  pending and no outcome row is persisted.
- Historical requests are bounded by prediction date, prediction creation time, model training time and
  the requested price date. They never fall back to the JP prediction reader or use prices after the
  requested market date. The 2026-09-01 NIPG probe returned 23 eligible prediction rows and no completed
  outcome because the 40-session horizon had not matured by that date.
- The current analytics database contains 6,938 predictions across 43 dates and 783 tickers. All current
  rows use a 40-session horizon, with 3,473 up rows across 530 tickers and 3,465 down rows across 631
  tickers. `ml_prediction_outcomes` remains empty; completed cards are computed from read-only
  `ohlcv_daily` evidence at request time.
- Live evidence covered NIPG (65 rows: 5 completed, 60 pending), AEHL (56: 7 completed, 49 pending),
  NXTT (57 pending) and AAPL (no prediction history). The compact view deliberately keeps both the newest
  pending rows and the newest completed rows visible when both states exist, and reports expected-direction
  and opposite-direction threshold reach independently instead of collapsing a volatile path into a
  binary success label.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented the compact analytical presentation and one
  screenshot-led revision after Codex found that the first version hid matured outcomes. Dedicated PIT,
  outcome, read-only and row-selection tests, US Stock Detail/shared ML regressions, typecheck, parity
  audit and Production build pass. Browser QA covered NIPG, AEHL, NXTT and AAPL plus 1440/1024/768/390 px
  responsive checks with no component overflow or application console error.
- Functional and historical presentation parity is complete for the available prediction records, but
  source coverage remains `PARTIAL`: only one 40-session model horizon and ranked candidates are stored,
  rather than the full model/horizon depth of the JP experience. W3G itself made no Production deploy;
  the later W3J closeout completed the analytical gate and promoted the merged feature to Production.
- Feature `416b63c0d4f0bc47089bdc2b82806cdafeb255f9` was merged without conflict as
  `18e39f9df71292671f9f2c3c2873636558d58a5c`. Merge-head dedicated/shared regressions,
  parity audit, typecheck, diff checks and the Production build passed before the main push.

### W3J - Official-event analytical policy Production closeout

- Main `117c0af68d43df41266de3cd222d192131b30f51` is live as Production build
  `wbMosR9BI03lHvCNH4Du-`. Canonical Storage Guard and runtime identity passed; the final
  Production smoke passed 169/169 and the US route/API browser check had zero console errors.
- `us_market_data_quality_v1` preserves raw evidence and changes only analytical eligibility.
  Raw QMMM retains 562 rows including 263 zero-volume halt rows from 2025-09-29 onward. The
  analytical copy has 299 observed sessions through 2025-09-26 and zero post-halt rows across
  base price, snapshot, feature, label and RL tables. Future positive-volume QMMM trading remains
  automatically eligible. The observed RGC 2025-06-16 split session is retained in both stores.
- Targeted dependent regeneration restored QMMM weekly, technical, model, forward-outcome,
  ML-v1, ML-v2, training-label and RL rows without recreating stale serving candidates. Dedicated
  market-data, ML, analytics-generation, backtest, Stock Detail, route-state, automation, health,
  parity and TypeScript regressions all passed.

### W3K - Market-scoped Trigger persistence and regulatory source closeout

- Saved Trigger definitions and evaluations now carry an explicit `market` column with a `JP`
  default. The additive migration preserves every existing JP row and adds market-aware indexes;
  JP and US API reads and writes are scoped independently. Existing JP evaluation and run
  signatures deliberately remain unchanged because definition IDs are globally unique and market
  separation is enforced at the persistence and route boundaries.
- `/api/us/trigger-discovery/saved/**` now supports US definitions, rename, archive, explicit latest-
  date evaluation, evaluation history and notification settings. Loading a saved definition runs
  the ordinary latest-date search but never creates an evaluation automatically. The US UI keeps
  the existing result table/card representation and Mini Charts while exposing save, overwrite,
  save-as, rename, archive, evaluation history and notification controls.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) implemented and reviewed the US-local saved-trigger
  workspace. Codex corrected render-time state synchronization, retained JP signature compatibility,
  and verified market isolation, idempotent evaluation reuse, responsive behavior and application
  console safety. Dedicated US persistence and Trigger tests, JP saved/evaluation/notification
  regressions, TypeScript and Production build pass. Browser QA at 1440, 1024, 768 and 390 px
  returned 122 candidates with Mini Charts and zero body overflow or application console errors.
- Period scan remains a separate historical product and is not enabled for US. Historical
  Exchange/SIC filters also remain fail closed until effective-dated classification metadata exists.
- The W5 contract now selects official SEC Form 13F and Schedule 13D/G as separate ownership
  products and official exchange-reported short interest as the short-interest product. Publication
  remains fail closed under `BLOCKED_IDENTIFIER_MAPPING`, `BLOCKED_OPERATOR_CONTACT` or
  `BLOCKED_LICENSE`; no zero, estimate, issuer-name match or daily-volume substitute is published.

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
  Forecast consensus still requires a separately approved source. The fail-closed UI is included in the
  later W3J Production build, but live Companyfacts and forecast data remain blocked.

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
  `/us/stock/AAPL`; the public hostname remains protected by Cloudflare Access. A renewed authorized
  session completed the external matrix for Dashboard, AAPL Overview, Chart/6 Stage, Fundamentals,
  Scenario, Similar/ML, Transition, Trigger, Backtest, AI Lens, Market Momentum and Sectors.
  Desktop and 390px checks had no stuck loading state, page overflow, application error or console
  error. Gateway and UI-policy regressions reconfirmed safe reads while writes, AI sends, admin
  routes and protocol upgrades remain fail closed.
- Production promotion is not claimed in this wave. The latest main line also contains the W3F
  explorer whose serving data quality gate is still open, so the currently healthy Production build
  remains unchanged.

### W0F - Data freshness and coverage contract

- `/api/us/status` now returns deterministic OHLCV and eligible 6 Stage coverage together with the
  adjusted-price, classification and fundamentals source contracts. On 2026-10-13, OHLCV covers
  11,760 of 12,004 current-active investable symbols (97.97%, `PARTIAL`); 6 Stage covers all 11,741
  eligible symbols. Missing data remains `—`, specification-level non-applicability remains `N/A`,
  and US TradingView parity was kept `UNVERIFIED` rather than being inferred from the JP fixture.
  W3I later replaced that status with the `NASDAQ:AAPL` Oracle result (5,352 comparisons, zero
  mismatches); the strip now states one-symbol scope and defers period and counts to the page.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) designed and implemented a compact disclosure strip
  across Dashboard, Market Momentum, Sectors, Screener, Stage Screener, Trigger Discovery, AI Lens,
  Transition Scanner, Historical Outcome Explorer, AAPL Stock Detail and MTF Close Calendar. The
  strip reports source watermarks and accepted route limitations without replacing each route's
  existing AS OF or analysis-date display.
- A screenshot-led revision corrected the historical Screener explanation: current-only SIC,
  Exchange, asset-type and market-cap attributes are disabled and omitted on historical dates; the
  current values are not substituted. The existing client and API remain fail closed.
- Codex dedicated coverage/UI tests, Screener PIT/API/filter regressions, route-state, market,
  backtest, transition and Trigger regressions, typecheck and Production build pass. Browser QA
  covered all 11 routes at 1440 px and the shared/Stock Detail placements at 1440, 1024, 768 and
  390 px with zero whole-document horizontal overflow and zero application console warnings/errors.
  Ten warm/candidate `/api/us/status` requests returned HTTP 200 in 0.27-1.46 seconds.
- This wave did not change the then-current Production build. The later W3J closeout completed the
  analytical cleanup, rebuild and candidate gate and promoted the merged acceptance surfaces. No source
  value or business calculation changed in W0F.
- Git: feature commit `0bc4d029c06bf5cba772b2bcf54656ade05fe3a6`; normal merge commit
  `4efa85ebce7db4f3641c91d450202fa215e5322d` on the clean W0F integration worktree.

### W0G - Daily coverage SLA and reversible source availability

- The Tiingo daily runner no longer treats HTTP 200 empty arrays as successful tickers. Its run
  accounting distinguishes target-date coverage, empty responses, exact provider ticker-not-found
  responses, transient failures and deferred work. Empty, target-missing, temporary-not-found and
  blast-radius-held runs remain `partial`; only transient failures or deferred quota work make the
  command exit non-zero for the orchestrator retry path.
- The additive `market_source_availability` table records source status per US ticker. Only the
  exact Tiingo ticker-not-found 404 may advance terminal evidence, and promotion requires three
  chronologically increasing target dates in three increasing run IDs. Repeated attempts for the
  same target date do not advance it. A later non-empty response reverses a permanent
  classification; transient failures never erase it.
- A fail-closed promotion guard prevents a single provider incident from shrinking the effective
  denominator: by default, more than 25 newly eligible tickers or more than 0.25% of the active
  investable universe promotes none of them and retains the evidence for review. The limits are
  explicit environment overrides, not hidden constants in the scheduler.
- Coverage is now reported as both raw (`covered / active investable universe`) and effective
  (`covered / (raw universe - confirmed permanent exclusions)`) with permanent, pending,
  temporary and unclassified missing buckets. Publication and retry thresholds use effective
  coverage, while raw coverage remains observable in status and run telemetry.
- At W0G review time, the 2026-10-13 Production read-only baseline was 11,760/12,004, or 97.97% raw
  coverage, and Production did not yet contain the availability table. The later W3J deployment created
  the additive table without historical backfill; no ticker was pre-classified, so live runs begin the
  evidence history from observed source responses.
- Claude Opus 5.5 (`claude.ai`, firstParty, Pro) audited the state contract and implemented the
  bounded source changes. Codex corrected ambiguous-empty reversal and interrupted-run reason
  handling, then verified the pure state machine, temporary SQLite migration/store/SLA integration,
  automation contracts, coverage APIs, route states, typecheck and Production build.
- The later W3J closeout created the additive table through the approved deployment path and activated
  the runner contract. W0G itself performed no Production DB write or source reclassification.

### W0 - Loading, empty and error state contracts (main, PASS)

- Status: implemented and verified on `codex/us-parity-w0-route-states`, then merged normally to
  main. The board row is `IMPLEMENTED` with Codex QA `PASS` and Git `MAIN`; the later W3J closeout
  completed the analytical cleanup, rebuild and candidate gate and promoted these states to Production.
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
