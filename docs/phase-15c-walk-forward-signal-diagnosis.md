# Phase 15C: Walk-forward Robustness and Signal Diagnosis

## Executive summary and decision

- **Phase 15C Complete: YES. Signal Robustness: DESCRIPTIVE ONLY. Production ML Gate: NO.**
- The D0 / 60-session / snapshot-forward MFE >= 10% task was evaluated in three chronological, nonoverlapping Validation periods. Logistic Validation AUC was 0.649 / 0.666 / 0.698; small deterministic LightGBM was 0.663 / 0.590 / 0.619. The direction is more repeatable for Logistic than for LightGBM, but neither result establishes a production signal.
- After the experiment was frozen, the single Phase 15C Final Test access gave D0 Logistic AUC 0.629 and LightGBM AUC 0.619, versus a prevalence-only baseline AUC 0.5. Return-positive controls remained close to 0.5. Return regression did not robustly improve on the Train-median baseline across Validation folds.
- **The Final Test period is not a globally pristine holdout:** Phase 15B had already evaluated and reported metrics on this same 2025+ period. Phase 15C prevented *new within-phase* Test-guided design, but independent cohort replication is still required. Phase 15D independent cohort replication: **YES**, research only.

## Dataset and immutable provenance

Dataset `9977384f-9d87-441c-98b7-2f3b8a818067`, SHA-256 `7431a27b6b4219fc7d77b02fb07c26066982fef7c06b6a7b7dd34942dbe52577`, was verified unchanged before and after research. Source 2022-09-13 through 2025-09-12, 736 sessions; 57,088 snapshot rows, 8,433 events, 5,120 episodes, 2,281 tickers. No dataset rewrite, schema migration, Trigger calculation change, or production inference was performed. The prior one-year dataset remains untouched. Research ID `cd73991f-3ebe-4b1b-a622-98510ef4cb82` and all generated artifacts live under:

`/Users/yoshio/Library/Application Support/StockBoard/trigger-ml-research-15c/phase15c-20260920-v2/`

The earlier provisional Phase 15C run was discarded **as research evidence**, not deleted: its diagnostic table mislabeled 20/120-session quantiles as 60-session values and its Stage ablation retained a Stage-containing composite. The canonical v2 run kept the same Fold dates, models, features and seed; only those diagnostic semantics changed. No Final Test was accessed by either provisional or canonical Validation run.

## Leakage and forbidden-feature controls

- Pre-freeze loader hashed all NDJSON bytes but skipped `split=TEST` lines **before JSON decoding**. Plan and Validation each recorded 14,263 skipped Test rows, zero parsed Test labels and zero Test predictions. A unit test injects malformed Test JSON and proves the pre-freeze loader never parses it.
- For each Fold, episodes are assigned by earliest event. Rows whose event or feature date reaches the next boundary are excluded even if their episode began earlier; labels must be available strictly before that boundary. The D0 OOF artifact has zero episode overlap between its three Validation blocks (1,281 unique Validation episodes). Per-Fold Train/Validation episode intersection is asserted empty.
- Final Test was opened only after `experiment-spec.json` and its SHA-256 `4b1ae3f4ac878ab7857e56ff52563cb4c5b0b8ea408bf0331dbd5906f1785e38` were saved. The spec binds dataset/manifest, Fold plan, Validation artifact, both research source files, feature list/groups, preprocessing, model families/parameters, seed 1514 and label definitions. `test-access.json` was created exclusively at `2026-09-20T12:53:42.237825+00:00`, before parsing Test rows. A second `test` invocation is rejected. The final same-access deterministic replay made identical predictions and metrics for both primary models; it was not a new selection or Test-based tuning pass.
- Registry has 63 feature names (31 at D0). It excludes direct volume, liquidity, trading value and turnover columns. **Transitive audit:** saved Trigger total includes a liquidity component, so it is *not* a model input. The registered `scoreWithoutFlowComponent` equals exactly proximity + approach + MA trend + Stage structure on every decoded row. Source calculations in `lib/trigger-score.ts` confirm those four terms do not consume average trading value; liquidity is added only in the separate total. The audit-only `savedScoreAtHit` and breakdown never enter the encoder. Direct or indirect volume/liquidity model Feature count: **0**. The Trigger candidate universe itself is still selected under existing liquidity eligibility; this is cohort selection bias, not a model feature, and is not removed here.
- Feature values are PIT at each checkpoint. Labels are 60 sessions **after that checkpoint**, not after D0. D0, D5, D10 and D20 therefore have shifted target windows; their AUC differences are not a causal effect of waiting. The full 57,088-row Phase 15B audit re-passed, including source dates, label availability, purge, episode split assignment and 8,433 D0 label identities. No 245-day model was trained.

## Walk-forward Fold design and eligibility

