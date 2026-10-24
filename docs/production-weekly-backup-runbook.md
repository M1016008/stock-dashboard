# StockBoard Weekly SQLite Backup Runbook

Status: implementation and synthetic QA complete. Production execution and
weekly scheduling are not authorized by this document.

## Fixed method

1. Re-identify the OWC source and encrypted SanDisk destination by physical
   serial, APFS volume UUID, mount, and canonical path.
2. Require a one-shot plan whose SHA-256, run ID, start window, source paths,
   prior generation, tool identity, limits, and operator approval all match.
3. Keep Web, Analog Search, Friend Gateway, and Web Health online. Temporarily
   boot out only the complete approved writer/coordinator allowlist. Preserve
   each label's prior loaded/disabled state.
4. Reject an active writer lock, unknown writer, daily-update overlap, source
   WAL over the approved cap, destination collision, or unhealthy read service.
5. Capture one JP/US generation while writers are held. APFS-clone the prior
   generation into a unique candidate and run the pinned official
   `sqlite3_rsync --wal-only` against JP and US. Both markets must finish under
   the same hold and generation ID.
6. Abort if the source WAL grows, the 150 GB destination reserve is crossed,
   the approved candidate-growth budget is crossed, a mount/identity changes,
   or the writer hold reaches eight hours. Restore only labels that were loaded
   before the hold; never enable an intentionally disabled label.
7. After both syncs, restore the prior writer state and verify that daily
   schedules are unchanged. Destination-only verification may continue while
   Production runs.
8. For both markets require SHA-256, `quick_check`, full `integrity_check`, a
   read-only reopen, and the same checks on an isolated APFS restore clone.
   Verification has one shared approval-plan deadline of at most 40 hours,
   including checks, restore clone creation, and hashing. It runs only against
   the candidate/restore files on the backup volume and must fit inside the
   overall execution window.
9. Recheck both market generation IDs and all checkpoint hashes. Publish a new
   `COMPLETE.manifest.json` atomically only after every check passes.

## Existing generation

The existing `ACQUIRED_WITH_LIMITATIONS` generation is immutable. It may be an
APFS clone seed, but it is never promoted or relabeled as verified. The new
candidate has to independently pass every current verification gate. Failed or
interrupted candidates remain unpublished and do not alter the prior generation.

The current prior-generation evidence is
`stockboard-offline-acquisition-20261023-v1/BACKUP_ACQUIRED_WITH_LIMITATIONS.manifest.json`.
Its approved manifest SHA-256 and the exact JP/US seed paths are frozen by each
one-shot plan. A mismatch is a preflight failure.

## Capacity contract

The candidate-growth budget is calculated as:

`destination free bytes - 150,000,000,000 reserve bytes`

The last measured values were 894.7 GB free and a 744.7 GB hard upper budget.
The synthetic 1% scatter mutation consumed about 5.83% of logical DB size, but
that observation is not a Production capacity guarantee. The first execution
plan must use current measured free space, WAL size, and a candidate-growth cap
no larger than the computed budget. A crossed reserve is a hard failure, not a
reason to remove the prior generation.

## Hold and runtime identity contract

Eight hours is an abnormal-stop ceiling, not an expected hold duration. The
normal hold covers only writer shutdown, JP sync, and US sync. Once both
candidate snapshots exist and runtime identity is rechecked, the exact prior
loaded/disabled states are restored before any destination integrity or restore
verification begins.

The sync monitor rechecks OWC/SanDisk identity throughout acquisition. It also
requires zero source WAL growth, unchanged source DB size/mtime, the approved
destination reserve, and the candidate-growth budget. A daily-update window
overlap, active writer lock, unknown writer, changed mount, UUID, physical
serial, or tool hash fails closed; the run is postponed rather than overlapped.

Pinned SQLite 3.54.1 tooling is stored outside Production under
`/Volumes/OWC Express 1M2 80G/StockBoard Development/tools/sqlite-3.54.1`.
Each one-shot plan fixes the sqlite3 and sqlite3_rsync SHA-256 values plus the
upstream archive SHA3-256. No binary is discovered from `PATH` at execution.

## First Production approval must name

- exact source and destination physical serials, volume UUIDs, mounts, and JP/US
  database paths;
- exact prior-generation ID and its `ACQUIRED_WITH_LIMITATIONS` status;
- pinned SQLite/sqlite3_rsync version and tool archive digest;
- one run ID, start deadline, finish deadline, writer-hold maximum, candidate
  growth cap, absolute WAL cap, and zero WAL-growth cap;
- approval for the backup-only Production SQLite read connections, temporary
  writer/coordinator hold, and new candidate writes on SanDisk;
- the operator responsible for abort and restoration of the prior LaunchAgent
  state.

Weekly LaunchAgent installation/enabling is a separate approval after one manual
generation completes successfully. The first run does not authorize automatic
deletion, rotation, Production schema changes, Storage Guard changes, or
research access.

The two optional SanDisk hardware-fixture scripts are separately gated by the
exact `STOCKBOARD_WEEKLY_BACKUP_HARDWARE_QA` confirmation phrase in their source.
Normal CI and ordinary npm invocation cannot write those fixtures.
