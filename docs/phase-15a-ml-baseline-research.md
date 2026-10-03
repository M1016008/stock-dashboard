# Phase 15A ML Baseline Research

## Executive Summary

**Phase 15A Complete: NO. ML Signal Observed: DESCRIPTIVE ONLY.**

The one-year immutable dataset supports a leakage-guarded 20-session pilot at D0, D3,
D5 and D10. It does **not** support the requested primary 60-session study, the
120-session comparison, or D20: eligible validation rows are zero after the
horizon-specific purge. No model was trained or tested for those blocked tasks.
No production inference, Trigger Score, candidate selection, UI, API, DB, or Gmail
delivery was changed.

The 20-session return models did not beat the training-median baseline on Test MAE.
The MFE >= 10% classifiers showed descriptive ranking differences, but only 19-22
positive Test cases per checkpoint and incomplete subgroup coverage. These results
do not establish a deployable prediction signal.

## Dataset

- Dataset ID: `d8b19d1c-a79b-4e90-9da1-5c287212e787`
- SHA-256: `25d26f6799903654e5c11fb8370b9ba212967ae898ee52a5e211f76cca014928`
- Source Git SHA: `76da6b50d9a06f6d6f5e832e68fb488c24abfc7d`
- 24,031 rows; 3,635 events; 2,169 episodes; 1,282 tickers.
- Event dates: 2024-09-13 through 2025-09-12; label cutoff: 2026-09-18.
- Source: MONTHLY, MA 20/25, NEAR_ENTERED only. No Biweekly or BELOW_ZONE examples
  in the Test cohort. The source search had liquidity filters, but model features
  contain **zero** volume, liquidity, average-volume or trading-value columns.
- Feature schema 1, label schema 1, path schema `trigger-path-v1`.
- Original NDJSON and manifest remain immutable under
  `~/Library/Application Support/StockBoard/trigger-ml-datasets/`.

## Leakage Controls and Split

The CLI verifies artifact byte size and SHA-256; uses only manifest feature-registry
columns; rejects future/label/outcome/flow names; checks every source observation
date is at or before `featureAsOfDate`; checks snapshot label anchor and availability;
checks every unpurged Train/Validation label is available *before* the next split
boundary; verifies episode isolation and earliest-event split assignment; verifies
all 3,635 D0 event-anchored labels equal their snapshot-forward labels; and checks
all 60-session derived flags against the source return/MFE/MAE values. No assertion
was waived to increase sample size.

Manifest boundaries: Validation starts 2025-05-30; Test starts 2025-07-23.
The apparent raw event-date overlap is expected because episodes are assigned by
their earliest event. Label-date purge is applied independently for each horizon.
All encoders, category vocabularies, clipping bounds, missing-value imputations and
numeric scales are fitted on Train only. Stage is one-hot, never ordinal.

| Checkpoint | 20 Train/Val/Test | 60 Train/Val/Test | 120 Train/Val/Test |
| --- | ---: | ---: | ---: |
| D0 | 2635 / 161 / 157 | 1961 / **0** / 149 | 913 / **0** / 147 |
| D3 | 2633 / 124 / 156 | 1874 / **0** / 148 | 866 / **0** / 147 |
| D5 | 2633 / 106 / 158 | 1834 / **0** / 150 | 836 / **0** / 149 |
| D10 | 2611 / 60 / 158 | 1764 / **0** / 151 | 756 / **0** / 150 |
| D20 | 2419 / **0** / 158 | 1613 / **0** / 152 | 621 / **0** / 151 |

For example, D0 raw Train/Validation/Test had 3032/427/176 rows; the eligible
20-session counts above are after label availability and purge. For D5 the raw
counts were 2997/420/174, and for D10 2988/422/174. The 245-session horizon was
not offered for training; the manifest reports eligible Train 0.

## Targets and Models

The CLI defines each target relative to the checkpoint's `featureAsOfDate`, never
the event date for D3/D5/D10. The experiment manifest records threshold definitions:
forward return, return > 0, MFE >= 10%, and the secondary 60-session
MFE >= 10% AND MAE >= -5%. The latter was blocked with the other 60-session tasks.

