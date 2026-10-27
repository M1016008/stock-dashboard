# US StockBoard parity validation — 2026-10-26

Implementation evidence revision: `c5ebfa9947f42998b5aade109bf5c918dcba595b`

Framework integration revision: `68d7ec2ac1e18311fad3443c159b29498b67d838`

## Current-revision deterministic verification

- The complete deterministic feature chain through the parity-auditor
  self-test: PASS at the evidence revision above. This includes UI contracts,
  route states, Period Explorer, Daily Close, Trade Workbench, Monthly MA,
  earnings, sector ETF, SEC Companyfacts, fundamentals, screener PIT/API PIT,
  HEX, friend read-only, SEC EDGAR, and the disconnected FMP adapter. The final
  board audit is run after the generated board is sealed to a later commit.
- `npm exec -- tsc --noEmit --pretty false`: PASS.
- Storage Guard fixture regression: PASS. No Production connection or state
  change was used.
- Claude Code final static review, focused re-review, and screenshot-led UI
  closeout: P0 0 / P1 0. The final revision removes the Card padding conflict,
  presents Trade Workbench failure reasons without internal codes, distinguishes
  Monthly-MA loading from failure, and restores the compact mobile metrics that
  remain visible in the desktop table.
- Parity board audit: PASS; 29 `IMPLEMENTED`, 14 `PARTIAL`, 7 `BLOCKED`,
  0 `MISSING`, 0 `UNVERIFIED`, and 1 `NOT_APPLICABLE` across 51 capabilities.
- Isolated Production build at the framework integration revision: PASS in
  GitHub Storage Guard CI run `40329714561`. The poisoned-environment build,
  TypeScript, Storage Guard, SMA Dynamics, US automation, and JP/US parity
  contracts all passed against the exact revision.
- Final local regression at the implementation evidence revision: PASS for
  `test:us-parity:targeted`, all 15 SMA Dynamics suites, Storage Guard fixtures,
  TypeScript, and an isolated Next.js 16.4.3 Production build.
- Browser QA at the framework integration revision covered 55 routes at 1440,
  1024, 768, and 390 px: 208/220 PASS. The 12 non-passes are three JP
  real-data-dependent routes at four widths in an empty isolated runtime and
  remain `NOT_TESTED`, not failed parity claims. All US/shared routes required
  for PR #21 passed without document-level horizontal overflow.
- Focused browser QA after the final UI revision passed 12/12 in the empty/error
  runtime. A separate synthetic normal-data runtime passed 8/8 across all four
  widths plus 2/2 scrolled mobile checks for Monthly MA rows and Trade Workbench
  candidates. No Production database or protected dataset was used.

## Remaining engineering P2 / NOT_TESTED

- Monthly-MA list metadata follows the attested price/Snapshot generation.
  Universe-only name or active-count changes can remain cached until that
  generation changes. Per-row Universe timestamps were evaluated and rejected
  because SEC classification refreshes update them continuously and would
  cause repeated safe 503 responses during a normal long-running batch.
- US HEX generation attestation still performs its source-identity aggregate
  reads per request. This is correct and fail-closed, but Production-scale
  latency should be measured before introducing a separate identity cache.
- Physical-device hover, pinch, and mobile keyboard behavior remain
  `NOT_TESTED`.
- Production-data visual coverage, full-universe Monthly-MA p95/p99 and
  assistive-technology hardware remain `NOT_TESTED`.

## Dependency security release gate

- Security PR #22 updated main to `next@16.4.3` and merged as
  `dc0fbb686e7d4640498737f219b5dd8242f14aea` after an exact-SHA CI pass and an
  `npm audit` result of zero known findings.
- Updated main was merged into PR #21 without rebasing or force-pushing. The
  exact integration revision passed lockfile installation, TypeScript, the
  poisoned isolated build, route/isolation contracts, Storage Guard, SMA
  Dynamics, and parity regressions in run `40329714561`.
- Production deployment remains separately controlled and was not performed.

## Retained isolated build and browser QA (`72dcde54d9358ffdca14c43b71f2f1abbdfa44f1`)

- Production build: PASS (`next build --webpack`) under the isolated OWC runtime; Build ID `LfPPbwO_xr1tV1EtTala6`.
- Latest browser plan: 76/76 PASS across 19 US/shared routes at 1440, 1024, 768, and 390 px. Period Explorer's empty-calendar state is explicitly asserted on both markets.
- The complete 55-route plan produced 208/220 PASS. The 12 failures are the three JP real-data-dependent routes (`screener-jp`, `stock-jp`, and `daily-close-report`) at four widths in a deliberately empty isolated runtime; these results are NOT_TESTED for real data, not parity PASS.
- The 76 US/shared runs had no document-level horizontal overflow. Repeated navigation requests were observed for prefetchable pages and the favicon, so duplicate-request absence is not claimed.
- Cold browser navigation, 76 US/shared runs: p50 1,146 ms, p95 1,453 ms, p99 1,651 ms. Encoded payload p50 1,073.8 KiB, p95/p99 1,967 KiB. These measurements use an empty isolated runtime and are not Production-data performance claims.
- Physical-device hover, pinch, and mobile keyboard behavior: NOT_TESTED at
  both the retained and current revisions.

Latest artifacts are retained outside Git under `/Volumes/OWC Express 1M2 80G/development/us-jp-parity-browser-qa-20261026-final`.

## Synthetic search benchmark

Fixture: 300 JP tickers, 300 US tickers, 760 sessions; 20 cold processes and 400 warm requests per US scenario. Concurrency 1 and 4 returned consistent results.

| scenario | cold p50 / p95 / p99 ms | warm p50 / p95 / p99 ms | payload bytes |
| --- | ---: | ---: | ---: |
| US screener | 196.95 / 199.64 / 215.79 | 1.78 / 2.60 / 2.78 | 85,218 |
| US stage transition | 85.49 / 88.23 / 96.95 | 8.50 / 9.84 / 10.52 | 17,065 |
| US two-year line | 196.58 / 198.56 / 200.32 | 0.68 / 1.52 / 1.66 | 6,211 |
| Period explorer | 269.10 / 278.25 / 281.52 | 1.74 / 2.61 / 2.93 | 81,710 |
| US analog search | 1,898.02 / 1,927.70 / 2,047.97 | 2.95 / 5.22 / 8.00 | 219,412 |

The paired quick run found no material US penalty versus JP: US cold p50 was lower for screener, stage transition, two-year line, and analog search. This is synthetic evidence, not a Production load test.

Artifacts are retained outside Git under `/Volumes/OWC Express 1M2 80G/development/us-jp-parity-search-bench-20261026-us-distribution`.

## Explicitly not tested

- Production, Friend Access runtime, live credentials, and protected datasets.
- JP valuation and shareholder-return real-data integrations.
- US Monthly MA monitor Production-equivalent full-universe p95/p99, memory, and concurrency behavior.
- External API credentials, contracts, redistribution rights, and source availability recorded as blockers.
- Physical mobile devices and assistive-technology hardware.
