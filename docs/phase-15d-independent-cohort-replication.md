# Phase 15D: independent-cohort and forward-holdout replication

## Executive summary and decision

**Phase 15D Complete: YES. Forward Temporal Replication: OBSERVED, but weaker and poorly calibrated. Cross-Cohort Replication: MIXED. Signal Status: DESCRIPTIVE ONLY. Production ML Gate: NO.** These are descriptions of this one frozen experiment, not an investment or deployment decision. The original Phase 15C Monthly NEAR D0/MFE60>=10% Logistic AUC was .666 on pre-Test walk-forward Validation and .629 on its already-reused 2025 Test. The first event-disjoint, post-2025-09-12 Forward Holdout gave **.590** (Logistic and LightGBM), not .666. Its Q1-to-Q5 MFE>=10% rate rose 27.9% to 48.4%, but Q5's median 60-session return was **-3.1%** versus Q1's +0.8%, and Q5 probability was 66.4% versus 48.4% observed. A ranking relationship for a *maximum favorable excursion* target is not a return, risk, or trading claim.

The saved Monthly NEAR model transferred with Logistic AUC .587 to Biweekly NEAR, .612 to Monthly Zone, .565 to Biweekly Zone, and .599 to the below-Zone status-change subset. Cohort-native pre-Test walk-forward Logistic AUCs were .506, .638, .524, and .677, respectively; the last uses only 354 OOF observations and its first Validation fold has 45 rows. Transfer and native evidence do not tell a uniform story. No model, feature, threshold, Trigger Score, ranking, API, UI, daily evaluation, notification, or production inference path was changed.

## Pre-registration and frozen model

- The evaluation plan was saved **before access to new holdout labels** at `docs/phase-15d-evaluation-plan.json`; file SHA-256: `3f16282f235368c3f96a701685eca7f94f45fb7730856efbfe224564a9787f04`. It fixes all five cohorts, selectors, MA pairs, dates, target, checkpoint, metrics, and no-retune rule.
- Phase 15C canonical experiment-spec SHA-256 (canonical JSON): `4b1ae3f4ac878ab7857e56ff52563cb4c5b0b8ea408bf0331dbd5906f1785e38`. Dataset `9977384f-9d87-441c-98b7-2f3b8a818067`, artifact SHA-256 `7431a27b6b4219fc7d77b02fb07c26066982fef7c06b6a7b7dd34942dbe52577`, remained byte-identical.
- Primary D0/60 MFE>=10% model: saved 15C pre-2025-01-06 Train-only encoder `e8948a1d266ea8c3107096b95d3923dcfb18c93549b7111cbec1c64ff9201469`, alpha-10 Logistic artifact `8a920f4225804563ce8b7de9c01ed81b2d5a8b036520af5ed9232410bbc80932`, and 120-round LightGBM artifact `82d5fd020f3036bbb621288ddd4c2981f80374ae411b25749618aed04e11665b`; seed 1514. The exact 63-column registry and its **31 D0 EVENT-only features** were reused, including frozen train-only median/clipping/scaling, missing indicators, and unseen-category handling. Original saved-model predictions replayed exactly for all 1,939 original 15C Final Test rows.
- D5/D10/D20 and D0 return-positive/return-regression control models were fitted **only** on the original pre-2025-01-06 labeled Train pool (D0 4,541; D5 4,434; D10 4,364; D20 4,146) and hashed in external `prepared.json` at `2026-09-20T13:27:23Z`, before new-label access. Their recipe, registry, seed, and parameters match the pre-registered secondary contract. No 2025 Test or new Forward label was used for these fits.
- Initial holdout access: `2026-09-20T14:03:49.066685Z`, logged in `holdout-access.json`. An offline collector-key bug (`ridge` versus `logistic` for the regression control) stopped the first pass after its Sample Gate; it was fixed without changing any cohort, label, model, threshold, or metric definition. One same-input continuation was logged at `2026-09-20T14:06:32.105226Z`; the original access timestamp was retained. Frozen inference is repeated in-process and yields identical prediction vectors and SHA-256s.

## Sources, coverage, and sample gate

The existing long-range Historical Scan -> Outcome -> Path -> ML Dataset pipeline generated all five cohorts. All source filters other than pre-registered timeframe/MA, scan end, selector, or the below-Zone tolerance toggle were verified equal to the original research source. Ordinary UI's 520-session limit was not changed. Source event counts are *before* checkpoint/label maturity and, for the below-Zone job, before status subset selection. D0 eligible rows have one row per event.

