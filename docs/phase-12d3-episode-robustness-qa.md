# Phase 12D-3 Episode Robustness QA

2026-09-19 / production `http://127.0.0.1:3000` / read-only derived analysis. No Trigger, Outcome, Stage, Score, or Spread recalculation.

## Definition and integrity

- An Episode starts at ENTERED or RE_ENTRY and ends only at EXITED. STATUS_CHANGED never splits it. A first STATUS_CHANGED/EXITED without an earlier entry is left-censored; an open Episode at scan end is right-censored. No day-gap heuristic is used.
- The Episode Outcome anchor is the first source-ordered event matching that Outcome job's selector *within that Episode*, not the Episode start, best Score, or best Return. NEAR and Zone jobs may therefore anchor on different dates. Existing saved Outcome rows, including availability, Return, MFE, MAE, Score, Stage, and Spread, are reused verbatim.
- Event-level saved Outcome remains unchanged. Episode-level selects one saved row per selected Episode. Ticker-equal-weight additionally takes the per-ticker median of eligible Episode outcomes for each horizon; the UI labels this separately.
- Historical Event NDJSON is streamed in source date/sequence order. Derived Episode keys use `historicalScanJobId:ticker:ordinal`. Duplicate/ambiguous identities and impossible sequences are diagnosed, never silently assigned. No persistent Episode table or migration was added.
- Independent QA reconstructed Episode boundaries and anchor choice from source artifacts. For each of the five cases it compared at least 30 selected Episodes, independently recomputed all Event/Episode horizon statistics and every group in Score, Month A, Week A x Month A, and Spread segmentation, and checked historical/outcome artifact SHA-256 before and after. All comparisons passed, with zero sequence anomalies, unmapped rows, ambiguous rows, or integrity exclusions. No OHLCV query, Trigger Engine run, Score/Stage/Spread calculation, or Gmail delivery occurred in the robustness request.

## Real-data cases

Scan windows: one-year cases 2025-09-01 to 2026-09-01 (244 sessions), two-year Monthly 2024-09-02 to 2026-09-01 (487 sessions). The table uses `Event/Episode`; these are observation counts, not ticker counts. “Repeated” means selected Events >=2 in an Episode. Distribution is mean/median/P95/max selected Events per selected Episode.

| Case | Event/Episode | Unique tickers | Repeated | Events per Episode | Left/right censored (selected) | Independent selected Episode checks |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| Monthly 1y NEAR | 2,694 / 1,622 | 1,082 | 649 | 1.66 / 1 / 4 / 8 | 24 / 32 | 53 |
| Monthly 1y Zone | 1,420 / 996 | 776 | 305 | 1.43 / 1 / 3 / 5 | 12 / 17 | 32 |
| Biweekly 1y NEAR | 5,132 / 2,273 | 1,409 | 1,195 | 2.26 / 2 / 6 / 20 | 27 / 140 | 34 |
| Biweekly 1y Zone | 3,254 / 1,832 | 1,328 | 780 | 1.78 / 1 / 4 / 12 | 18 / 99 | 64 |
| Monthly 2y NEAR | 6,434 / 3,814 | 1,940 | 1,584 | 1.69 / 1 / 4 / 9 | 6 / 32 | 37 |

Episode/Event observation ratios respectively: 60.21%, 70.14%, 44.29%, 56.30%, 59.28%. All selected Episode counts are <= Event counts. All source Outcome rows mapped uniquely: 2,694 / 1,420 / 5,132 / 3,254 / 6,434. Across the same cases, observed Episode counts including those without a selector event were 6,688 / 6,688 / 7,163 / 7,163 / 14,544. Left/right-censored *all* Episode counts were 78/87, 78/87, 61/221, 61/221, and 19/87.

### Horizon comparison

Percent values are rounded for display only. `E/P` means Event/Episode; 20/60/120/245 are trading sessions. `Eligible` excludes unavailable future data and is never treated as 0% return. Q25-Q75, MFE, and MAE are medians/quantiles of existing saved Outcome values, not new OHLCV calculations.

