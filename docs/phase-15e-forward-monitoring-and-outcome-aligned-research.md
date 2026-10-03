# Phase 15E: Frozen Forward Monitoring and Outcome-Aligned Research

- Phase 15E Complete: **YES**
- Frozen Forward Monitoring: **ACTIVE** (baseline fixed; no newly mature batch yet)
- Outcome-Aligned Research: **DESCRIPTIVE ONLY**
- Production ML Gate: **NO**

## Executive Summary

The Phase 15C D0 logistic model for snapshot-forward MFE60 >= +10% remains unchanged. Its Phase 15D forward predictions were reconstructed with the saved encoder/model and matched the previously recorded prediction SHA and all four metrics exactly. The append-only monitor is ready for a *new* source Dataset, but the 2026-09-18 data cutoff still matures events only through 2026-06-23, the exact Phase 15D event cutoff. **Forward batches: 0; newly mature events: 0.** No old events were moved into a convenient new evaluation window.

Separately, four prespecified outcome-aligned labels were studied on the original 2022-2024 pre-Test walk-forward folds. The study did not open Phase 15C Test or Phase 15D Forward rows for model selection. None of the four labels has independent forward confirmation. In particular, the apparently stronger C/D metrics are on a *future-conditioned* subset of events that later breached Zone Lower; they do not apply to the full NEAR population and cannot be used as D0 production ranking.

The original mismatch remains central: Phase 15D forward Q5 had 48.4% MFE>=+10% but median 60-session terminal return **-3.13%**. Reaching +10% once is not the same as ending higher.

## Track A: Frozen Forward Monitoring

- Evaluation plan: `docs/phase-15e-research-plan.json`, SHA-256 `90f6362fb0fdd664b5f1bf4748d9c6f70613b52c7c5a58ac79874adbebb2220d`.
- Frozen model ID: `phase15c-20260920-v2/D0-60-mfe10/logistic`. Encoder SHA `e8948a1d266ea8c3107096b95d3923dcfb18c93549b7111cbec1c64ff9201469`; logistic SHA `8a920f4225804563ce8b7de9c01ed81b2d5a8b036520af5ed9232410bbc80932`. Frozen experiment spec SHA `4b1ae3f4ac878ab7857e56ff52563cb4c5b0b8ea408bf0331dbd5906f1785e38`.
- Baseline: 1,252 events / 793 episodes / 575 tickers, 517 positive, 735 negative, prevalence 41.29%; event dates 2025-09-19 to 2026-06-23, labels available by 2026-09-18. Replayed saved-model prediction SHA matched Phase 15D, and per-metric values were bit-for-bit equal.
- Cumulative to date (baseline only): ROC-AUC **0.5904**, PR-AUC **0.4940**, LogLoss **0.6779**, Brier **0.2428**. Q5: mean prediction **66.36%**, actual MFE10 **48.4%**, median return60 **-3.13%**, median MFE60 **+9.53%**, median MAE60 **-12.37%**. Five calibration bins and all Q1-Q5 return/MFE/MAE medians are saved.
- A new batch accepts only D0 Monthly 20/25 NEAR events strictly after the prior evaluated event cutoff, with an actually available 60-session label by the new cutoff. The source scan must cover the 7203 market-calendar maturity date. Saved Trigger settings, Feature Registry, dataset integrity, model hashes, event identities and episode boundaries are checked. Prior events, ticker/date duplicates and previously evaluated episodes cannot re-enter. Identical frozen inference is replayed on the candidate batch before it is written.
- Every accepted batch is an immutable external JSON artifact with batch ID, evaluation timestamp, source Dataset, event span, cutoff, sample/class counts, prevalence, model/spec identity, four metrics, five calibration bins, Q1-Q5 and per-event frozen predictions/outcomes. `phase15eForwardBatchRegistry.json` is a regenerable index; cumulative metrics are recalculated on baseline **plus all distinct per-event predictions**, never by averaging batch AUCs. No refit, feature/threshold change or auto-calibration occurs.
- The monitor is an **offline, manually invoked** research command, not a new production scheduler. A future completed Historical Scan/Path/Dataset with the unchanged source contract must be supplied to `append`. On 2026-09-18 the 7203 read-only calendar yields 2026-06-23 as the latest mature event date, so a new batch would be invalid or empty today.

## Track B: Outcome-Aligned Labels

