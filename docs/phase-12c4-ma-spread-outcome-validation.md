# Phase 12C-4: MA Spread Expansion Outcome Validation

## Scope and method

- Audit date: 2026-09-19. Source: the local production database and the existing Historical Trigger Scan and Outcome calculators. Evaluation period: 2025-02-03 to 2025-05-02; outcome data through 2026-09-18.
- Settings: all markets, MA 20/25, Trigger distance 5%, Near distance 2%, spread lookback 4 observations, minimum expansion ratio 70%, bullish MA order required. Monthly and Biweekly are evaluated separately.
- **Primary** (`CONDITIONED_EVENT_COMPARISON`): keep every qualifying Event and its date, anchor price, saved Score and Stage from the Spread-OFF scan. Partition the saved Event diagnostics into PASS, FAIL and UNKNOWN, then aggregate the same Outcome rows. No new OHLCV query is made by segmentation.
- **Secondary** (`OPERATIONAL_SCAN_COMPARISON`): run otherwise identical Spread-OFF and Spread-ON scans. This changes candidate membership and may change Event dates, so it is not a controlled PASS/FAIL Outcome comparison.
- 1M/3M/6M/12M mean 20/60/120/245 market sessions. All returns, quartiles, MFE and MAE below are percentages. `Eligible` excludes censored/unavailable outcomes. Multiple Events for one ticker are not independent observations.

## Primary: same Event universe

For each group, PASS + FAIL + UNKNOWN equals the source Event count. Ticker counts can overlap between PASS and FAIL because one ticker may have multiple Events.

| Timeframe / Event | PASS Event / ticker | FAIL Event / ticker | UNKNOWN Event |
| --- | ---: | ---: | ---: |
| Monthly NEAR entry | 45 / 41 | 961 / 563 | 0 |
| Monthly Trigger Zone entry | 2 / 2 | 699 / 533 | 0 |
| Biweekly NEAR entry | 140 / 79 | 426 / 185 | 0 |
| Biweekly Trigger Zone entry | 99 / 70 | 279 / 166 | 0 |

### Monthly NEAR entry

| Group | Horizon | Eligible / Event | Q25 | Median | Q75 | Mean | Positive | Median MFE | Median MAE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PASS | 1M | 41 / 45 | -7.98 | -2.45 | +2.18 | -2.27 | 39.0 | +4.82 | -6.48 |
| FAIL | 1M | 875 / 961 | -6.12 | -0.72 | +3.93 | -0.66 | 46.9 | +4.77 | -7.03 |
| PASS | 3M | 41 / 45 | -4.26 | +0.77 | +9.97 | +3.25 | 51.2 | +6.35 | -15.25 |
| FAIL | 3M | 847 / 961 | -2.01 | +3.58 | +10.24 | +5.30 | 65.3 | +8.74 | -13.71 |
| PASS | 6M | 40 / 45 | +2.24 | +9.62 | +18.19 | +15.16 | 80.0 | +16.59 | -16.38 |
| FAIL | 6M | 830 / 961 | +3.73 | +13.76 | +25.94 | +18.31 | 85.3 | +18.69 | -13.79 |
| PASS | 12M | 37 / 45 | +11.65 | +36.37 | +84.87 | +65.25 | 91.9 | +58.18 | -18.21 |
| FAIL | 12M | 810 / 961 | +9.26 | +26.49 | +51.26 | +38.94 | 86.9 | +41.73 | -14.21 |

### Monthly Trigger Zone entry

PASS has only **2 Events, 1 eligible Outcome** at every horizon. Its figures are descriptive observations, not a reliable distribution.

| Group | Horizon | Eligible / Event | Q25 | Median | Q75 | Mean | Positive | Median MFE | Median MAE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PASS | 1M | 1 / 2 | -1.47 | -1.47 | -1.47 | -1.47 | 0.0 | +2.45 | -3.16 |
| FAIL | 1M | 658 / 699 | -2.98 | +1.91 | +7.33 | +1.80 | 60.0 | +5.90 | -7.54 |
| PASS | 3M | 1 / 2 | -2.92 | -2.92 | -2.92 | -2.92 | 0.0 | +2.45 | -14.28 |
| FAIL | 3M | 637 / 699 | -0.21 | +6.76 | +15.03 | +8.53 | 74.3 | +12.67 | -12.25 |
| PASS | 6M | 1 / 2 | +0.03 | +0.03 | +0.03 | +0.03 | 100.0 | +2.77 | -14.28 |
| FAIL | 6M | 630 / 699 | +6.60 | +17.76 | +32.07 | +22.36 | 89.0 | +24.44 | -12.32 |
| PASS | 12M | 1 / 2 | +8.26 | +8.26 | +8.26 | +8.26 | 100.0 | +13.04 | -14.28 |
| FAIL | 12M | 619 / 699 | +12.50 | +33.53 | +60.36 | +45.08 | 88.0 | +49.16 | -12.79 |

### Biweekly NEAR entry