The market calendar came from distinct `ohlcv_daily` dates and was independently matched to liquid ticker 7203: 565 pre-Test sessions. Boundaries were fixed **from sessions and D20+60 / D10+120 availability widths, not AUC or outcomes**. Primary: last three 140-session Validation blocks. Secondary 120-day: last two 180-session blocks. Expanding Train begins 2022-09-13. Embargo is explicitly 0; horizon-specific strict purge remains in force. All dates below are inclusive.

| Fold | Train end | Validation | Sessions Train/Val |
| --- | --- | --- | ---: |
| wf3-1 | 2023-04-17 | 2023-04-18 to 2023-11-09 | 145 / 140 |
| wf3-2 | 2023-11-09 | 2023-11-10 to 2024-06-07 | 285 / 140 |
| wf3-3 | 2024-06-07 | 2024-06-10 to 2024-12-30 | 425 / 140 |
| wf2-1 (120-day) | 2023-07-13 | 2023-07-14 to 2024-04-09 | 205 / 180 |
| wf2-2 (120-day) | 2024-04-09 | 2024-04-10 to 2024-12-30 | 385 / 180 |

Eligible Train/Validation rows after episode boundary and label-availability purge; the full per-Fold manifest in `plan.json` also records raw/purged rows, episode/ticker counts, class balance, checkpoint and horizon:

| Task | Fold 1 | Fold 2 | Fold 3 |
| --- | ---: | ---: | ---: |
| D0 / 60 | 979 / 401 | 1,707 / 670 | 2,801 / 930 |
| D5 / 60 | 921 / 371 | 1,678 / 616 | 2,746 / 829 |
| D10 / 60 | 856 / 335 | 1,644 / 570 | 2,704 / 762 |
| D20 / 60 | 730 / 257 | 1,575 / 443 | 2,587 / 540 |
| D0 / 120 | 967 / 328 | 1,890 / 763 | n/a |
| D10 / 120 | 844 / 221 | 1,784 / 692 | n/a |

For D0/60, purged Train/Validation rows were 492/488, 667/883 and 1,147/1,290 by Fold; for D20/60 they were 566/432, 563/759 and 960/1,324. These are intentionally not recovered by shortening purge. D0 MFE10 Validation prevalence was 53.9%, 51.6%, 44.3%; Final Test was 48.3%. D20 Validation prevalence was 53.3%, 51.0%, 32.2%; Final Test was 52.7%. Fold-specific return-positive balance is in `plan.json` and `validation.json`.

## Primary D0 MFE60: Fold, OOF and calibration

Both fixed families use the Phase 15B preprocessing and hyperparameters: Train-only median imputation/1%-99% clipping/scaling, Train-only category vocabulary, ridge/logistic alpha 10, and small deterministic LightGBM (120 rounds, leaves 15, depth 4, minimum leaf 50, seed 1514, one thread). No hyperparameter competition or Test-guided Feature selection occurred.

| Fold | Train/Val n | Train/Val MFE10 rate | Logistic Train/Val AUC | LightGBM Train/Val AUC | Logistic Val log loss | LightGBM Val log loss |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| wf3-1 | 979/401 | 47.0%/53.9% | .745/.649 | .890/.663 | .661 | .679 |
| wf3-2 | 1,707/670 | 50.5%/51.6% | .694/.666 | .840/.590 | .641 | .688 |
| wf3-3 | 2,801/930 | 50.2%/44.3% | .676/.698 | .793/.619 | .657 | .685 |

OOF predictions cover 2,001 Validation observations with nonoverlapping Validation dates/episodes. Logistic ROC-AUC **.666**, PR-AUC **.638**, log loss **.652**, Brier **.231**. LightGBM: .614, .576, .685, .245. Each Fold's Train-prevalence baseline pooled to OOF log loss .695 and Brier .251. Calibration uses five rank-quantile bins; Logistic mean prediction/actual rate by bin: .310/.279, .474/.403, .548/.485, .616/.578, .734/.690. The probabilities are not perfectly calibrated; OOF artifacts retain every event, Fold, actual and prediction.

Logistic OOF prediction quintile actual MFE10 ratios were **27.9%, 40.3%, 48.5%, 57.8%, 69.0%** (Q1 to Q5). The 60-day median return and MFE/MAE, mean return and return quartiles for every quintile are saved in `validation.json`. Q5 is a descriptive group, not a Buy/Best rank.

## D5/D10/D20, native versus common-event cohort

| Checkpoint | Native n / Logistic AUC / LGBM AUC | Common-event n / Logistic AUC / LGBM AUC |
| --- | --- | --- |
| D0 | 2,001 / .666 / .614 | 1,236 / .684 / .618 |
| D5 | 1,816 / .621 / .589 | 1,236 / .632 / .597 |
| D10 | 1,667 / .618 / .591 | 1,236 / .626 / .592 |
| D20 | 1,240 / .613 / .591 | 1,236 / .613 / .588 |

