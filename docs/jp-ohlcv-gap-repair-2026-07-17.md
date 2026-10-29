# JP OHLCV gap repair: 2026-07-17

## Scope and evidence

This runbook covers the JP adjusted-OHLCV gap for the trading session
`2026-07-17`. It does not authorize a Production write.

Evidence captured on 2026-10-29 established:

- J-Quants accepted rows: 4,218
- Production rows: 151
- matching rows: 149
- missing rows: 4,067
- conflicting existing rows: 2 (`1447`, `2164`)
- no other session with the same scale of collapse from 2026-06-01 through
  2026-10-28
- official 1306 close: 407.9, adjustment factor 1
- official 7003 close: 4,434, adjustment factor 1

The two conflicts must be adjudicated separately. The repair program must not
overwrite them:

| Code | Production OHLC | Official OHLC | Volume |
| --- | --- | --- | --- |
| 1447 | 273.5 / 284.9 / 266.8 / 270.2 | 273.7 / 285.1 / 267.0 / 270.4 | 1,049,400 |
| 2164 | 112.8 / 112.8 / 104.8 / 108.2 | 113.0 / 113.0 / 105.0 / 108.3 | 82,100 |

The current official series shows later corporate-action boundaries, but does
not by itself prove how the older Production adjustment generation was derived.
Code 1447 has a later
`2026-09-11` adjustment factor `0.6675675675675675`; code 2164 has later
`2026-08-07` factor `0.6686626746506986` (and an earlier `2026-06-24`
boundary). The target-day volumes match, while the current official `Adj*`
values differ from the older Production generation. The exact transformation
lineage remains unresolved. Existing values therefore remain preserved and
HOLD. A separately approved full-history lineage audit and corporate-action
rebase is required before either row may be replaced.

Price basis is `jquants-adjusted-ohlcv-v1`. No interpolation, previous-close
substitution, or synthetic price is permitted.

## Root cause

The date-bulk requests for the affected session failed. The updater then moved
on to later sessions and the per-ticker fallback started from each ticker's
maximum stored date. It did not continuously re-audit internal historical gaps.
The daily coverage reference was also derived from the response being checked,
so a partial day could not be reliably distinguished from a healthy session.

The repaired updater uses an independent neighboring-session baseline, audits
historical trading dates, records safe HTTP error categories and retry attempts,
and exits nonzero while a gap remains.

That nonzero exit is intentional. Current-session rows may be fetched, but the
post-OHLCV refresh and successful completion state remain blocked until the
historical gap is repaired. This prevents later healthy sessions from masking
the incident. Production operations must not add a warning-only bypass; recovery
uses the separately approved repair transaction below.

## Required Production gates

Every gate is sequential. Failure stops the operation without continuing.

1. Approval and identity
   - Explicit approval names the date, official content hash, plan hash, and
     intended Source and Serving generations.
   - Re-fetch the official session immediately before execution and require its
     normalized content hash to match the approved evidence.
2. Quiescence
   - Confirm no Daily, Weekly, Trigger, historical scan, promotion, or backfill
     writer is active.
   - Acquire the existing writer/process lock atomically and retain it through
     verification and generation publication.
   - The external `repair.lock` is also a durable Writer Barrier. Normal lock
     acquisition returns deferred while it exists, including after process
     death. Only `jp_ohlcv_gap_repair` with the matching transaction ID may
     acquire the database writer lock. Invalid or unreadable barriers block.
3. Consistent backup
   - Capture a SQLite-consistent backup that includes the database, WAL state,
     schema identity, Source Generation, Serving Generation, and lineage.
   - Do not copy only the main database file and do not delete or checkpoint the
     Production WAL manually.
   - Verify the backup in an isolated location before the write transaction.
4. Plan revalidation
   - Read the target session under the approved read-only procedure.
   - Rebuild the plan and require exactly 4,067 missing keys and the separately
     approved treatment of the two conflicts.
   - Any additional, removed, or changed key is a HOLD.
5. Atomic insert
   - Insert missing keys only in one transaction with a unique `(ticker,date)`
     constraint and `ON CONFLICT DO NOTHING`.
   - A row-count mismatch or concurrent change rolls back the transaction.
   - Existing 151 rows remain byte-for-byte unchanged unless a later approval
     explicitly adjudicates the two conflicts.
6. Post-write verification
   - Verify key uniqueness, official values, adjustment factors, target-session
     coverage, neighboring-session coverage, and the 1306/7003 values.
   - Persist the before/after hashes and inserted key list.
7. Generation boundary
   - Publish a new Source Generation only after data verification succeeds.
   - Recompute only production-serving derivatives whose lineage references the
     old Source Generation.
   - Publish the Serving Generation atomically only after all required serving
     outputs validate. Never mix old and new generations.
   - Hold Web and Analog during the data commit, serving rebuild and generation
     publication. The current schema does not provide a universal pointer that
     atomically covers every DB-backed derivative, so leaving readers online
     would expose a mixed source/serving interval.