Source scan IDs: original Monthly `fd8c9c13-50c6-489b-bb3c-e735c7eae92d`, original Biweekly `7e16ef00-0103-43e5-a195-a20cec772a85`, extended Forward Monthly `e42e6dd4-e3d8-4f46-b7d4-7a84bb0506d8`, and tolerance-enabled Monthly `88810d13-6d68-483d-8904-0b6ca4f2353b`. Every Dataset manifest records its exact Scan, Outcome, and Path job IDs and Source fingerprint.

| Cohort (selector; timeframe; MA1/MA2) | Source event range | Source events | D0 eligible: events / episodes / tickers | D0 positive / negative (prevalence) | Eligible D0 / D5 / D10 / D20 |
| --- | --- | ---: | ---: | ---: | ---: |
| Forward Monthly NEAR_ENTERED; Monthly 20/25 | 2022-09-14..2026-06-23; evaluated events 2025-09-19..2026-06-23 | 10,671 | 1,252 / 793 / 575 | 517 / 735 (41.3%) | 1,252 / 1,218 / 1,188 / 1,017 |
| Biweekly NEAR_ENTERED; Biweekly 25/44 | 2022-09-14..2025-09-12 | 15,875 | 14,078 / 4,778 / 2,023 | 5,846 / 8,232 (41.5%) | 14,078 / 14,069 / 14,071 / 14,064 |
| Monthly IN_ZONE_ENTERED; Monthly 20/25 | 2022-09-14..2025-09-12 | 4,555 | 4,134 / 3,045 / 1,887 | 2,007 / 2,127 (48.5%) | 4,134 / 4,134 / 4,135 / 4,132 |
| Biweekly IN_ZONE_ENTERED; Biweekly 25/44 | 2022-09-14..2025-09-12 | 9,713 | 8,705 / 3,844 / 2,045 | 3,861 / 4,844 (44.4%) | 8,705 / 8,696 / 8,696 / 8,679 |
| Monthly STATUS_CHANGED -> BELOW_ZONE; Monthly 20/25, tolerance enabled at 3% | 2022-09-14..2025-09-12 | 20,249 STATUS_CHANGED; 1,344 BELOW_ZONE subset | 1,199 / 1,199 / 993 | 672 / 527 (56.0%) | 1,199 / 1,199 / 1,193 / 1,194 |

The below-Zone cohort is specifically **STATUS_CHANGED to BELOW_ZONE**, not every event whose status is BELOW_ZONE; no Event Type or notification contract was added. Its 1,199 eligible D0 observations clear the pre-registered 40-row feasibility floor, but the native OOF subset remains much smaller. All four independent sources end on the preregistered 2025-09-12 boundary; their Test periods are not a newly pristine temporal holdout.

The Forward plan derives conservative checkpoint-specific latest event dates from the 7203 session calendar: D0 2026-06-23, D5 2026-06-16, D10 2026-06-09, D20 2026-05-26. Actual `labelAvailableDate<=2026-09-18` and row-level source-date checks are additionally required. Ticker-specific gaps removed 922 D0 rows as immature; 64 D0 rows were excluded because the episode began on/before 2025-09-12. One sparse `ohlcv_daily` date, 2026-07-17, has only 69 tickers versus >4,200 around it and is absent from 7203. Using the frozen 7203 calendar may truncate the possible tail by **one session conservatively**; it cannot admit an immature label. Dates were not moved after outcomes were viewed.

## Primary D0 frozen transfer

All metrics are one frozen application; no cohort-specific recalibration. PR-AUC must be interpreted beside prevalence. Values rounded to three decimals.

| Cohort | N | Prevalence | Logistic ROC / PR / LogLoss / Brier | LightGBM ROC / PR / LogLoss / Brier |
| --- | ---: | ---: | --- | --- |
| Forward Monthly NEAR | 1,252 | .413 | **.590 / .494 / .678 / .243** | .590 / .480 / .676 / .242 |
| Biweekly NEAR | 14,078 | .415 | .587 / .485 / .692 / .249 | .588 / .488 / .698 / .252 |
| Monthly Zone | 4,134 | .485 | .612 / .585 / .672 / .240 | .659 / .627 / .655 / .232 |
| Biweekly Zone | 8,705 | .444 | .565 / .499 / .694 / .250 | .580 / .510 / .702 / .254 |
| Monthly below-Zone transition | 1,199 | .560 | .599 / .649 / .704 / .255 | .629 / .670 / .676 / .241 |