Common sets contain 255, 443 and 538 events by Fold with all four checkpoint snapshots and matured snapshot-forward labels. Attrition is material (D0 native 2,001 versus common 1,236), yet D0-to-D20 separation persists on the common cohort, so attrition alone does not explain it. Path-so-far removal reduced LightGBM D5/D10/D20 OOF AUC from .589/.591/.591 to .579/.589/.565; Path features carry some information, particularly at D20, but do not restore D0 performance. D0's target window ends earlier than D20's, and class rates vary by period, so neither Feature degradation nor cohort drift can be isolated causally. In the Final Test, D5/D10 Logistic AUC rose to .645/.637 while D0 was .629: a monotone checkpoint decline **did not replicate**.

## Drift, missingness and model diagnosis

Within pre-Test D0 folds, Train-to-Validation spreadPct PSI was .117/.024/.184; Month-A-Stage JS divergence was .059/.054/.057 bits. In the late pre-Test period versus Final Test, spreadPct PSI .054, zoneDistancePct PSI .040, MA1-slope PSI .070, ATR20 PSI .033, flow-free score PSI .039, Month-A-Stage JS divergence .071 bits. Month-A S3 share fell 27.9% to 12.7%, while S5 rose 5.8% to 16.6%; these describe a changed candidate mix, not a safety threshold. D0 eligible-fold MA1-slope missingness was ~1%-2.5%; Day-A Stage and ATR20 missingness were 0 in those cohorts. All per-feature/per-Fold/checkpoint missingness and category ratios are retained in artifacts.

Training-label permutation negative control shuffled only Training labels, never Validation labels: 20 repeats per Fold (60 fits) gave Validation AUC median **.503**, Q25/.Q75 **.473/.537**, min/max **.386/.610**. No p-value or significance claim is made.

Predeclared leave-one-group-out LightGBM ablation on Validation OOF (D0 all .614 AUC): minus ATR/Volatility **.598**, minus Stage **.609**, minus Spread **.610**, minus flow-free Score **.612**. ATR removal changed D0 AUC the most, but correlated features and Fold variation preclude causal attribution. Because the score composite embeds Stage, `-Stage` also drops that composite; `-Score` is separately reported. Groups are MA/Zone (18 source fields), Stage (12), Spread (7), non-liquidity Score (1), ATR/Volatility (4) and checkpoint Path-so-far (32, cross-cutting). No Volume group exists. Full D5/D10/D20 ablation results are in `validation.json`.

LightGBM gain top-10 sets had Fold-pair Jaccard .667/.667/1.0. MA2, ATR-normalized Zone distance and Zone width were repeatedly prominent. Gain is neither causal importance nor evidence of independent Feature value. LightGBM Train AUC .890/.840/.793 versus Validation .663/.590/.619 suggests overfit/instability; Logistic gaps were smaller. On representative Fold 3, chronologically expanding older Train history from 25% to 100% changed LightGBM Validation AUC .556 to .619 and Logistic .665 to .698. This is consistent with sample-size sensitivity but does not establish it as the sole cause.

## 120-day secondary and 20-day control

120-day MFE10 OOF AUC (Logistic/LightGBM): D0 **.561/.529**, D10 **.503/.524**; Final Test D0 **.550/.553**, D10 **.557/.568**. These are weak and based on two pre-Test Folds. 20-day MFE10 control OOF: D0 .647/.636, D5 .634/.618; Final Test: D0 .663/.677, D5 .693/.699. They are not the Phase 15C research target. No 245-day training or Test evaluation occurred.

60-day return-positive control OOF Logistic AUC D0/D5/D10: .500/.519/.511; Final Test .512/.526/.526. Return regression OOF MAE for Ridge D0/D5/D10: .107/.112/.108 versus Train-median baselines .101/.103/.100, so no consistent Validation improvement. On the single Final Test, D0 Ridge MAE .0937 versus baseline .0951 was small; LightGBM .0965 was worse. This isolated Test difference does not reverse the OOF control conclusion.

## Frozen Final Test, uncertainty and limitations

The sealed Test evaluated both *predeclared* families for all listed tasks without selecting a winner from Test. D0/60 MFE10 had 4,541 matured pre-Test training rows and 1,939 Test rows (1,181 Test episodes). Logistic Test ROC-AUC **.629**, PR-AUC **.597**, log loss **.673**, Brier **.239**; LightGBM .619/.581/.678/.242. Train-prevalence baseline log loss .693 and Brier .250. Logistic five Test bins had mean prediction/actual rates .239/.325, .388/.423, .459/.503, .522/.495, .633/.672. Test actual MFE10 quintile rates were 32.5%, 42.3%, 50.3%, 49.5%, 67.2%: endpoint separation remains, but the middle is **not strictly monotone**. The high-prediction quintile also had a worse median MAE than Q1, so this is not a risk-adjusted return claim.