For each eligible task, Train median/prevalence is the naive baseline. Fixed-seed
ridge/logistic and one small deterministic LightGBM configuration are fitted on
Train. Validation MAE or Log Loss selects between the two. Only the selected model
is evaluated on Test, with a written Test-access record. No Test-guided tuning or
random split occurs. Research dependencies are isolated from the Next.js runtime:
Python 3.14, NumPy 2.5.1, SciPy 1.18.0, LightGBM 4.7.0.

## Regression Results (20-Session Snapshot Return)

All figures are Test out-of-sample. The baseline is the Train median, evaluated on
the same Test rows. MAE/RMSE values are fractional returns (0.04 = 4 percentage
points). Candidate models were chosen by Validation MAE.

| Checkpoint | n Test | Selected | MAE / baseline | RMSE / baseline | MedAE | Spearman | Pearson |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| D0 | 157 | LightGBM | .04843 / .04426 | .08586 / .08483 | .03151 | .083 | .072 |
| D3 | 156 | LightGBM | .04274 / .04010 | .05730 / .05746 | .03254 | .106 | .175 |
| D5 | 158 | LightGBM | .04305 / .03862 | .06365 / .06191 | .03403 | .091 | .077 |
| D10 | 158 | LightGBM | .04376 / .04061 | .06250 / .06062 | .03253 | .088 | .078 |

The D0 return prediction quintiles had mean realized returns of 0.3%, 0.1%,
0.8%, approximately 0%, and 4.8% from Q1 to Q5; this is not monotonic and the
overall MAE remains worse than the baseline. Top-decile n=15 is too small for a
standalone conclusion. Full quintile outcomes, including positive rate, MFE and
MAE, are in each experiment artifact.

## Classification Results (20 Sessions)

Train prevalence is the baseline. Test baseline ROC-AUC is .5. PR-AUC handles tied
scores by distinct probability groups, so constant predictions equal prevalence.

| Target | Checkpoint | Test +/- | Selected | ROC-AUC | PR-AUC | Log Loss / baseline | Brier / baseline |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| Return > 0 | D0 | 88/69 | LightGBM | .507 | .604 | .719 / .690 | .262 / .249 |
| Return > 0 | D3 | 91/65 | LightGBM | .609 | .691 | .691 / .702 | .247 / .254 |
| Return > 0 | D5 | 88/70 | LightGBM | .480 | .523 | .758 / .702 | .279 / .255 |
| Return > 0 | D10 | 81/77 | Logistic | .489 | .544 | .765 / .697 | .280 / .252 |
| MFE >= 10% | D0 | 19/138 | Logistic | .684 | .226 | .359 / .382 | .107 / .110 |
| MFE >= 10% | D3 | 21/135 | Logistic | .685 | .292 | .368 / .405 | .110 / .119 |
| MFE >= 10% | D5 | 22/136 | Logistic | .666 | .313 | .380 / .409 | .113 / .121 |
| MFE >= 10% | D10 | 20/138 | Logistic | .668 | .287 | .355 / .391 | .103 / .114 |

For D0 MFE classification, Test prevalence was 12.1%; its baseline PR-AUC was
.121. Calibration decile 1 had mean predicted 2.5%, actual 0/16; decile 10 had
mean predicted 39.7%, actual 4/15 (26.7%). The top decile appears overconfident,
and the small bins preclude a calibration claim. Full ten-bin calibration and
prediction quintiles are in the experiment artifacts.

## Checkpoint Comparison

The 20-session D0/D5/D10 return Test MAEs were .0484/.0430/.0438 versus their
separate baselines .0443/.0386/.0406. D5 and D10 observe 5/10 extra sessions,
respectively, and their eligible cohorts differ; cross-checkpoint differences
cannot be interpreted as a causal benefit of waiting. The D0/D5/D10 MFE Test
ROC-AUCs were .684/.666/.668 with 19/22/20 positive cases.

## Feature Importance and Ablation

