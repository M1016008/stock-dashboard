# Phase 15F-Ops: Frozen forward research operations

This is an offline research scheduler. It does not refit, approve, or serve an ML model,
change the Trigger Engine, send email, or write to the production web UI.
The Phase 15E plan, Phase 15D sealed model, encoder, logistic model and experiment
spec are verified by hash before either weekly or monthly processing. Feature and
label schemas remain v1. `trigger-v1.0` is unchanged.

## Cadence and commands

One local LaunchAgent (`com.stockboard.trigger-ml-frozen-monitor`) invokes
`npm run trigger:ml-monitor-scheduler` every Saturday at 09:00 host-local time
(the host must be set to Asia/Tokyo). Configure the weekday/hour/minute with
`TRIGGER_ML_MONITOR_WEEKDAY`, `TRIGGER_ML_MONITOR_HOUR`, and
`TRIGGER_ML_MONITOR_MINUTE` **when installing**. `RunAtLoad` plus persisted state
provides catch-up after login/restart; macOS coalesces missed calendar fires
after sleep. The scheduler checks elapsed time and month, not merely the firing
timestamp: weekly is due seven days after its last success; monthly is due when
the current JST month differs from the last completed cycle. Incomplete prior
months are recovered first under the same lock.
The last attempted mature cutoff is tracked separately from the last *accepted*
event cutoff: a month with no eligible events is not rescanned next month unless
the 60-session mature date advances.

```sh
npm run trigger:ml-monitor-status
npm run trigger:ml-monitor-weekly
npm run trigger:ml-monitor-monthly -- --dry-run
npm run trigger:ml-monitor-monthly
npm run trigger:ml-monitor-install
```

The status and monthly dry-run commands read only; neither takes a lock or
writes artifacts. Weekly status validates the frozen identity, Phase 15E/F
registries and integrity, latest 7203 market calendar date, 60-session mature
event cutoff and previously evaluated cutoff. With no later mature date it
records `NO_NEW_MATURE_DATA` and does **not** start historical jobs.

## Monthly pipeline

If the mature event date advances, the scheduler uses the existing
`run-trigger-research-long-scan.ts` twice (Monthly 20/25 NEAR and BELOW_ZONE,
with each cohort's baseline source job), then existing
`run-trigger-15d-dataset.ts` (Outcome, Path, ML Dataset) with the original
selector and split boundaries. The normal Period Scan UI limits remain intact.
Before frozen append it compares both complete dataset manifests to their
original manifests: source filters/config, timeframe/MA, selector, path/source
job, split policy, feature/label schema and analysis cutoff. It audits both
source artifact hashes, row counts and PIT rows. Any mismatch aborts before
append. DB market dates are read-only; existing worker job writes are limited
to the established research job pipeline (no migration).

Phase 15E `append` accepts only events later than the evaluated cutoff with
60-session mature labels, excludes earlier/boundary episodes, replays the sealed
model, and publishes an immutable batch. Phase 15F `reconcile` uses the same
accepted NEAR events, independently audited BELOW_ZONE rows, conditional
label A-D, and complete Path records. Operations publish one immutable Path
ledger per batch containing *all* accepted NEAR events (not just winners),
the separate BELOW_ZONE view/index and A-D records. Missing complete paths
are explicit. Volume/liquidity features are not added. Frozen inference,
source generation, and episode isolation are delegated to existing contracts.

Every month with no new data still creates a small report. With a batch, the
report recalculates baseline-plus-new event-level metrics using the Phase 15E
registry, includes batch metrics, five-bin calibration, Q1-Q5 and Q5 detail,
BELOW_ZONE depth/reclaim distributions using existing fixed bands and
conditional A-D population counts. A/B refer to general mature NEAR events;
C/D refer only to the future-conditioned lower-breach subset. No mean-of-batch
AUC and no outcome-based re-selection occur.

The *research review* gate is metadata, **not** a production approval:
500 cumulative new forward events **and** at least three disjoint mature
batches covering at least three calendar months. BELOW_ZONE has an independent
200-new-event review threshold. Only `RESEARCH_REVIEW_ELIGIBLE` is emitted;
neither gate starts training or changes any model/threshold automatically.

## Artifacts, lock, recovery

All artifacts are outside Git under
`~/Library/Application Support/StockBoard/trigger-ml-research-15f/ops/`:

- `opsState.json`: mutable last run and completed cycle, cutoffs, batch and gate.
- `runs/<runId>.json`: immutable append-only status/error audit.
- `starts/<runId>.json`: immutable run-start record; an absent finish record
  identifies an interruption even after a power loss.
- `work/<cycle>-<maturity>.json`: atomic stage checkpoint with scan/dataset IDs.
- `ledgers/<batchId>.json`: immutable complete Path/BELOW/label records.
- `reports/phase15f-monthly-YYYY-MM.md`: immutable research summary.
- `pipeline-logs/`: output of existing research CLIs; `ops.lock`: exclusive run lock.

Both operation artifacts and the Phase 15E/F batches are written to a temporary
file, fsynced, then atomically linked into place (or replaced only for mutable
state). A conflicting immutable file fails closed. `.pending` files are not
recognized as results. Re-running an incomplete cycle uses its saved source
IDs, validates them again, and looks up an accepted dataset ID in the Phase 15E
registry *before* append. A crash after the batch but before opsState therefore
does not create a second forward batch. A no-data cycle also records its pinned
cutoff in work state, so a crash after report publication cannot turn a retry
into a different month's result. If price history is revised while a
stage is running, source-fingerprint or manifest validation must fail closed;
inspect the saved work and job logs before manually retrying. A crash inside an
external job before its ID was checkpointed can leave an orphan research job;
it is never treated as an accepted batch.

If the LaunchAgent is unavailable, run the weekly/monthly commands above. To
inspect it: `launchctl print gui/$(id -u)/com.stockboard.trigger-ml-frozen-monitor`
and inspect `~/Library/Logs/StockBoard/trigger-ml-frozen-monitor.*`. To disable
the schedule without deleting artifacts:

```sh
launchctl disable gui/$(id -u)/com.stockboard.trigger-ml-frozen-monitor
launchctl bootout gui/$(id -u)/com.stockboard.trigger-ml-frozen-monitor
```

To resume, re-enable and bootstrap the existing plist or rerun the installer.
Never edit frozen artifacts/opsState to force a result. A failed frozen identity,
source contract, stale/incompatible partial job, or duplicate event needs an
explicit human investigation, not automated fallback.

No Gmail integration, no automatic retraining, no production ML integration,
no new schema, and no web rebuild/deploy are part of Phase 15F-Ops.