Saved-model D0 return-positive controls had Logistic ROC-AUC .556 / .505 / .562 / .512 / .576 in the same table order. D0 return regression Ridge MAE was .1175 / .1095 / .1022 / .1136 / .1139. These are different targets, do not validate the MFE target, and do not imply realized-return usefulness. Full control metrics and LightGBM controls are in the external results artifact.

### Checkpoint sensitivity

The next table gives frozen-model ROC-AUC by D0/D5/D10/D20; each checkpoint uses its **own snapshot-forward 60-session target**, not a common outcome window. Attrition and shifting labels limit direct comparisons.

| Cohort | Logistic D0 / D5 / D10 / D20 | LightGBM D0 / D5 / D10 / D20 |
| --- | --- | --- |
| Forward Monthly NEAR | .590 / .586 / .577 / .537 | .590 / .601 / .594 / .572 |
| Biweekly NEAR | .587 / .565 / .594 / .590 | .588 / .591 / .609 / .610 |
| Monthly Zone | .612 / .636 / .635 / .615 | .659 / .681 / .655 / .660 |
| Biweekly Zone | .565 / .564 / .577 / .583 | .580 / .610 / .622 / .602 |
| Monthly below-Zone | .599 / .651 / .620 / .615 | .629 / .686 / .635 / .626 |

## Calibration and prediction quintiles

Logistic mean predicted probability versus actual D0 positive prevalence: Forward **48.8% versus 41.3%** (+7.5 percentage points); Biweekly NEAR 49.5% versus 41.5% (+8.0); Monthly Zone 49.2% versus 48.5% (+0.7); Biweekly Zone 51.7% versus 44.4% (+7.4); below-Zone 43.0% versus 56.0% (**-13.0**). The frozen probability scale does not transfer reliably. Every result artifact includes five bins with count, mean prediction, and actual ratio, plus Q1-Q5 and top-decile descriptive data.

| Cohort | Logistic Q1 -> Q5 observed MFE>=10% rates | Q1 -> Q5 median 60-session return |
| --- | --- | --- |
| Forward Monthly NEAR | 27.9 / 39.0 / 44.4 / 46.8 / 48.4% | +0.8 / +2.0 / +1.0 / -0.5 / **-3.1%** |
| Biweekly NEAR | 31 / 37 / 43 / 45 / 52% | +1.4 / +1.4 / +1.8 / +1.0 / +1.3% |
| Monthly Zone | 34 / 45 / 47 / 54 / 62% | +1.5 / +1.6 / +1.8 / +2.5 / +3.4% |
| Biweekly Zone | 36 / 41 / 45 / 48 / 52% | +1.8 / +1.6 / +1.6 / +1.5 / +0.9% |
| Monthly below-Zone | 44 / 51 / 59 / 57 / 69% | +1.6 / +2.7 / +3.6 / +3.2 / +4.5% |

Forward D0 Logistic quintile detail (all percentages are of the event snapshot price, not trade returns):

| Quintile | N | Mean prediction / observed positive | Median Return / MFE / MAE | Return Q25 / Q75 |
| --- | ---: | --- | --- | --- |
| Q1 | 251 | 29.5 / 27.9% | +0.8 / +6.1 / -4.3% | -5.5 / +7.2% |
| Q2 | 251 | 43.2 / 39.0% | +2.0 / +7.6 / -5.6% | -5.5 / +11.8% |
| Q3 | 250 | 49.0 / 44.4% | +1.0 / +8.7 / -6.7% | -5.6 / +10.2% |
| Q4 | 250 | 55.9 / 46.8% | -0.5 / +9.0 / -8.8% | -10.6 / +10.0% |
| Q5 | 250 | 66.4 / 48.4% | -3.1 / +9.5 / -12.4% | -15.4 / +8.2% |

The Forward LightGBM Q5 positive rate was 45.2% versus Q4 50.4%, so even the MFE quintile pattern is model-dependent. Full Q1-Q5 return/MFE/MAE and return-quartile records for **every** cohort, family, and checkpoint are in `results.json`; they were not used for feature or cutoff selection.

## Within-cohort walk-forward and own-cohort Test

The same three pre-2025-01-06 folds, 60-session purge, earliest-event episode assignment, frozen feature list, seed, and model hyperparameters were used. Native models are **secondary**, distinct from cross-cohort frozen transfer. No model was fitted on Forward Holdout events.