Train-model gain or standardized absolute coefficient is saved per experiment;
it is **not** causal importance and does not use Test for selection. D0 return's
top LightGBM gain features included zone width, ATR20, MA1 slope, and
`scoreWithoutFlowComponent`. D0 MFE logistic coefficients emphasized
ATR-normalized zone distance, zone distance, and one-hot Stage indicators.

Validation-only 20-session return ablations removed Stage, Spread, Path and Score
one group at a time for D3/D5/D10. For D5, full-feature MAE .05135 compared with
no-Stage .05153, no-Spread .05071, no-Path .05045 and no-Score .05139. For D10,
full .05048 compared with no-Stage .05113, no-Spread .04647, no-Path .04189 and
no-Score .04983. These small, variable Validation cohorts do not justify changing
the production Trigger Score or feature set. The requested 60-session ablation was
not performed because its Validation cohort is empty.

## Subgroups and Limitations

Artifacts contain descriptive Test subgroups by timeframe, Month-A Stage, spread
pass/fail, and BELOW_ZONE/non-BELOW, marking n<25 as small. This particular source
dataset is Monthly only. D0 MFE Test had 147 spread-fail versus 10 spread-pass
rows, zero BELOW_ZONE rows, and no Biweekly rows. Those comparisons are therefore
unavailable or underpowered. A one-year single-cohort dataset and 60-160 row
Validation sets make any apparent ranking association fragile. No confidence
interval, external-market validation, or deployable inference claim is made.

## Reproducibility, Artifacts, and Performance

The independent replay of D0/20 return produced identical split counts, selected
model and Test metrics with seed 1514. Each experiment has a unique ID and stores
dataset/source version metadata, feature list, class counts, selection metrics,
model (`model.txt` or `model.json`), Train-only encoder, Test-access log, Test
metrics, calibration, quantiles, subgroup statistics and performance. A saved
LightGBM model was reloaded; its 104 encoded features matched encoder and manifest.

- Main summary: `~/Library/Application Support/StockBoard/trigger-ml-research/d8b19d1c-a79b-4e90-9da1-5c287212e787/summary-20.json`
- 60/120 gate summaries: same directory, `summary-60.json` and `summary-120.json`.
- Replay: `~/Library/Application Support/StockBoard/trigger-ml-research-replay/d8b19d1c-a79b-4e90-9da1-5c287212e787/summary-20.json`.
- Final 20-session batch: 12.34s wall, 2.04s dataset hash/load/audit,
  peak RSS 619 MB. Individual timing fields separate preprocessing,
  Train+Validation, Test inference and artifact preparation. No web-server
  process performed the training.
- Generated research artifacts occupy a few MB outside Git; DB increase 0.
- Production build stayed `glkKXKiA1rRObCcD2J6j9`; no deploy or Gmail send.

## Decision

**Next Gate: extended historical dataset and leakage-safe 60-session Validation.**
The 20-session research pipeline is technically usable and reproducible, but the
Phase 15A primary horizon cannot pass its Train/Validation/Test gate with this
dataset. Do not integrate these models into Trigger production. Preserve the
immutable dataset, expand the historical source in a separate phase, rerun the
same audits, and only then evaluate 60/120 sessions. The 245-session horizon is
explicitly deferred and was never trained here.

Run the focused guards with `python scripts/test_trigger_ml_research.py`. Run
the read-only data audit with `python scripts/trigger_ml_research.py --manifest
<path-to-manifest> --audit-only`. Research dependencies are pinned in
`scripts/requirements-trigger-ml-research.txt`; use a separate Python environment.
The executed pilot used:

```sh
python scripts/trigger_ml_research.py \
  --manifest "$HOME/Library/Application Support/StockBoard/trigger-ml-datasets/d8b19d1c-a79b-4e90-9da1-5c287212e787.json" \
  --horizon 20 --checkpoints D0,D3,D5,D10,D20 \
  --targets return,positive,mfe10 --ablation
```

The focused Python guards passed 7/7. Existing Phase 14D dataset PIT/split/label
fixtures and worker recovery tests passed. Python syntax compilation and
`git diff --check` passed. No TypeScript or Web files changed, so no new Web build
or production smoke was run for this offline-only research step.
