# Phase 15F: Prospective Confirmation

Phase 15F Complete: YES (monitoring contract and zero-new-data audit)

Frozen Forward Confirmation: WAITING

Outcome-Aligned Confirmation: WAITING

Production ML Gate: NO

## Executive Summary

At the 2026-09-18 market-data cutoff, the latest event with a mature 60-session
label is 2026-06-23. That is exactly the Phase 15E previously evaluated event
cutoff. New mature forward batches: **0**; new events, episodes, and tickers: **0**.
No historical event was reselected or scored to create a prospective result.
The prospective confirmation remains unobserved, not failed or successful.

The research-only `scripts/trigger_ml_phase15f_prospective.py` reads accepted,
immutable Phase 15E batches and joins their events to the existing outcome and
Path artifacts. It does not train, recalibrate, tune, schedule, or serve a model.
Phase 15F artifacts remain outside Git and SQLite under the existing StockBoard
research directory. No current batch artifact was created.

## Frozen Model Identity

| Contract | Frozen value |
| --- | --- |
| Model ID | `phase15c-20260920-v2/D0-60-mfe10/logistic` |
| Phase 15C spec SHA-256 | `4b1ae3f4ac878ab7857e56ff52563cb4c5b0b8ea408bf0331dbd5906f1785e38` |
| Encoder SHA-256 | `e8948a1d266ea8c3107096b95d3923dcfb18c93549b7111cbec1c64ff9201469` |
| Logistic model SHA-256 | `8a920f4225804563ce8b7de9c01ed81b2d5a8b036520af5ed9232410bbc80932` |
| Feature / label schema versions | `1` / `1` |
| Phase 15E plan SHA-256 | `90f6362fb0fdd664b5f1bf4748d9c6f70613b52c7c5a58ac79874adbebb2220d` |

The existing Phase 15E loader verifies the frozen plan, experiment spec, model
files, and feature registry. Phase 15F additionally verifies both schema
versions, source filters, MA periods, accepted-event identities and dates, and
two identical frozen inference passes against the stored prediction values.
The per-batch prediction SHA is retained when a new batch exists.

## Forward Batches

| Item | Current value |
| --- | ---: |
| Latest market date | 2026-09-18 |
| Latest mature 60-session event date | 2026-06-23 |
| Previous evaluated event cutoff | 2026-06-23 |
| New mature batches | 0 |
| New events / episodes / tickers | 0 / 0 / 0 |

Only `eventDate > previousEvaluatedEventCutoff` with an available 60-session
label at the new analysis cutoff may enter the existing Phase 15E append path.
That path excludes already used event keys, ticker/date pairs, and episodes.
Phase 15F never broadens that selection. Each accepted batch retains its ID,
evaluation date, event range, cutoff, sample counts, prevalence, frozen hashes,
calibration, quintiles, and metrics. Its Phase 15F join is a separate immutable
artifact keyed by the same batch ID. If joining is interrupted, `reconcile`
can be rerun; it refuses to replace a differing existing artifact.

Manual workflow after a new mature source dataset and corresponding Path
artifacts have been generated:

```sh
python scripts/trigger_ml_phase15e_forward.py append \
  --manifest /absolute/path/to/new-near-dataset.json \
  --db /absolute/path/to/stockboard.db
python scripts/trigger_ml_phase15f_prospective.py reconcile \
  --near-manifest /absolute/path/to/new-near-dataset.json \
  --below-manifest /absolute/path/to/new-below-zone-dataset.json \
  --db /absolute/path/to/stockboard.db
python scripts/trigger_ml_phase15f_prospective.py status \
  --db /absolute/path/to/stockboard.db
```

The script requires the new NEAR dataset to match an already accepted Phase 15E
batch. It cannot manufacture a new forward batch by itself. The BELOW_ZONE
dataset must have the same analysis cutoff and unchanged baseline filters.
There is no new scheduler; checking weekly or twice monthly is sufficient for
a 60-session label and is a manual cadence recommendation only.

## Cumulative Frozen Metrics

These are the unchanged Phase 15D/15E forward baseline, **not** new Phase 15F
observations. Cumulative metrics are recomputed from per-event predictions by
the Phase 15E registry, never by averaging batch AUCs.

| Metric | Baseline |
| --- | ---: |
| Events / episodes / tickers | 1,252 / 793 / 575 |
| Positive / negative | 517 / 735 |
| Positive prevalence | 41.29% |
| AUC | 0.590392 |
| PR-AUC | 0.493966 |
| LogLoss | 0.677949 |
| Brier | 0.242817 |

## Outcome-Aligned Prospective Cohorts

