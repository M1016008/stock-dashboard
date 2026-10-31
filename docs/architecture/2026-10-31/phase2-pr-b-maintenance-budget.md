# Phase 2 PR B: 12-hour candidate maintenance contract

## Decision

The existing repair cannot fit both a verified backup and an independently verified post-write
551 GB database inside its configured worst-case 12-hour window. Increasing timeouts would only
hide that contradiction.

The isolated design therefore separates snapshot preparation from the writer-hold window:

1. Under a short Writer Barrier, create an APFS byte clone with no DB/WAL/SHM/journal sidecars.
   Resume normal operation while that immutable snapshot is whole-file `quick_check`ed, hashed and sealed.
2. At the final writer hold, require a new measured live identity to be byte-equal to the sealed snapshot,
   with the same Source/Serving generation and no sidecars.
   Any intervening update fails before repair mutation and writers are restored.
3. Clone the sealed snapshot with `clonefile(2)`, apply repair and derived rebuild to the candidate,
   then independently full-check and hash the changed candidate.
4. Hold readers only for a separately reviewed atomic activation. Preserve the old live file as
   the rollback generation.

If any writer changed the source between the two barriers, the reuse proof fails before mutation. This may
require a deliberately quiet operating window; there is no automatic retry. This is not a Production
approval. The proof producer, atomic activation and rollback remain unimplemented blockers.

## Measured evidence

The contract records the existing 551,171,977,216-byte measurements:

| Operation | Measured | Configured maximum |
| --- | ---: | ---: |
| SQLite backup copy | 14m44s | snapshot-preparation aggregate |
| whole-file `quick_check` | 3h30m24.68s | 4h25m |
| SHA-256 | 14m7.79s | 30m |
| current derived rebuild | 46m6s | 2h20m |

Snapshot preparation has a separate 5h50m maximum, including a 5m Writer Barrier to produce the
sidecar-free APFS clone. The long verification runs after writers resume; exact byte equality and
generation identity are re-proved under the final Writer Barrier.

## Worst-case maintenance paths

| Path | Configured maximum | 12h reserve |
| --- | ---: | ---: |
| Normal candidate publication | 9h40m | 2h20m |
| Failure before activation | 8h55m | 3h5m |
| Failure after verification/resume plus bounded rollback | 10h20m | 1h40m |

The totals include 30m writer stop, 60m writer restore and 15m orchestration reserve. The failure path
includes generation/semantic verification, the first Read-service resume attempt, atomic rollback,
and a second Read-service resume. The rollback budget explicitly includes a second Read-service hold.
It retains the existing 90m minimum recovery margin because the
new rollback has not yet been measured at Production scale. Stage timeouts are not wired by this PR;
the table is a fail-closed contract for the later orchestrator integration.

## Comparison

| Design | Verification | Maintenance | Rollback capacity | Decision |
| --- | --- | --- | --- | --- |
| Existing in-place repair | Backup full check; post-write check cannot fit its 10m stage | Contradictory upper bounds | Requires an unavailable second full copy | Reject |
| Prevalidated candidate | Exact live/snapshot hash, independent post-write candidate check | Fits all configured worst paths | Old live file retained; atomic switch still to prove | Recommended for isolated implementation |
| Full versioned serving migration | Native immutable generations | Short publication hold | Pointer rollback | Long-term target, not the emergency repair |

No Production database, service, generation or runtime was changed.