| Group | Horizon | Eligible / Event | Q25 | Median | Q75 | Mean | Positive | Median MFE | Median MAE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PASS | 1M | 133 / 140 | -6.15 | 0.00 | +7.20 | +0.70 | 48.9 | +5.50 | -6.81 |
| FAIL | 1M | 406 / 426 | -5.70 | -0.98 | +4.67 | -0.27 | 45.3 | +5.07 | -7.21 |
| PASS | 3M | 130 / 140 | -4.59 | +5.52 | +17.48 | +6.73 | 58.5 | +12.23 | -13.71 |
| FAIL | 3M | 396 / 426 | -6.61 | +2.01 | +11.61 | +4.70 | 54.8 | +10.06 | -17.43 |
| PASS | 6M | 130 / 140 | +3.14 | +11.77 | +22.84 | +16.12 | 77.7 | +21.81 | -13.71 |
| FAIL | 6M | 392 / 426 | +2.95 | +9.73 | +26.25 | +18.15 | 80.9 | +19.00 | -17.69 |
| PASS | 12M | 130 / 140 | +4.33 | +14.14 | +34.94 | +20.94 | 78.5 | +31.00 | -16.84 |
| FAIL | 12M | 391 / 426 | +11.09 | +28.19 | +54.15 | +44.79 | 86.4 | +42.71 | -19.28 |

### Biweekly Trigger Zone entry

| Group | Horizon | Eligible / Event | Q25 | Median | Q75 | Mean | Positive | Median MFE | Median MAE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PASS | 1M | 94 / 99 | -7.12 | -2.21 | +9.43 | +1.50 | 46.8 | +5.55 | -7.32 |
| FAIL | 1M | 263 / 279 | -5.61 | -1.88 | +4.69 | +0.32 | 42.6 | +4.73 | -7.22 |
| PASS | 3M | 93 / 99 | -5.52 | +4.44 | +18.46 | +7.85 | 60.2 | +12.49 | -13.99 |
| FAIL | 3M | 259 / 279 | -6.06 | +0.96 | +10.35 | +6.59 | 54.1 | +8.82 | -18.11 |
| PASS | 6M | 93 / 99 | -0.41 | +12.05 | +25.85 | +17.92 | 73.1 | +22.26 | -13.99 |
| FAIL | 6M | 256 / 279 | +3.63 | +11.43 | +26.34 | +21.81 | 83.6 | +17.07 | -18.33 |
| PASS | 12M | 93 / 99 | -5.98 | +13.95 | +22.16 | +18.22 | 73.1 | +29.76 | -17.25 |
| FAIL | 12M | 255 / 279 | +10.02 | +25.86 | +50.27 | +43.51 | 85.1 | +37.55 | -19.56 |

## Secondary: separate OFF and ON scans

| Timeframe | OFF unique candidates / all Events / NEAR / Zone | ON unique candidates / all Events / NEAR / Zone | Candidate reduction |
| --- | ---: | ---: | ---: |
| Monthly | 1,296 / 7,030 / 1,006 / 701 | 284 / 753 / 23 / 2 | 78.1% |
| Biweekly | 366 / 2,937 / 566 / 378 | 158 / 904 / 133 / 98 | 56.8% |

The ON candidate set was a subset of OFF **on every trading day**. Event sets are not assumed to be subsets because lifecycle transitions can move in time. For ON-scan NEAR outcomes, the 1M/3M/6M/12M medians were Monthly -3.23% / 0.00% / +9.26% / +34.70% (eligible 21/21/20/19 of 23) and Biweekly +0.33% / +6.14% / +13.01% / +14.84% (eligible 127/124/124/124 of 133). These are separate Event universes, not the primary PASS group.

## Contract, PIT, performance and QA

- Diagnostics (`spreadExpansionPass`, `spreadExpansionAvailable`, signed spread, slope, expansion ratio, bullish order, diagnostic date) are saved on both OFF and ON Events and copied to Outcome rows. An `EXITED` Event uses its prior snapshot and is UNKNOWN for current-Event conditioning. Old artifacts remain readable and report `SPREAD_DIAGNOSTICS_UNAVAILABLE`; missing or future-dated diagnostics are never treated as FAIL.
- Independently recomputed the monthly signed MA spread, slope, expansion ratio, bullish order and PASS value from PIT OHLCV for 30 actual NEAR/Zone Events; all matched. Partial monthly and biweekly bars use observations available by each Event date. No Event diagnostic date exceeded its Event date.
- Every ON candidate was also an OFF candidate on the same date. For shared candidate rows, Score and Score breakdown, all six Stage values, Status, MA1/MA2 and Zone distance matched exactly. Outcome tests kept the source Event hash and Return/MFE/MAE calculation contract unchanged; segmentation read saved Outcome rows with **0 OHLCV queries**.
- Three-month direct-scan timings varied with database cache: Monthly OFF 19.7-24.6 s, ON 20.2-24.7 s; Biweekly OFF 16.4-23.1 s, ON 10.0-24.7 s. One-year Monthly OFF: 41.9 s. These runs do not establish a stable speed improvement or regression. Production Monthly OFF Job completed in 32.4 s; its NEAR Outcome Job in 7.1 s; the production segmentation API returned in 185 ms (1 DB query, 0 OHLCV queries, 1,006 rows read).
- Approximate Event NDJSON size with diagnostics: Monthly 3M 6,612,560 -> 8,136,564 bytes (+1,524,004; +23.0%); Biweekly 3M 2,749,125 -> 3,380,737 bytes (+631,612; +23.0%); Monthly 1Y 22,756,758 -> 28,082,610 bytes (+5,325,852; +23.4%). Production stored Monthly 3M artifact: 8,144,388 bytes (manifest included).
- The production API and UI both reported Monthly NEAR PASS 45, FAIL 961, UNKNOWN 0 and the same 3M medians (+0.77% / +3.58%). Final production smoke: 139/139. No DB migration. Outbox and delivery-attempt counts were 5/5 before and after final deploy: Gmail sends from this work, 0.

This is descriptive and does not establish causality or a buy/sell recommendation. In particular, Monthly Zone PASS is a one-eligible-Outcome sample, and the 2025 sample may reflect market regime and repeated ticker observations.