The label registry was saved outside Git before reading the new label results. All four definitions and populations are in the immutable evaluation plan. A/B use the **snapshot-forward 60-session** label at the relevant checkpoint. C/D use the **event-anchored 60-session** label and require a completed 20-session Path with a *close* below moving Zone Lower within that window; a first close reclaim by session 20 is part of the positive label. C/D are conditional on a future observation, so their apparent performance is not an implementable D0 universe-wide score. No -3% to -5% depth band was hard-coded.

| Label | Positive rule | Population |
| --- | --- | --- |
| A | MFE60 >= +10% and MAE60 >= -5% | Mature Monthly NEAR snapshot |
| B | Return60 > 0 and MAE60 >= -5% | Mature Monthly NEAR snapshot |
| C | Lower close breach by D20, lower reclaim by D20, terminal Return60 > 0 | Future-conditioned lower-breach subset |
| D | Lower close breach by D20, lower reclaim by D20, MFE60 >= +10% and MAE60 >= -8% | Same future-conditioned subset |

The exact Phase 15C three expanding, 140-market-session pre-Test Validation folds were reused. Train-only preprocessing and fixed Logistic alpha 10 are primary; deterministic 120-round LightGBM is secondary. Strict label/path-availability purge and episode isolation apply at every fold boundary. No Test or Forward outcomes were decoded or used for model choice. Full fold metrics, five-bin calibration and quintile medians/reclaim ratios for all 12 label-checkpoint tasks are in `phase15eResearchResults.json` and external OOF files.

| Label / checkpoint | OOF n | Positive | Logistic ROC / PR | LogLoss / Brier | LightGBM ROC |
| --- | ---: | ---: | ---: | ---: | ---: |
| A D0 | 2,001 | 606 (30.3%) | .528 / .316 | .631 / .220 | .500 |
| A D5 | 1,816 | 512 (28.2%) | .499 / .281 | .638 / .222 | .521 |
| A D10 | 1,667 | 502 (30.1%) | .517 / .311 | .640 / .224 | .547 |
| B D0 | 2,001 | 789 (39.4%) | .540 / .462 | .709 / .256 | .533 |
| B D5 | 1,816 | 667 (36.7%) | .562 / .439 | .707 / .254 | .565 |
| B D10 | 1,667 | 647 (38.8%) | .569 / .461 | .705 / .254 | .586 |
| C D0 | 674 | 186 (27.6%) | .600 / .358 | .594 / .200 | .551 |
| C D5 | 674 | 186 (27.6%) | .596 / .381 | .608 / .202 | .550 |
| C D10 | 674 | 186 (27.6%) | .659 / .431 | .579 / .191 | .641 |
| D D0 | 674 | 59 (8.8%) | .738 / .226 | .280 / .079 | .673 |
| D D5 | 674 | 59 (8.8%) | .768 / .259 | .271 / .077 | .689 |
| D D10 | 674 | 59 (8.8%) | .829 / .399 | .236 / .067 | .814 |

Calibration remains poor in the high bins: D0 Logistic Q5 predicted/actual was A **48.2%/33.3%**, B **67.9%/48.8%**, C **49.8%/41.0%**, D **32.2%/22.4%**. Q1-Q5 values are not uniformly monotone. D has only 59 positives, and its D5/D10 advantage is especially vulnerable to conditioning/selection and small-sample effects. These numbers must **not** be described as a Phase 15D signal improvement.

## Track C: MFE vs Terminal Return Path Diagnosis

Pre-Test D0 Monthly NEAR events with event-anchored MFE60 >= +10%, a matured label and complete 60-session Path were split *without fitting a model*. The four disjoint terminal-return groups total 2,109 events.

| Return60 | n | Median MAE60 | Median deepest Zone-low undershoot | Median time to deepest | Median below-Zone sessions |
| --- | ---: | ---: | ---: | ---: | ---: |
| > +10% | 1,072 | -2.01% | -1.77% | 15 | 0 |
| (0, +10%] | 708 | -3.31% | -2.75% | 30 | 0 |
| (-10%, 0] | 240 | -8.70% | -6.23% | 52 | 7 |
| <= -10% | 89 | -22.37% | -17.95% | 51 | 28 |

Lower/upper reclaim ratios and median timing are recorded per group. The weaker terminal-return groups experienced deeper and more prolonged below-Zone paths, **as an association only**. Some events reclaimed and subsequently failed; reclaim alone is not a success label. Path fields describe realized post-event trajectories, never D0 model inputs.

## Track D: BELOW_ZONE Research

