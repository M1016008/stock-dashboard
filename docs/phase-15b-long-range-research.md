# Phase 15B Long-Range Trigger Research

## Decision

- Phase 15B Complete: YES (dataset and research validation, not prediction deployment).
- 60-day ML Validation Gate: GO. D0/D5/D10/D20 have material Train, Validation and Test cohorts.
- 120-day Gate: GO. D0/D10, and also D20, have material independent cohorts.
- 245-day Gate: DEFERRED. Validation eligible is zero; no 245-day model was trained.
- ML signal: DESCRIPTIVE ONLY. The 60-day return models did not beat the Train-median Test baseline at any checkpoint. No model was integrated into production Trigger ranking or UI.

## Pre-change split feasibility

The existing policy assigns all rows of an episode by its earliest event. Features are frozen at each checkpoint; a label is available only after its forward horizon; Train and Validation rows are purged unless that label is available strictly before the next split boundary. The current embargo is zero. With one event at the first session of a split, the mathematical lower bound for one eligible observation in a finite split is checkpoint offset + label horizon + 1 sessions. This is not a sufficient sample-size target, and episode grouping can further reduce effective rows.

| Checkpoint | 20 | 60 | 120 | 245 |
| --- | ---: | ---: | ---: | ---: |
| D0 | 21 | 61 | 121 | 246 |
| D3 | 24 | 64 | 124 | 249 |
| D5 | 26 | 66 | 126 | 251 |
| D10 | 31 | 71 | 131 | 256 |
| D20 | 41 | 81 | 141 | 266 |

For 60-day D20, each Validation/Test segment needs at least 81 market sessions even to admit one earliest event; for 120-day D20 it needs 141. At a fixed 15% Validation fraction these minima imply approximately 540 and 940 total sessions, respectively, before considering meaningful cohort size. We fixed explicit chronological boundaries **before** generating the new dataset: Validation begins 2024-01-04; Test begins 2025-01-06. The source event window was selected for both segment width and usable feature coverage, not model outcomes.

The original one-year dataset `d8b19d1c-a79b-4e90-9da1-5c287212e787` remains immutable. Its pre-change eligible Train/Validation/Test and purged Train/Validation counts were:

| Checkpoint/horizon | Eligible T/V/Te | Purged T/V |
| --- | --- | --- |
| D0/20 | 2635/161/157 | 397/266 |
| D0/60 | 1961/0/149 | 1071/427 |
| D0/120 | 913/0/147 | 2119/427 |
| D0/245 | 0/0/4 | 3032/427 |
| D3/20 | 2633/124/156 | 359/293 |
| D3/60 | 1874/0/148 | 1118/417 |
| D3/120 | 866/0/147 | 2126/417 |
| D3/245 | 0/0/4 | 2992/417 |
| D5/20 | 2633/106/158 | 364/314 |
| D5/60 | 1834/0/150 | 1163/420 |
| D5/120 | 836/0/149 | 2161/420 |
| D5/245 | 0/0/4 | 2997/420 |
| D10/20 | 2611/60/158 | 377/362 |
| D10/60 | 1764/0/151 | 1224/422 |
| D10/120 | 756/0/150 | 2232/422 |
| D10/245 | 0/0/3 | 2988/422 |
| D20/20 | 2419/0/158 | 569/420 |
| D20/60 | 1613/0/152 | 1375/420 |
| D20/120 | 621/0/151 | 2367/420 |
| D20/245 | 0/0/2 | 2988/420 |

## Source coverage and chosen range

Underlying `ohlcv_daily` and `weekly_ohlcv` begin 2008-05-07; `daily_snapshots` begins 2008-05-13, with the first row having all six Stage values on 2010-05-06. `historical_universe` first-trade evidence reaches 2008-05-07. Stored `monthly_ma_monitor_daily` begins only 2026-02-10; the research scan reconstructs earlier Monthly MA from period-appropriate OHLCV, not present-day serving rows. Biweekly MA is reconstructed from historical weekly bars with the established fixed-bucket contract. ATR20 requires its own 20-session warm-up and is available for every selected D0 row. Earliest *universally* usable MA/Stage date cannot be stated from the table minimum alone: listing dates and warm-up differ by ticker. The empirically audited research window is 2022-09-13 through 2025-09-12, 736 market sessions; labels use historical OHLCV through the fixed analysis cutoff 2026-09-18.

Actual D0 feature missingness by source event year (percent; unavailable values remain null/UNKNOWN, never filled from current Stage):

| Year | Rows | MA slope | Day A | Week A | Month A | ATR20 | Spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2022 | 961 | 7.49 | 0.62 | 0.21 | 0.31 | 0 | 0 |
| 2023 | 1792 | 9.04 | 0.33 | 0.11 | 0.33 | 0 | 0 |
| 2024 | 3486 | 7.72 | 0.14 | 0.03 | 0.23 | 0 | 0 |
| 2025 | 2194 | 8.61 | 0.27 | 0.05 | 0.32 | 0 | 0 |