8. Health and observation
   - Run freshness and serving health checks, then the approved 1306/7003 API
     and chart smoke checks.
   - Observe the normal updater and data-quality monitor before releasing the
     writer lock and closing the repair journal.

## Derived-data boundary

The following production-serving outputs require lineage review and, where they
materialize OHLCV-derived values, recomputation from the new Source Generation:

- main-chart SMA values
- SMA Dynamics Lab inputs and cache
- current 6-stage serving outputs
- Stage History serving data
- Screener metrics
- Trigger and Historical Scan serving data
- related dashboard/API caches

Phase 3C, V6 Outcome research, Validation, and Holdout remain sealed. The repair
does not authorize starting those workloads. Any derivative that cannot be
rebuilt without crossing that boundary remains explicitly stale/HOLD rather than
being silently mixed with the new generation.

## Rollback and crash recovery

- Before generation publication, a transaction failure leaves Production data
  unchanged. The repair journal records the failure and inserted-key intent.
- After a committed data transaction but before Serving publication, retain the
  old Serving Generation and mark the new Source Generation unavailable to
  serving until verification finishes.
- If rollback is approved, restore the verified consistent backup as a complete
  generation operation. Do not delete only inserted rows from a live generation
  while dependent artifacts may reference it.
- An incomplete journal, hash mismatch, lock ownership ambiguity, or uncertain
  generation is Fail-Closed and requires operator adjudication.
- Rollback is a separately hash-approved transaction. Its approval binds the
  live journal hash, transaction ID, exact backup path/hash, database identity,
  and old Source/Serving generations. Restored bytes must hash exactly to the
  verified backup before the old serving generation can be accepted.

## Approval boundary

The isolated implementation, fixtures, dry-run, audit, Draft PR, and CI are
authorized. Production database writes, conflict adjudication, generation
publication, derivative recomputation, cache publication, and Production job
execution require a separate explicit approval after the final plan and backup
identities are known.

The Production transaction implementation pins the approval, official data,
plan, missing rows, preserved conflicts and derived plan hashes. It writes an
external fsynced journal before DB work, uses an exclusive writer adapter,
requires a verified SQLite online backup, and leaves every crash or ambiguous
stage in manual HOLD. Automatic retry and automatic cleanup are prohibited.

The hash stored as `derivedPlanSha256` binds the complete executable repair
plan: normalized official rows, the backup command, Web/Analog hold and resume
commands, Source Generation publication, derivative rebuild commands, serving
verification, and rollback commands. Every executable is bound by its realpath
and SHA-256. Interpreter commands cannot use inline `-e`/`-c`; every script is
also hash-sealed and executed from a transaction-local content-addressed
snapshot. Commands run without a shell, receive a non-overridable repair owner
identity, and must return JSON evidence. The approval also binds a separately
generated database identity hash covering the exact Production database/schema
generation being repaired. The
forward and rollback entry point is
`npm run execute:jp-ohlcv-production-repair -- --execute ...`. It additionally
requires `STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED` to equal the exact
approval hash, `USE_LOCAL_DB=1`, and an exact local database identity; Turso is
rejected. Build the executable plan from the separately sealed official-row and
command manifests with `npm run build:jp-ohlcv-production-execution-plan`.
`docs/jp-ohlcv-gap-repair-derived-plan.json` is design documentation only and is
intentionally rejected as an executable plan. Production execution remains
forbidden until the exact generated bundle, plan, database identity, backup
capacity, service-maintenance window and rollback are approved.

The repair runner holds both Web and Analog before `DATA_COMMITTING` and does
not resume them until the new Serving Generation passes health verification.
If either service transition fails, the external barrier and journal remain in
HOLD and the runner does not continue automatically.

Every detached stage command records its PID/process-group ID and executable
hash in the fsynced journal before its evidence can be accepted. Parent
SIGINT, SIGTERM, or SIGHUP terminates the complete group with TERM followed by
KILL and moves the transaction to HOLD. A parent SIGKILL or power loss leaves
the active group identity in the journal: status reports whether it is still
alive, and rollback is refused while it is alive. Once it is proven stopped,
the exact rollback approval must bind the stale group ID, confirmation time,
reason, and pre-recovery journal hash before the marker can be acknowledged.
Stage children receive only an allowlisted runtime environment plus the repair
owner identity; API and database credentials are not inherited implicitly.

Use `npm run status:jp-ohlcv-production-repair` for a read-only view of the
transaction ID, stage, protected paths, original failure causes and exact
operator action. It also reports the active stage process and liveness. A
non-clear state exits with code 2. Never remove a lock or journal merely to
make this status command pass; pre-write cleanup and post-write rollback each
require a separate hash-bound approval.