| Cohort | OOF Validation N | Native Logistic OOF ROC / PR / LogLoss / Brier | Native LightGBM OOF ROC | Own-cohort Test N; Logistic / LightGBM ROC |
| --- | ---: | --- | ---: | --- |
| Biweekly NEAR | 4,345 | .506 / .449 / .725 / .265 | .504 | 2,118; .583 / .563 |
| Monthly Zone | 1,092 | .638 / .647 / .670 / .238 | .608 | 1,156; .636 / .632 |
| Biweekly Zone | 2,783 | .524 / .486 / .718 / .261 | .511 | 1,413; .599 / .580 |
| Monthly below-Zone | 354 | .677 / .697 / .660 / .230 | .688 | 392; .639 / .635 |

Native fold-by-fold D0 Logistic ROC-AUC was Biweekly NEAR .530/.498/.540; Monthly Zone .633/.619/.664; Biweekly Zone .535/.529/.558; below-Zone .554/.649/.688. The below-Zone folds have only 45/85/224 Validation rows, so the apparent improvement is particularly uncertain. Validation episodes overlap **0** across folds in every cohort. Native own-cohort Test is a once-logged secondary result within already-used 2025 calendar time, not the pristine Forward Holdout.

## Distribution shift and integrity

Relative to original Monthly NEAR D0 Train prevalence 46.4%, D0 prevalence shifted by -5.1pp Forward, -4.9pp Biweekly NEAR, +2.1pp Monthly Zone, -2.1pp Biweekly Zone, and +9.6pp below-Zone. Numeric population-stability index for `eventFeature.spreadPct` was .033 Forward, **2.006** Biweekly NEAR, .164 Monthly Zone, **2.126** Biweekly Zone, and .027 below-Zone. Forward ATR20 median rose from 27.6 to 38.35 (PSI .108). Status distribution is intentionally disjoint (categorical JS divergence 1.0) for Zone/below-Zone cohorts versus NEAR Train. Because NEAR was the only Train status, Zone/below-Zone status uses the frozen encoder's UNKNOWN bucket; it was not re-fit. These are plausible descriptions of transfer difficulty, not causal explanations. Per-feature drift, missing ratios, Stage-category drift, and label-shift values are preserved in `results.json`.

- All **412,584** new Dataset rows were audited against the original 63-field registry, row/checkpoint dates, source observation dates `<=featureAsOfDate`, snapshot-forward label anchor and availability `>featureAsOfDate` and `<=2026-09-18`, censoring, derived D0 label, split purge, and the no-flow Trigger Score component. Registry-based direct or transitive volume/liquidity/trading-value/turnover features: **0**. Total Trigger Score was not a feature.
- The old and extended Monthly preboundary event streams (through 2025-09-12) had identical filtered SHA-256 `992918a5a39bf06de94c17a137feb10e3c8c8931ee6868e573b3400057d26594`. The 1,252 eligible Forward D0 events have **0** old event-date overlaps, **0** old event-key overlaps, **0** old ticker/date overlaps, and **0** old episode-key overlaps. The full event stream, not merely the selected NEAR subset, supplied first episode dates; 64 cross-boundary D0 episodes were excluded. Original 5,120 episode keys all mapped to the old event stream.
- The same frozen saved model replayed its original 1,939 Test predictions exactly. Repeated Forward frozen inference yielded bit-identical vectors and stored prediction hashes. Original Dataset SHA and Phase 15C frozen spec/model hashes were rechecked after the run. No future OHLCV, Outcome, Stage, or current value was used as a feature or imputation source.

## Operations, QA, and artifacts

| Dataset | Rows | NDJSON bytes | Dataset SHA-256 |
| --- | ---: | ---: | --- |
| Forward Monthly NEAR `4acc445c-1871-422e-92bc-51401023e767` | 70,887 | 351,861,883 | `86c35d20c1344e693249cc122db5639c55a6bd2af002a2b799e7daba6427269f` |
| Biweekly NEAR `40cde3fc-48ff-4f9d-9b7b-46eddfded0ed` | 107,519 | 555,166,881 | `d0ff229ca017d1db21523647fecc60e2c613c1e6c28e4be92c50619ed2908b9b` |
| Monthly Zone `ba3c21e7-84da-46dc-a89e-82635a3906c6` | 31,009 | 153,652,827 | `50a2b6421b6bbeb940fe78b047c8e6a0346fe5d6f30219bff1f253be1203b0c3` |
| Biweekly Zone `30a7b9d2-f788-49fd-ae7f-d37b79e35a22` | 66,109 | 337,808,941 | `4fc762ca61b86c26547c3cf25fdf0748e80f94e728f7430bba6b5fe45023d8fd` |
| Monthly below-Zone `7661f69c-f084-4239-921c-9a2dca813eac` | 137,060 STATUS_CHANGED-source rows | 689,327,831 | `0df4d07a9c1a77b6a2e9b3a3904a4c39f530b44036b4a4d73c5cc19d6ee8fe66` |