Other Stage-axis missingness is below 0.1% in most years. The one-year baseline's 2024-09 through 2025-09 source was too short for 60/120 Validation, not inherently devoid of historical price or Stage data.

## Long-range architecture and PIT audit

Compared approaches: one unbounded scan would defeat the existing 520-session safety cap and inflate memory; concatenating independent range artifacts would reset baseline, seen-ticker and episode semantics at every boundary. Chosen: internal CLI-only `researchLongRange` orchestration of existing scans in 180-session chunks (180/180/180/180/16). Each chunk fetches its own historical MA/liquidity/spread warm-up; only evaluation sessions are emitted. A single previous-candidate map and seen-ticker set carry across chunks, applying the existing ENTERED/RE_ENTRY/STATUS_CHANGED/EXITED derivation exactly once per session. Normal UI/API range limits, Trigger Engine and score rules remain unchanged.

The Monthly sparse-history reader previously retained only the last trade in each older month. For illiquid tickers this invented gaps of more than 60 calendar days. Both the scan and independent single-day read model now retain actual first **and** last trade dates per older month; the 2023-01-10 regression includes tickers 2050 and 2066. No Stage, Trigger or MA formula was changed. An initial v1 Monthly research artifact failed independent single-day comparison and was excluded; only audited v2 job `fd8c9c13-50c6-489b-bb3c-e735c7eae92d` fed Outcome/Path/Dataset.

- Monthly 20/25: 59 sampled dates (20 spread over the period plus each boundary +/- 5 market days), 8,181 candidate rows, exact ticker/status/score breakdown/price/MA/6-Stage/date agreement with independent single-day search. Complete event-stream replay SHA-256 matched. Four boundary continuity checks passed with no spurious events.
- Biweekly 25/44: 59 sampled dates, 14,754 candidate rows, the same exact agreement and complete event-stream hash replay. Four boundaries passed. Biweekly was audited as a source, not merged into the Monthly ML cohort.
- Monthly scan: 3,094 unique candidates; 59,071 events (ENTERED 2,896, RE_ENTRY 17,131, STATUS_CHANGED 18,905, EXITED 20,139). First session is baseline only.
- Outcome selector: NEAR_ENTERED, 8,433 observations, 2,281 tickers. Independent episode audit found 5,120 selected episodes, 2,059 with repeated selected events, zero sequence/mapping anomalies; 100 first and 48 selected episodes cross-checked.
- Path: 8,433 rows; 30 spread-across-source Batch Path rows exactly matched single-event Follow-up at all four horizons.

## Immutable dataset, split and balance

Canonical new dataset `9977384f-9d87-441c-98b7-2f3b8a818067`, SHA-256 `7431a27b6b4219fc7d77b02fb07c26066982fef7c06b6a7b7dd34942dbe52577`, 57,088 rows, 8,433 events, 5,120 episodes and 2,281 tickers, 288,195,126 NDJSON bytes. Manifest contains source date range, scan engine version, chunk ranges/size, source fingerprint and event hash, plus extensible `temporalFolds: [{ id: 'fold1', validationStart: '2024-01-04', testStart: '2025-01-06', embargoSessions: 0 }]`. Feature/label schema versions were not changed. Raw split rows: Train 18,957; Validation 23,868; Test 14,263. Checkpoint rows: D0 8,433; D3 8,322; D5 8,332; D10 8,319; D20 8,300; lower/upper reclaim 7,759/7,623.

Eligible rows after horizon-specific label availability and purge, Train/Validation/Test:

| Checkpoint | 20 | 60 | 120 | 245 |
| --- | --- | --- | --- | --- |
| D0 | 2256/2924/1994 | 1878/2077/1939 | 1491/1275/1892 | 838/0/1629 |
| D5 | 2222/2815/2004 | 1824/1971/1939 | 1481/1237/1901 | 811/0/1587 |
| D10 | 2207/2735/2012 | 1800/1897/1941 | 1471/1202/1899 | 705/0/1543 |
| D20 | 2140/2539/2022 | 1785/1673/1946 | 1454/1047/1905 | 586/0/1443 |

At 60 days, purged Train/Validation: D0 876/1413, D5 891/1480, D10 913/1545, D20 916/1769. At 120 days: D0 1263/2215, D5 1234/2214, D10 1242/2240, D20 1247/2395. At 245 days every Validation row is purged, exactly as required; the boundary was not moved. Test rows can be censored by the fixed data cutoff, rather than filled with future values.

