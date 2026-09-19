# Phase 12D-1 Outcome Segmentation QA

The server-side Segmentation contract and API were already present in this worktree. This audit did not introduce a second calculation path or change the existing Outcome UI. The source is a completed Outcome NDJSON artifact; Trigger, Stage, Score, Return, MFE, and MAE are not recalculated. Segmentation itself executes one job-metadata query and **zero OHLCV queries** per request.

## Contract

- Dimensions: Score band, six independent Stage axes, and the source-saved Spread Expansion PASS/FAIL/UNKNOWN. One or two dimensions are accepted; three or more return HTTP 400.
- Score bands: `[0,40)`, `[40,60)`, `[60,80)`, `[80,100]`, plus UNKNOWN. Stage values are categorical S1-S6/UNKNOWN, not ordinal strength.
- Each group reports Event count, unique ticker count, and 20/60/120/245-session availability, Return distribution, MFE, and MAE. The `smallSample` flag means eligible count below 30; it is a presentation warning, not a significance test.
- Missing Score, Stage, or saved Spread diagnostics go to UNKNOWN. Old artifacts are not retroactively evaluated with current MA data.
- Source metadata includes scan dates, market/price/liquidity/Stage/Spread filters, Outcome selector/Score filters, MA periods, timeframe, cutoff, horizons, and historical-universe caveat. Cross-Job compatibility identifies differences without rejecting intentionally different timeframes.

## Real-data cohorts

All new QA scans use Prime market, Spread OFF, MA 20/25, 2024-05-07 to 2025-05-02 (one year) or 2023-05-08 to 2025-05-02 (two years). A separate existing three-month all-market Outcome was reused for the Phase 12C-5 parity check. Event universes are distinct and are **not pooled**.

| Analysis | Events | Cells | Uncached direct time | OHLCV SQL |
| --- | ---: | ---: | ---: | ---: |
| Monthly 1y NEAR × Score | 2,066 | 5 | 62ms | 0 |
| Monthly 1y NEAR × Month A | 2,066 | 7 | 31ms | 0 |
| Monthly 1y Zone × Month A | 1,276 | 7 | 17ms | 0 |
| Biweekly 1y NEAR × Score | 2,214 | 5 | 34ms | 0 |
| Biweekly 1y NEAR × Week A × Month A | 2,214 | 49 | 32ms | 0 |
| Biweekly 1y NEAR × saved Spread | 2,214 | 3 | 33ms | 0 |
| Monthly 2y NEAR × Score | 3,025 | 5 | 101ms | 0 |
| Monthly 2y NEAR × Week A × Month A | 3,025 | 49 | 60ms | 0 |
| Existing Monthly 3mo NEAR × saved Spread | 1,006 | 3 | 15ms | 0 |

These are in-process read-model timings, not browser round trips. The one-year and two-year requests each made one metadata query. The largest recorded response was about 80KB for 49 cells. Observed heap/RSS samples and detailed phase timings are in the [JSON audit](phase-12d1-segmentation-real-summary.json). On the production server, the first HTTP request for one-year Monthly NEAR Score took about 5.5 seconds wall-clock (the read model reported 1.37 seconds within it); a subsequent identical request took 0.35 seconds. No sidecar cache was added; production scheduling/IO can dominate cold HTTP latency.

The [full CSV audit](phase-12d1-segmentation-real-results.csv) contains every cell and all four horizons: Event/unique ticker counts, eligible/unavailable, mean, median, positive ratio, Q25/Q75, median MFE/MAE, and small-sample flag. Values are fractions, so `0.01` means 1%.

## Representative checks

- Monthly 1y NEAR Score bands: LOW 14, MID_LOW 971, MID_HIGH 1,001, HIGH 80, UNKNOWN 0; sum 2,066.
- Monthly 1y Zone Month A: S1 85, S2 158, S3 299, S4 572, S5 125, S6 35, UNKNOWN 2; sum 1,276. The two missing Stage observations were retained.
- Biweekly 1y NEAR source-saved Spread: PASS 591, FAIL 1,623, UNKNOWN 0; sum 2,214. This is the source Scan's saved diagnostic, **not** one of the Phase 12C-5 alternate parameter rules.
- Existing three-month Monthly NEAR saved Spread: PASS 45, FAIL 961, UNKNOWN 0, matching the Phase 12C-5 baseline on the same Outcome artifact.
- All nine cases passed independent recomputation from their source NDJSON for every cell's count, unique ticker count, and all four horizons' outcome measures. Source SHA-256 was unchanged before and after each request. Group totals, eligible totals, and eligible-weighted means agreed with the overall Outcome summary.
- A Monthly/Biweekly comparison over the same one-year date range reported differences in `timeframe` and `maPeriods` (including unit), while `sameDateRange`, `samePopulationFilters`, `sameEventSelector`, `sameHorizons`, and `sameAnalysisCutoffDate` were true. It did not reject the comparison or label a winner.

Score boundaries `0, 39.999, 40, 59.999, 60, 79.999, 80, 100, null`, six Stage axes, UNKNOWN handling, 29/30 eligible small-sample boundary, repeated Events for one ticker, censored outcomes, and 1D/2D cell integrity passed the existing isolated regression suite. These distributions are descriptive only: Event observations can repeat for the same ticker, and no parameter/segment is identified as better, best, or optimal.

New QA Historical/Outcome jobs are removed by explicit ID after recording the report. The pre-existing three-month source jobs remain untouched. No Gmail delivery was invoked.