| Case | Sessions | Eligible E/P | Median E/P | Positive E/P | Q25-Q75 E / P | MFE E/P | MAE E/P |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| Monthly 1y NEAR | 20 | 2309/1414 | 0.50% / 0.39% | 53.83% / 52.76% | -3.04%–4.02% / -3.43%–3.94% | 4.30% / 4.42% | -3.59% / -3.65% |
| Monthly 1y NEAR | 60 | 1331/832 | 0.58% / 0.04% | 51.54% / 50.00% | -7.82%–9.00% / -7.74%–8.38% | 7.80% / 7.52% | -6.87% / -6.94% |
| Monthly 1y NEAR | 120 | 665/410 | 1.35% / 1.26% | 53.98% / 52.93% | -10.51%–13.67% / -10.38%–13.44% | 16.93% / 15.95% | -7.55% / -7.86% |
| Monthly 1y NEAR | 245 | 1/1 | 23.28% / 23.28% | 100% / 100% | 23.28%–23.28% / 23.28%–23.28% | 75.89% / 75.89% | -5.56% / -5.56% |
| Monthly 1y Zone | 20 | 1248/883 | 0.59% / 0.56% | 54.81% / 54.13% | -3.34%–4.41% / -3.42%–4.48% | 5.30% / 5.50% | -3.82% / -3.91% |
| Monthly 1y Zone | 60 | 730/507 | 1.03% / 0.09% | 51.92% / 50.10% | -9.45%–9.92% / -10.17%–9.93% | 9.42% / 9.25% | -7.63% / -7.69% |
| Monthly 1y Zone | 120 | 346/246 | 0.66% / 0.51% | 51.73% / 50.41% | -12.89%–15.11% / -13.41%–14.45% | 18.41% / 17.88% | -8.27% / -8.80% |
| Monthly 1y Zone | 245 | 1/1 | 20.94% / 20.94% | 100% / 100% | 20.94%–20.94% / 20.94%–20.94% | 78.65% / 78.65% | -4.08% / -4.08% |
| Biweekly 1y NEAR | 20 | 4217/1925 | -0.48% / -0.68% | 46.57% / 45.97% | -4.71%–3.64% / -5.16%–3.77% | 4.16% / 4.61% | -4.46% / -4.76% |
| Biweekly 1y NEAR | 60 | 2337/1083 | -2.79% / -2.33% | 42.23% / 42.75% | -10.38%–6.99% / -9.86%–7.12% | 6.72% / 7.39% | -9.08% / -9.02% |
| Biweekly 1y NEAR | 120 | 803/356 | -6.63% / -6.90% | 34.00% / 34.27% | -16.36%–6.20% / -16.61%–6.16% | 12.51% / 13.04% | -14.01% / -13.86% |
| Biweekly 1y NEAR | 245 | 1/1 | 69.45% / 69.45% | 100% / 100% | 69.45%–69.45% / 69.45%–69.45% | 70.64% / 70.64% | -0.36% / -0.36% |
| Biweekly 1y Zone | 20 | 2790/1585 | -0.24% / -0.27% | 47.31% / 47.07% | -4.59%–3.79% / -4.58%–4.10% | 4.68% / 5.03% | -4.50% / -4.53% |
| Biweekly 1y Zone | 60 | 1502/868 | -2.88% / -2.65% | 40.68% / 40.55% | -10.49%–7.86% / -10.18%–7.51% | 7.46% / 7.67% | -9.07% / -8.99% |
| Biweekly 1y Zone | 120 | 459/268 | -5.10% / -5.75% | 37.69% / 34.33% | -17.11%–6.61% / -18.17%–4.90% | 13.39% / 13.02% | -13.91% / -13.85% |
| Biweekly 1y Zone | 245 | 0/0 | N/A / N/A | N/A / N/A | N/A / N/A | N/A / N/A | N/A / N/A |
| Monthly 2y NEAR | 20 | 5713/3416 | 0.70% / 0.90% | 55.31% / 56.97% | -2.83%–4.25% / -2.71%–4.54% | 4.53% / 4.70% | -3.19% / -3.17% |
| Monthly 2y NEAR | 60 | 4634/2779 | 2.47% / 2.30% | 59.82% / 59.01% | -3.99%–9.75% / -4.18%–9.77% | 8.83% / 8.98% | -6.70% / -6.75% |
| Monthly 2y NEAR | 120 | 3899/2315 | 6.71% / 6.87% | 69.45% / 68.94% | -2.21%–19.02% / -2.60%–19.54% | 16.20% / 16.46% | -9.41% / -9.33% |
| Monthly 2y NEAR | 245 | 2983/1764 | 21.69% / 21.82% | 83.84% / 82.31% | 5.16%–45.84% / 4.56%–46.09% | 35.34% / 35.76% | -11.93% / -11.86% |

The one-year 245-session results have only 0–1 eligible observations. They are displayed with availability and small-sample state, but are not evidence for an Outcome comparison. Two-year Monthly NEAR has 2,983/1,764 eligible at that horizon.

### Segment spot checks (60 sessions)

All cells and all horizons passed independent count, eligible, mean, median, positive ratio, Q25/Q75, MFE, and MAE checks. UNKNOWN buckets were included. Sum-of-counts, sum-of-eligible, and eligible-weighted means matched the corresponding overall values.