The Phase 15D cohort was independently reconstructed unchanged: **1,199** eligible events / 1,199 episodes / 993 tickers, prevalence **56.0%** for the original MFE10 label. Its previous frozen transfer AUC was **.599**, while within-cohort OOF AUC was **.677** on 354 observations; this study did not promote or refit that model.

Descriptive distributions: median hit below-Zone depth **0.76%** (positive distance below lower bound); completed 20-session Path in **1,102** events with median deepest dynamic undershoot **-5.12%** and median time-to-deepest **4 sessions**; lower reclaim speed available in **766** events, median **5 sessions** from hit. All 1,199 had matured 60-session outcome labels: median Return **+3.37%**, MFE **+11.66%**, MAE **-6.98%**. Q25/Q75 and denominators are saved separately for each field. No new BELOW_ZONE event cohort is mature in this run, and no model optimization was performed.

## Leakage Controls

- Original Dataset SHA `7431a27b6b4219fc7d77b02fb07c26066982fef7c06b6a7b7dd34942dbe52577` verified. **14,263 Test lines were skipped before JSON decoding**, zero Test rows parsed for Track B. Forward rows used for new-label research: **0**.
- D0 model features: 31 EVENT-only. D5/D10 use only registered EVENT/CHECKPOINT values observed by their own `featureAsOfDate`; post-as-of source dates: **0**. Direct/indirect volume, liquidity, trading-value and turnover model features: **0**. The saved Trigger total (which includes liquidity) is audit-only; the flow-free composite is checked against its four non-liquidity components.
- Training/Validation episode overlap and cross-fold Validation episode overlap: **0**. The C/D population is future-conditioned for descriptive research but its defining Path and label must be available strictly before the fold boundary; no future Path value is encoded as a D0 feature.
- The exact frozen forward prediction SHA and metrics were replayed. The Phase 15E research was rerun independently: Track B/C/D results, eligibility, leakage audit and every OOF prediction file matched byte-for-byte or structurally after excluding timestamps/runtime.

## Limitations and Decision

The outcome-aligned labels were proposed **after** seeing Phase 15D's weak transfer and negative Q5 terminal median, so even pre-Test-only results are exploratory hypotheses, not independent confirmation. C/D additionally condition on an event that is unknowable at D0. Multiple events per ticker/episode are correlated; the pooled OOF metrics are descriptive and not a significance test. The original candidate universe still has liquidity-based eligibility even though the ML feature count is zero. Data source, event selector and 20/25 Monthly universe have not been replicated prospectively for the new labels. The 2026-09-18 data cutoff has no newly matured Forward batch. **Production ML Gate remains NO.** The next research step is to append genuinely new matured events to the frozen monitor and separately confirm or reject any outcome-aligned hypothesis in an untouched future cohort, without changing the frozen model or retrospectively selecting a better window.

## Artifacts, Reproduction and Operations

Git-tracked research source: `scripts/trigger_ml_phase15e_forward.py`, `scripts/trigger_ml_phase15e_research.py`, `scripts/test_trigger_ml_phase15e.py`, this document and the plan. The three required runtime artifacts, derived pre-Test labels and OOF predictions are **outside Git** under `/Users/yoshio/Library/Application Support/StockBoard/trigger-ml-research-15e/` (~20 MB). A separate reproducibility run resides in `trigger-ml-research-15e-replay/` (~20 MB). Existing Dataset files were read-only and unchanged.

To inspect the frozen monitor: `PYTHONPATH=scripts python scripts/trigger_ml_phase15e_forward.py status`. To append in a later data cycle: `PYTHONPATH=scripts STOCKBOARD_DB_PATH=<read-only database path> python scripts/trigger_ml_phase15e_forward.py append --manifest <new complete dataset manifest> --db <read-only database path>`. The new manifest must be produced by the existing Historical Scan/Path/Dataset pipeline with the same source contract; this command does **not** create scans, jobs, DB rows or notifications.

Observed runtime: monitor baseline initialization **5.79 s**, research **19.10 s**, independent replay **19.56 s**. Research peak RSS **882 MB**. DB schema/data changes **0**; UI/API changes **0**; production integration **none**; deploy **not performed** (existing Build ID `oUvilpUSCSqYkRtuwuV3Q` unchanged). Notification Outbox/delivery attempts remained **5/5** before and after; Gmail sends **0**. Python ML research regression **30/30**, TypeScript `tsc --noEmit` **PASS**, live port-3000 production smoke **150/150**, `git diff --check` **PASS**. No build was necessary because no production source changed. Existing dirty worktree files were retained; no commit, push, reset, restore or clean was performed.