Dataset NDJSON total: **2,087,818,363 bytes** (external Application Support, not Git). Research output `results.json` is 763,986 bytes; `sample-gate.json`, model hashes, access and resume logs are alongside it at `/Users/yoshio/Library/Application Support/StockBoard/trigger-ml-research-15d/phase15d-20260920-v2/`. Newly produced source scans took 141.0 and 114.8 seconds; the five Outcome jobs totaled 169.8 seconds, Path jobs 971.3 seconds, Dataset jobs 1,523.7 seconds of reported stage runtime. Offline frozen-model preparation took 7.9 seconds (peak RSS 483MB); completed evaluation took **152.5 seconds**, peak RSS **853MB**. Dataset job manifests report peak RSS at most 946MB and peak V8 heap at most 1.07GB; the singleton worker retained its configured 2GB V8 heap limit. Heavy jobs ran while port 3000 passed production smoke **150/150**; no production performance or functionality contract was changed.

No DB migration/schema change and no application UI/API change. Existing job metadata rows and external runtime artifacts were added by the existing worker; SQLite main DB file remained 546,837,520,384 bytes at the final check (WAL is runtime data, not a source artifact). Production Build ID `oUvilpUSCSqYkRtuwuV3Q` was unchanged; **no build or deploy** was needed for research-only changes. Notification Outbox and Delivery Attempt totals stayed 5/5, so **new Gmail sends: 0**. `tsc --noEmit`, the Phase 15D 9-test suite, 15A/15C Python contract tests, Trigger ML Dataset and Path Research regressions, production smoke, and `git diff --check` passed. No commit, push, reset, restore, clean, or production ML integration was performed. A preliminary dataset attempt using non-session split date 2025-09-15 failed and remained as an audit artifact; the corrected 2025-09-16 session was chosen before any new label evaluation, not from observed outcomes.

## Answers, limitations, and next phase

1. **Forward D0 relation?** A weaker descriptive MFE ranking relationship was observed (.590 ROC-AUC, .494 PR-AUC; 41.3% prevalence), but the .666 Validation magnitude was not reproduced. Calibration was high by 7.5pp on average, Q5 by 18pp, and Q5 median realized return/drawdown was worse than Q1. Thus no actionable or production signal is established.
2. **Biweekly NEAR transfer?** Frozen Logistic .587 ROC-AUC, but native within-cohort OOF .506. The saved probability scale overpredicted by 8pp; the relationship is not robust across the two evaluation modes.
3. **Zone cohorts?** Monthly Zone showed frozen .612 and native OOF .638 Logistic ROC-AUC; Biweekly Zone showed .565 and .524. This is mixed, not a common Zone-wide claim.
4. **BELOW_ZONE feasibility?** Yes: 1,199 eligible D0 observations and both classes. Native OOF N=354, with a 45-row first fold; interpret carefully. Status-change-only selection and 56.0% prevalence differ sharply from NEAR Train.
5. **Calibration/quintiles?** Probability scale failed to transfer except approximately in Monthly Zone. MFE quintile separation is present in several cohorts, but not uniformly monotone, and Forward high quintiles had worse median returns and MAE. AUC alone is inadequate.
6. **Shift?** MA timeframe/Spread distribution, status, ATR and target prevalence visibly shifted. They could contribute to degraded transfer, but this analysis does not identify a causal driver.

Remaining limits: no episode-cluster confidence intervals, selection/overlap of tickers across independent cohorts, reused 2025 calendar Test for native models, one sparse market-session data anomaly, censored/missing OHLCV exclusions, and a target based on future maximum favorable excursion rather than a realizable trade. **Next recommended phase:** preregister another prospective, episode-clustered, as-of frozen replication and calibration audit after enough newly matured data accumulates; keep Production ML Gate closed and do not retune this 15D snapshot to defend a prior AUC.