Descriptive 200-replicate Episode-clustered bootstrap for D0 Test Logistic: AUC median .631, 95% interval **.602-.667**; Brier median .238, interval **.230-.245**. LightGBM AUC median .620, interval .595-.655. These intervals address within-cohort dependence only; they do not fix selection bias, temporal drift, repeated prior use of the same Test period, or an independent-universe replication gap. They are **not** a statistical significance declaration.

## Artifacts, runtime and operations

The external research directory contains `plan.json` (per-Fold counts), `validation.json` (OOF, class balance, drift, ablation, permutation, learning curve), `oof/**.ndjson`, frozen `experiment-spec.json`/`.sha256`, `test-access.json`, `final-test.json`, `final-test-predictions/**.ndjson`, encoders and offline models. Total size approximately **42 MB**; no prediction/model artifact was written into SQLite or Git. The older provisional v1 run is retained as an explicitly noncanonical audit trail.

| Step | Observed time |
| --- | ---: |
| Pre-Test plan/load/Fold generation | 4.7 s |
| Validation model training and OOF | 18.3 s |
| Permutation control (separately reprofiled) | 5.1 s |
| Ablation (separately reprofiled) | 15.8 s |
| Remaining Validation diagnostics/replay | ~0.9 s |
| Validation total | 44.0 s |
| Sealed Test dataset load/audit | 6.1 s |
| Sealed Test training/inference/artifact stage | 15.3 s |
| Sealed Test total | 21.8 s |
| Plan + Validation + Test total | ~70.5 s |

Representative Fold-3 D0/60 LightGBM microprofile (separate pre-Test run): pre-Test load/audit 4.50 s; Fold selection .62 s; Train-only encoder fit 1.13 s; matrix transform .55 s; model fit plus inference .63 s; independent inference .003 s; model artifact save .004 s. Peak RSS was 882 MB during Validation and 1,325 MB during the sealed Test (below the existing 2 GB worker ceiling, although this research ran in a separate offline Python process). Python/numpy/scipy/LightGBM versions: 3.12 / 2.5.1 / 1.18.0 / 4.7.0. No web-server training or runtime prediction.

QA: five new walk-forward contract tests passed; Phase 14D dataset fixtures, worker recovery, Historical Scan and Path Research regression passed; the unchanged 57,088-row Phase 15B leakage audit passed; OOF cross-Fold Validation episode overlap 0; flow/volume Feature count 0; canonical Dataset SHA unchanged; Validation same-seed replay and sealed Test same-access replay exact. TypeScript `tsc --noEmit` and `git diff --check` passed. Production smoke against port 3000 passed **150/150**. Production web source, UI, APIs and DB schema were not changed by Phase 15C, so no rebuild or deploy was performed; existing Build ID `oUvilpUSCSqYkRtuwuV3Q` stayed unchanged. Notification sender was not called; Outbox/delivery-attempt counts stayed 5/5 and Gmail new sends were 0. No commit, push, tag, reset, restore or clean was performed.

## Answers to the research questions

1. **Did D0 MFE10 recur?** Logistic Validation AUC exceeded .64 in all three pre-Test periods, and Final Test showed .629; LightGBM was less stable. This is descriptive within one Monthly NEAR-entered cohort, not a validated production signal.
2. **Why do later checkpoints weaken?** Attrition is real, but a common-event comparison still shows D0 versus D20 separation. Path features contribute modestly; LightGBM has Train/Validation gaps; class prevalence and Stage mix shift. Snapshot-forward target windows also shift. The evidence does not identify one causal explanation, and the monotone decline does not hold in Final Test.
3. **Which group mattered most?** In the predeclared LightGBM D0 ablation, removing ATR/Volatility changed OOF AUC most (.614 to .598). Correlation and composite overlap limit interpretation.
4. **Do prediction quantiles track outcomes?** OOF D0 Logistic MFE10 rates rose from 27.9% to 69.0% across Q1-Q5. Final Test retained Q1-Q5 endpoint separation (32.5% to 67.2%) but Q3/Q4 were not monotone.
5. **Did Final Test preserve Validation's relation?** Partially for D0 MFE10 ranking (Logistic AUC .629 versus OOF .666), not for return-positive or return-regression controls. The Test was already seen in Phase 15B, so a different cohort is required next.

**Next gate:** Phase 15D independent cohort replication may proceed as offline research (for example Biweekly NEAR or Zone cohorts). Production ML Gate remains **NO** regardless of the descriptive Phase 15C result.
