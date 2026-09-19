# MA Spread Expansion parameter sensitivity: fixed Historical Event universes

Descriptive statistics only. No parameter ranking, recommendation, or statistical significance claim.
Each cohort uses one fixed Spread OFF Historical Scan event set and its saved Outcome rows.
Return, MFE and MAE are stored Outcome values; identical ticker events are not episode-deduplicated.
Returns and positive ratios in the CSV are fractions (0.05 means 5%). Small sample: eligible < 30.
The CSV includes PASS, FAIL and UNKNOWN groups for all 13 rules and all four horizons.

## Interpretation and provenance

- The configured baseline is 4 intervals / 70%, which requires 3/4 expanding intervals (75% effective). Configured 70%, 71%, 74%, and 75% therefore yield the same discrete rule at four intervals. Each effective condition appears only once.
- The Event date, ticker set, and saved Return/MFE/MAE are fixed within a cohort. The shared Trigger Engine spread evaluator reads MA observations no later than the saved diagnostic date, itself no later than the Event date. The saved baseline slope, spread, expansion ratio, bullish order, and PASS/FAIL matched every re-evaluated Event; an inconsistency fails the entire API request.
- These six cohorts are separate populations, not pooled. The two-year cohort is Prime-only. 2026 has insufficient forward history for many long horizons; do not compare its censored values as if they were observed returns.
- All real-data cohorts have mature MA history, so UNKNOWN is zero. A short-history regression fixture has three intervals available but eight intervals UNKNOWN, not FAIL.
- More restrictive rules often leave very small PASS groups, especially Monthly Zone. No condition is ranked, selected as a winner, or adopted as a production default. Differences among rows are descriptive, not evidence of statistical significance.
- Timings are uncached read-model measurements in one process; reported heap/RSS are sampled maxima, not a continuous profiler peak. SQL calls are per ticker batch, independent of the 13-rule grid. The 2-year case took roughly 5.5 seconds; MA SQL dominates. A separate production HTTP check of the existing Monthly NEAR cohort returned HTTP 200 with 13 sets and the same 45-event baseline.
- Newly created QA Historical/Outcome jobs were removed by explicit IDs after recording these aggregates. The two pre-existing source jobs were retained. The report is a frozen audit record; the deleted QA job IDs cannot be queried again.

## Monthly NEAR, 3 months

- Timeframe: MONTHLY; selector: NEAR_ENTERED; period: 2025-02-03 to 2025-05-02
- Event universe: 1006; unique tickers: 571. Outcome SHA-256 unchanged: `5be88291c56a5b8e53df1540a177cc63578d22bf70eb31e1b5d9d9c2e8dc8f8e`.
- Uncached: total 1683.3ms; Outcome load 116.3ms; MA SQL 1297.1ms; series 132.3ms; evaluation 18.9ms; aggregation 39.3ms; percentile 65.2ms; serialization 0.5ms.
- SQL calls: 13; source rows: 68603; peak heap 41MiB; RSS 231MiB; response 66109 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 94 | 912 | 0 | 80 | 9.34% | 88 / 1.50% / 64.8% | 88 / 12.88% / 83.0% |
| 3 | 100.0% / 3/3 (100.0%) | 5 | 1001 | 0 | 5 | 0.50% | 5 / 1.04% / 80.0% (n<30) | 5 / 14.57% / 80.0% (n<30) |
| 4 | 50.0% / 2/4 (50.0%) | 134 | 872 | 0 | 114 | 13.32% | 123 / 1.61% / 61.0% | 122 / 13.02% / 82.0% |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 45 | 961 | 0 | 41 | 4.47% | 41 / 0.77% / 51.2% | 40 / 9.62% / 80.0% |
| 4 | 100.0% / 4/4 (100.0%) | 1 | 1005 | 0 | 1 | 0.10% | 1 / 1.61% / 100.0% (n<30) | 1 / 4.14% / 100.0% (n<30) |
| 6 | 50.0% / 3/6 (50.0%) | 107 | 899 | 0 | 90 | 10.64% | 95 / 1.39% / 62.1% | 91 / 11.73% / 84.6% |
| 6 | 66.7% / 4/6 (66.7%) | 40 | 966 | 0 | 38 | 3.98% | 36 / 1.37% / 61.1% | 32 / 10.46% / 75.0% |
| 6 | 83.3% / 5/6 (83.3%) | 5 | 1001 | 0 | 5 | 0.50% | 4 / 11.91% / 75.0% (n<30) | 4 / 29.36% / 75.0% (n<30) |
| 6 | 100.0% / 6/6 (100.0%) | 0 | 1006 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 109 | 897 | 0 | 89 | 10.83% | 98 / 2.63% / 62.2% | 94 / 7.91% / 83.0% |
| 8 | 75.0% / 6/8 (75.0%) | 13 | 993 | 0 | 13 | 1.29% | 13 / 2.95% / 61.5% (n<30) | 11 / 9.15% / 63.6% (n<30) |
| 8 | 87.5% / 7/8 (87.5%) | 0 | 1006 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 100.0% / 8/8 (100.0%) | 0 | 1006 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |

## Monthly Zone, 3 months

- Timeframe: MONTHLY; selector: IN_ZONE_ENTERED; period: 2025-02-03 to 2025-05-02
- Event universe: 701; unique tickers: 534. Outcome SHA-256 unchanged: `3bac0f147c10c81986a38ef497f8e1dcda37672a9f84db3243ff8ea1396f9907`.
- Uncached: total 1167.7ms; Outcome load 84.8ms; MA SQL 879.7ms; series 71.6ms; evaluation 16.0ms; aggregation 25.9ms; percentile 88.2ms; serialization 0.3ms.
- SQL calls: 13; source rows: 62287; peak heap 92MiB; RSS 293MiB; response 63901 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 11 | 690 | 0 | 11 | 1.57% | 10 / 9.20% / 80.0% (n<30) | 10 / 32.66% / 80.0% (n<30) |
| 3 | 100.0% / 3/3 (100.0%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 4 | 50.0% / 2/4 (50.0%) | 41 | 660 | 0 | 39 | 5.85% | 37 / 10.43% / 78.4% | 36 / 15.29% / 88.9% |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 2 | 699 | 0 | 2 | 0.29% | 1 / -2.92% / 0.0% (n<30) | 1 / 0.03% / 100.0% (n<30) |
| 4 | 100.0% / 4/4 (100.0%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 50.0% / 3/6 (50.0%) | 26 | 675 | 0 | 24 | 3.71% | 23 / 2.38% / 56.5% (n<30) | 23 / 9.46% / 78.3% (n<30) |
| 6 | 66.7% / 4/6 (66.7%) | 3 | 698 | 0 | 3 | 0.43% | 3 / -2.96% / 33.3% (n<30) | 3 / 9.58% / 100.0% (n<30) |
| 6 | 83.3% / 5/6 (83.3%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 100.0% / 6/6 (100.0%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 31 | 670 | 0 | 30 | 4.42% | 28 / -0.73% / 46.4% (n<30) | 27 / 7.65% / 70.4% (n<30) |
| 8 | 75.0% / 6/8 (75.0%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 87.5% / 7/8 (87.5%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 100.0% / 8/8 (100.0%) | 0 | 701 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |

## Biweekly NEAR, 3 months

- Timeframe: BIWEEKLY; selector: NEAR_ENTERED; period: 2025-02-03 to 2025-05-02
- Event universe: 566; unique tickers: 232. Outcome SHA-256 unchanged: `ba2fce9f8696046a3f45de3f97e6425f3bffe948bedacd91d21e4acc7fea7eb9`.
- Uncached: total 665.2ms; Outcome load 37.9ms; MA SQL 415.7ms; series 153.1ms; evaluation 9.7ms; aggregation 17.8ms; percentile 29.9ms; serialization 0.4ms.
- SQL calls: 4; source rows: 27042; peak heap 92MiB; RSS 294MiB; response 68288 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 151 | 415 | 0 | 86 | 26.68% | 137 / 5.29% / 58.4% | 137 / 11.76% / 78.1% |
| 3 | 100.0% / 3/3 (100.0%) | 65 | 501 | 0 | 44 | 11.48% | 57 / 6.61% / 59.6% | 57 / 9.87% / 75.4% |
| 4 | 50.0% / 2/4 (50.0%) | 178 | 388 | 0 | 93 | 31.45% | 166 / 4.92% / 59.0% | 166 / 10.06% / 80.7% |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 140 | 426 | 0 | 79 | 24.73% | 130 / 5.52% / 58.5% | 130 / 11.77% / 77.7% |
| 4 | 100.0% / 4/4 (100.0%) | 46 | 520 | 0 | 32 | 8.13% | 42 / 7.91% / 64.3% | 42 / 14.55% / 76.2% |
| 6 | 50.0% / 3/6 (50.0%) | 186 | 380 | 0 | 91 | 32.86% | 170 / 5.13% / 60.6% | 170 / 11.77% / 75.3% |
| 6 | 66.7% / 4/6 (66.7%) | 156 | 410 | 0 | 75 | 27.56% | 140 / 6.11% / 61.4% | 140 / 13.85% / 77.1% |
| 6 | 83.3% / 5/6 (83.3%) | 83 | 483 | 0 | 49 | 14.66% | 74 / 7.66% / 67.6% | 74 / 15.70% / 82.4% |
| 6 | 100.0% / 6/6 (100.0%) | 18 | 548 | 0 | 10 | 3.18% | 15 / 7.87% / 73.3% (n<30) | 15 / 17.68% / 80.0% (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 186 | 380 | 0 | 87 | 32.86% | 171 / 5.10% / 62.0% | 171 / 13.79% / 76.0% |
| 8 | 75.0% / 6/8 (75.0%) | 101 | 465 | 0 | 48 | 17.84% | 89 / 6.52% / 66.3% | 89 / 14.93% / 76.4% |
| 8 | 87.5% / 7/8 (87.5%) | 47 | 519 | 0 | 26 | 8.30% | 42 / 7.91% / 71.4% | 42 / 17.60% / 85.7% |
| 8 | 100.0% / 8/8 (100.0%) | 3 | 563 | 0 | 3 | 0.53% | 2 / -8.69% / 0.0% (n<30) | 2 / 1.43% / 50.0% (n<30) |

## Biweekly Zone, 3 months

- Timeframe: BIWEEKLY; selector: IN_ZONE_ENTERED; period: 2025-02-03 to 2025-05-02
- Event universe: 378; unique tickers: 215. Outcome SHA-256 unchanged: `974f51e092d0f844b09f6395917e31304217e6a07ef63fbebcd937c3ae3ca115`.
- Uncached: total 372.6ms; Outcome load 27.4ms; MA SQL 166.1ms; series 124.8ms; evaluation 6.0ms; aggregation 21.1ms; percentile 24.7ms; serialization 2.1ms.
- SQL calls: 4; source rows: 25057; peak heap 118MiB; RSS 286MiB; response 68094 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 112 | 266 | 0 | 76 | 29.63% | 105 / 4.77% / 63.8% | 105 / 11.98% / 77.1% |
| 3 | 100.0% / 3/3 (100.0%) | 48 | 330 | 0 | 36 | 12.70% | 44 / 2.97% / 59.1% | 44 / 10.98% / 72.7% |
| 4 | 50.0% / 2/4 (50.0%) | 140 | 238 | 0 | 90 | 37.04% | 133 / 2.96% / 60.2% | 133 / 11.65% / 75.9% |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 99 | 279 | 0 | 70 | 26.19% | 93 / 4.44% / 60.2% | 93 / 12.05% / 73.1% |
| 4 | 100.0% / 4/4 (100.0%) | 34 | 344 | 0 | 27 | 8.99% | 31 / 1.19% / 58.1% | 31 / 8.28% / 67.7% |
| 6 | 50.0% / 3/6 (50.0%) | 133 | 245 | 0 | 88 | 35.19% | 124 / 4.53% / 60.5% | 124 / 11.77% / 71.8% |
| 6 | 66.7% / 4/6 (66.7%) | 109 | 269 | 0 | 75 | 28.84% | 101 / 2.96% / 56.4% | 101 / 9.24% / 69.3% |
| 6 | 83.3% / 5/6 (83.3%) | 54 | 324 | 0 | 41 | 14.29% | 50 / 9.29% / 72.0% | 50 / 17.22% / 78.0% |
| 6 | 100.0% / 6/6 (100.0%) | 8 | 370 | 0 | 5 | 2.12% | 6 / 5.72% / 66.7% (n<30) | 6 / 3.68% / 50.0% (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 135 | 243 | 0 | 82 | 35.71% | 129 / 4.06% / 59.7% | 129 / 10.93% / 69.8% |
| 8 | 75.0% / 6/8 (75.0%) | 65 | 313 | 0 | 41 | 17.20% | 60 / 4.48% / 61.7% | 60 / 12.64% / 68.3% |
| 8 | 87.5% / 7/8 (87.5%) | 29 | 349 | 0 | 19 | 7.67% | 26 / 9.80% / 80.8% (n<30) | 26 / 19.08% / 80.8% (n<30) |
| 8 | 100.0% / 8/8 (100.0%) | 3 | 375 | 0 | 2 | 0.79% | 1 / 4.06% / 100.0% (n<30) | 1 / 8.70% / 100.0% (n<30) |

## Monthly NEAR, Prime 2 years

- Timeframe: MONTHLY; selector: NEAR_ENTERED; period: 2023-05-08 to 2025-05-02
- Event universe: 3025; unique tickers: 915. Outcome SHA-256 unchanged: `66bd8b309528d1aef3c4c6afb67d83c85e9e3ea27355cf014723c490a18d1fda`.
- Uncached: total 5463.1ms; Outcome load 294.9ms; MA SQL 3932.6ms; series 834.7ms; evaluation 32.4ms; aggregation 122.5ms; percentile 241.6ms; serialization 0.3ms.
- SQL calls: 21; source rows: 500168; peak heap 241MiB; RSS 418MiB; response 65153 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 317 | 2708 | 0 | 251 | 10.48% | 317 / 2.51% / 59.6% | 317 / 5.62% / 67.5% |
| 3 | 100.0% / 3/3 (100.0%) | 27 | 2998 | 0 | 27 | 0.89% | 27 / 1.77% / 59.3% (n<30) | 27 / 6.89% / 59.3% (n<30) |
| 4 | 50.0% / 2/4 (50.0%) | 452 | 2573 | 0 | 332 | 14.94% | 452 / 2.39% / 58.8% | 452 / 4.52% / 65.0% |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 140 | 2885 | 0 | 120 | 4.63% | 140 / 0.88% / 53.6% | 140 / 4.07% / 62.9% |
| 4 | 100.0% / 4/4 (100.0%) | 3 | 3022 | 0 | 3 | 0.10% | 3 / 2.01% / 66.7% (n<30) | 3 / -2.96% / 33.3% (n<30) |
| 6 | 50.0% / 3/6 (50.0%) | 407 | 2618 | 0 | 287 | 13.45% | 407 / 1.61% / 56.8% | 407 / 3.79% / 64.4% |
| 6 | 66.7% / 4/6 (66.7%) | 153 | 2872 | 0 | 125 | 5.06% | 153 / 0.00% / 49.7% | 153 / 2.53% / 58.8% |
| 6 | 83.3% / 5/6 (83.3%) | 19 | 3006 | 0 | 17 | 0.63% | 19 / -1.80% / 42.1% (n<30) | 19 / 1.23% / 52.6% (n<30) |
| 6 | 100.0% / 6/6 (100.0%) | 1 | 3024 | 0 | 1 | 0.03% | 1 / 2.01% / 100.0% (n<30) | 1 / -14.22% / 0.0% (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 397 | 2628 | 0 | 274 | 13.12% | 397 / 0.77% / 53.7% | 397 / 3.04% / 62.7% |
| 8 | 75.0% / 6/8 (75.0%) | 30 | 2995 | 0 | 25 | 0.99% | 30 / -0.83% / 43.3% | 30 / 2.45% / 53.3% |
| 8 | 87.5% / 7/8 (87.5%) | 4 | 3021 | 0 | 4 | 0.13% | 4 / -4.10% / 25.0% (n<30) | 4 / -1.25% / 50.0% (n<30) |
| 8 | 100.0% / 8/8 (100.0%) | 0 | 3025 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |

## Monthly NEAR, 2026 stored MA

- Timeframe: MONTHLY; selector: NEAR_ENTERED; period: 2026-06-01 to 2026-09-11
- Event universe: 306; unique tickers: 160. Outcome SHA-256 unchanged: `db533070f7e79fef7d0e2b8ca0995fa515c74bc31f72c7b2d3b4e68251e4456e`.
- Uncached: total 1487.3ms; Outcome load 29.4ms; MA SQL 1385.5ms; series 35.5ms; evaluation 13.7ms; aggregation 19.1ms; percentile 3.0ms; serialization 0.4ms.
- SQL calls: 5; source rows: 37120; peak heap 74MiB; RSS 429MiB; response 58733 bytes.

| Intervals | Configured / effective | PASS | FAIL | UNKNOWN | Unique PASS | PASS rate | 60d eligible / median / positive | 120d eligible / median / positive |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| 3 | 66.7% / 2/3 (66.7%) | 39 | 267 | 0 | 33 | 12.75% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 3 | 100.0% / 3/3 (100.0%) | 4 | 302 | 0 | 4 | 1.31% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 4 | 50.0% / 2/4 (50.0%) | 56 | 250 | 0 | 44 | 18.30% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 4 BASELINE | 70.0% / 3/4 (75.0%) | 18 | 288 | 0 | 18 | 5.88% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 4 | 100.0% / 4/4 (100.0%) | 0 | 306 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 50.0% / 3/6 (50.0%) | 64 | 242 | 0 | 51 | 20.92% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 66.7% / 4/6 (66.7%) | 22 | 284 | 0 | 18 | 7.19% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 83.3% / 5/6 (83.3%) | 4 | 302 | 0 | 4 | 1.31% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 6 | 100.0% / 6/6 (100.0%) | 0 | 306 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 50.0% / 4/8 (50.0%) | 67 | 239 | 0 | 53 | 21.90% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 75.0% / 6/8 (75.0%) | 6 | 300 | 0 | 5 | 1.96% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 87.5% / 7/8 (87.5%) | 1 | 305 | 0 | 1 | 0.33% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
| 8 | 100.0% / 8/8 (100.0%) | 0 | 306 | 0 | 0 | 0.00% | 0 / N/A / N/A (n<30) | 0 / N/A / N/A (n<30) |