| Case / group | Event/Episode obs | Eligible E/P | Median E/P | Positive E/P |
| --- | ---: | ---: | --- | --- |
| Monthly NEAR, Score 40–60 | 1462/891 | 674/442 | 0.63% / 0.36% | 51.93% / 51.13% |
| Monthly NEAR, Score 60–80 | 1029/610 | 585/342 | 0.46% / -0.46% | 50.94% / 47.95% |
| Monthly NEAR, Month A S1 | 420/269 | 315/204 | 2.86% / 1.65% | 60.63% / 55.88% |
| Monthly NEAR, Month A S4 | 959/560 | 352/215 | -2.10% / -2.08% | 41.19% / 40.47% |
| Biweekly NEAR, Week A S1 x Month A S1 | 484/283 | 282/166 | -1.54% / -1.44% | 43.62% / 42.17% |
| Biweekly NEAR, Week A S2 x Month A S2 | 287/157 | 162/88 | -6.43% / -5.17% | 35.19% / 39.77% |
| Biweekly NEAR, Spread PASS | 1033/558 | 604/324 | -5.62% / -5.21% | 34.27% / 35.19% |
| Biweekly NEAR, Spread FAIL | 4099/1715 | 1733/759 | -1.76% / -1.23% | 45.01% / 45.98% |

Some segment differences do change after deduplication, including the Monthly Score 60–80 median crossing zero. The UI does not label either unit “better”, “robust”, or “significant”.

## Performance and UI

- Direct read-model audit, warm local file cache: Monthly 1y NEAR 275 ms (19,227 Event lines), Biweekly 1y NEAR 283 ms (25,436 lines), Monthly 2y NEAR 627 ms (43,434 lines). Two metadata SQL reads; no OHLCV SQL. Most time was artifact I/O/parsing: respectively 76+79, 85+96, and 189+181 ms. Episode build/mapping: 12+20, 11+27, and 29+54 ms. Deduplication <=3 ms; percentile aggregation 13/15/34 ms.
- Production HTTP `/robustness` three sequential requests each, status 200: Monthly 1y NEAR 710/1233/534 ms, Biweekly 1y NEAR 465/615/625 ms, Monthly 2y NEAR 1399/1374/710 ms. The 20.2-second historical outlier did not recur in these nine requests. Production 2D 49-cell response: 384 ms, 324,201 bytes; only derived aggregates are sent, never all source Outcome rows.
- Direct-audit process peak heap/RSS were 181/372 MB, 310/516 MB, and 201/408 MB respectively for the same three cases. These are whole-process peaks, not incremental Episode allocations. Response size without segmentation was about 12 KB in production.
- The UI is within existing “条件別に見る”, reuses the parent 1/3/6/12-month horizon selector, exposes Event/Episode/Ticker comparison and Score/Stage/Stage-pair/Spread segmented views. The selected unit is a native keyboard-operable control. 390/768/1280/1920 CSS px checked in production Chrome. Document scrollWidth stayed below innerWidth (390: 382, 768: 760, 1280: 1272, 1920: 1912). The table alone scrolls internally at 390 and 768; no document overflow or layout overlap.
- QA historical job was interrupted by the formal production deploy's worker restart while RUNNING. The existing stale-job recovery API requeued exactly that QA job; it then completed, as did all five Outcome jobs. This was QA scheduling, not an Episode read-model failure. **Operational residual outside this phase:** worker recovery runs at startup only. If a restarted worker sees a RUNNING job whose heartbeat is not yet stale, it can leave that job blocking the queue after it becomes stale. The one-shot recovery behavior was observed here and not changed in Phase 12D-3.

## Release and regression

- `next typegen`, `tsc --noEmit`, and production build passed. Formal `npm run web:deploy` published to port 3000. Production smoke passed 142/142 against port 3000, including Episode route and pagination validation.
- Historical scan, historical jobs, saved Outcome, segmentation, Episode core/UI tests passed. Episode fixture covered repeated NEAR/Zone, re-entry, left/right censoring, all six Stage axes, 49 two-dimensional cells, source expiry, unchanged source SHA, unchanged side-effect counts, and OHLCV query count 0.
- Notification delivery attempts and outbox row counts remained 5/5 from the pre-QA baseline: Gmail sends 0. No commit, push, reset, restore, clean, or DB migration. Pre-existing dirty source files remain untouched.

## QA cleanup

Deleted only the three QA-created Historical jobs (`cdf75b6d`, `acb9faad`, `b78abb0f`) and five QA-created Outcome jobs (`94a8a99b`, `8cfefc16`, `0370df45`, `c45ee73b`, `e69a84fa`) by exact full IDs, after checking that all were COMPLETED and that no other Outcome job referenced those Historical jobs. Removed their 21 corresponding generated artifact files. Post-cleanup DB checks: zero QA rows remain; pre-existing Historical `6e833147` and Outcome `4ea44a97` still exist; notification delivery attempts remain at five.