60-day class balance (positive/negative, return > 0; MFE >= 10% positive in parentheses):

| Checkpoint | Train | Validation | Test |
| --- | --- | --- | --- |
| D0 | 1162/716 (929) | 995/1082 (848) | 1259/680 (937) |
| D10 | 1110/690 (868) | 841/1056 (653) | 1256/685 (926) |
| D20 | 1086/699 (808) | 669/1004 (520) | 1367/579 (1026) |

Dataset integrity passed full NDJSON byte/hash and 57,088-row schema validation, episode/event split isolation, 750 independently recomputed forward labels, 30 distinct-ticker samples per checkpoint, D0 event/snapshot identity, and Train-only feature registry checks. The Phase 15A Python audit rechecked all rows, label availability, source observation dates <= feature as-of, purge before boundaries, episode assignment, and all 8,433 D0 labels. Volume/liquidity/trading-value/turnover feature columns: **0**.

## Offline model check (not a deployment decision)

Same Phase 15A fixed seed 1514, Train-only preprocessing, ridge/logistic versus small deterministic LightGBM, Validation-only selection, single Test inference per experiment. 60-day D0/D5/D10/D20: return, return-positive, MFE >= 10%, and the secondary MFE >= 10% with MAE >= -5%; 120-day D0/D10 and 20-day D0/D5 comparisons. No 245-day training. Four D0/60 experiments independently replayed with the same dataset/config/seed and exactly matched selected family and Test metrics.

| 60-day task | D0 Test / baseline | D5 Test / baseline | D10 Test / baseline | D20 Test / baseline |
| --- | --- | --- | --- | --- |
| Return MAE (lower) | .0953/.0943 | .1013/.0972 | .1062/.0971 | .1195/.1096 |
| Return > 0 AUC | .507 | .507 | .510 | .488 |
| MFE >= 10% AUC | .613 | .594 | .584 | .521 |

D0/60 MFE log loss .678 versus baseline .693, but D5/D10/D20 MFE log losses .698/.713/.756 versus .693/.692/.703. Return-positive log loss was worse than baseline at all four checkpoints. D0/120 return MAE .1665 vs .1661 and D10/120 .1806 vs .1699. The enlarged source fixes evaluation feasibility, **not** predictive validity. Test distribution shifts (e.g. D20/60 return-positive prevalence 70.2% versus Validation 40.0%) further limit interpretation. No Test-guided feature, boundary, threshold or model change was made.

## Operational results and guardrails

| Stage | Wall / queries | Peak RSS | Main artifact |
| --- | --- | --- | --- |
| Monthly research scan | 98.3s / 30 | 1,586 MB | 67,955,313 B events |
| Outcome | 13.1s / 13 | 897 MB | 8,507,690 B rows |
| Path | 116.4s / 94 | 767 MB | 75,666,199 B rows |
| Dataset | 242.3s / 186 | 802 MB | 288,195,126 B rows |

All stayed below the existing 2 GB worker limit; no per-event N+1 query pattern. During dataset generation, `/` returned 200 in 1.72s, `/trigger-discovery` returned 200 in 0.03s, and an uncached Current Search returned 200 in 5.17s (5 SQL queries, under concurrent load). A CLI/worker ownership race was detected in the first Path attempt; the CLI was changed to enqueue-and-wait only, leaving the singleton worker as sole executor. Path completed on the worker's second attempt; the corrected pipeline reused it without repeating Outcome/Path calculation. The first Dataset artifact passed data audits but lacked newly added manifest provenance because the long-running worker had loaded old source. With no active jobs, the worker was restarted and a **new** dataset ID was generated with provenance; the earlier artifact was not mutated or used for ML.

No DB schema/migration, Trigger Score, UI, production ML inference or Gmail sender changed. Research artifacts live outside Git. SQLite remains approximately 509 GB; WAL was 5 MB after the run. Notification outbox and delivery-attempt row counts stayed at 5/5 (zero new sends).

Verification: `next typegen`, `tsc --noEmit`, Historical Scan and thin-history regression, Biweekly, Read Model, Path, Dataset, worker recovery, Python 7/7 tests, long-range 59-date audits, Outcome episode audit, Path 30-event audit, Dataset independent audit, and `git diff --check` passed. Formal `npm run web:deploy` built and promoted production Build ID `oUvilpUSCSqYkRtuwuV3Q`; smoke against port 3000 passed 150/150. Research-only Outcome jobs are excluded from the normal recent-job list. No commit or push was made.

Remaining limitations: a single fixed temporal fold, Monthly-only ML cohort, selected NEAR_ENTERED events only, 245-day Validation impossible in this range, incomplete MA slope for 7-9% of D0 events, and no statistically persuasive out-of-sample predictive signal. The new models remain offline research artifacts.
