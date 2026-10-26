# US StockBoard parity validation — 2026-10-26

Evidence revision: `7ae161833c2b2ee5b9077c0e1c69aab0607eff1e`

## Isolated build and browser QA

- Production build: PASS (`next build --webpack`) under the isolated OWC runtime.
- Browser plan: 76/76 PASS across 19 US/shared routes at 1440, 1024, 768, and 390 px.
- No document-level horizontal overflow, successful external request, or duplicate application request was observed. Expected empty-fixture API failures were accepted only when the corresponding fail-closed or error-state copy was asserted.
- Cold browser navigation, 76 runs: p50 1,146 ms, p95 1,455 ms, p99 2,018 ms. Encoded payload p50 1,073.8 KiB, p95 1,967 KiB. These measurements use an empty isolated runtime and are not Production-data performance claims.
- Physical-device hover, pinch, and mobile keyboard behavior: NOT_TESTED.

Artifacts are retained outside Git under `/Volumes/OWC Express 1M2 80G/development/us-jp-parity-browser-qa-20261026-r2`.

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
- Physical mobile devices and assistive-technology hardware.