All four definitions are frozen from Phase 15E. Each future accepted NEAR
event stores `eventKey`, `episodeKey`, `ticker`, `eventDate`, label ID, label
maturity date, population eligibility date, and outcome. An unavailable Path
is `UNKNOWN_PATH`, never a false negative or a member of the conditional
population.

| Label | Fixed definition | Current new eligible |
| --- | --- | ---: |
| A | Snapshot MFE60 >= +10% and MAE60 >= -5% | 0 |
| B | Snapshot Return60 > 0 and MAE60 >= -5% | 0 |
| C | Lower close breach by D20, lower reclaim by D20, event-anchored Return60 > 0 | 0 |
| D | Same conditional lower-breach/reclaim population, event-anchored MFE60 >= +10% and MAE60 >= -8% | 0 |

C and D's eligibility is established only after the 20-session Path is
available. They are **not** D0 labels for a live general-candidate ranker.
No future path is used as an event-date feature. Current prospective positive
counts and outcome distributions for A/B/C/D are unavailable because there are
no new mature events; they are not filled with historical estimates.

## MFE vs Terminal Return Path Confirmation

Future event-anchored MFE60 >= +10% events are assigned to exactly one fixed
terminal-return band: `>+10%`, `(0,+10%]`, `(-10%,0]`, or `<=-10%`.
Within each band, the immutable batch records MAE60, dynamic Zone deepest
undershoot at 20/60 sessions, time to deepest, sessions below Zone, lower and
upper reclaim, lower-reclaim timing, and terminal Return60/MFE60. Missing
complete Paths are counted separately, not silently treated as no breach.
Current prospective band counts: **0 / 0 / 0 / 0**. The Phase 15E pre-Test
reference remains 1,072 / 708 / 240 / 89 events, respectively; it is not
merged into prospective observations or used to set new thresholds.

## BELOW_ZONE Prospective Research

The Phase 15E descriptive reference remains 1,199 events / 993 tickers,
median hit depth 0.76%, median deepest D20 -5.12%, median time to deepest
4 sessions, median lower reclaim 5 sessions, median Return60 +3.37%,
MFE60 +11.66%, MAE60 -6.98%. Those are historical reference values.
Prospective new BELOW_ZONE events: **0**. Future records retain depth at hit,
deepest20/deepest60, time to deepest, below-Zone duration, reclaim and
Return60/MFE60/MAE60; missing complete Paths remain explicit event records.
Only events dated after the immutable Phase 15E plan creation date are eligible
for this separate prospective BELOW_ZONE track.
No depth or reclaim threshold has been inferred from the reference.

## Calibration

The unchanged baseline five bins have predicted/actual positive rates of
29.49%/27.89%, 43.17%/39.04%, 49.02%/44.40%, 55.92%/46.80%, and
66.36%/48.40%. There is no new calibration observation. No refit is allowed.

## Prediction Quantiles

The unchanged baseline Q1-Q5 actual MFE10 ratios are 27.89%, 39.04%,
44.40%, 46.80%, and 48.40%. Q5 median terminal Return60 is -3.13% and
median MAE60 is -12.37%. Phase 15F adds no new quintile observation yet.
Future quintiles continue to show predicted probability, actual ratio,
terminal return and MAE together rather than claiming MFE alone is a payoff.

## Leakage / Integrity

- Market calendar and source DB are opened read-only. At the current cutoff,
  the mature-event boundary equals the prior boundary; no event was appended.
- The frozen feature registry and every parsed D0 row are checked for direct
  and transitive volume/liquidity features. Count: **0**.
- Feature source dates must not exceed `featureAsOfDate`; D0 future Path
  features: **0**. Outcome/Path dates must not exceed analysis cutoff.
- Existing Phase 15E append excludes old event keys, ticker/date pairs and
  episodes. Phase 15F verifies accepted identities and refuses cross-batch
  duplicate prospective labels or BELOW_ZONE events. Observed overlaps: **0**.
- Frozen inference replay and prediction SHA are required for every new batch.
  Current new-batch prediction hashes: **none** because there is no new batch.
- All runtime datasets, predictions, model files, and joined batch artifacts
  remain under Application Support, not Git or SQLite.

## Limitations

No independent post-2026-06-23 mature cohort exists as of this audit. The
prospective status therefore cannot be `OBSERVED` or `NOT OBSERVED` honestly.
Small future batches remain `INSUFFICIENT`; human review must assess multiple
time-separated batches, calibration, terminal returns, conditional label
populations, and BELOW_ZONE sample growth before any later gate discussion.
Phase 15F does not automatically promote a model to production.

## Decision

**Phase 15F monitoring contract complete; prospective confirmation WAITING;
Production ML Gate NO.** No UI, DB schema, production Trigger, Notification,
or Gmail integration was made. No deployment is required for research-only
scripts. Recheck manually after enough newly dated events have acquired
60-session labels, without changing the frozen definitions.
