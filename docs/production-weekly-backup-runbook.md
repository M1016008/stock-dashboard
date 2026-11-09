# StockBoard Weekly SQLite Backup Runbook

Status: implementation and synthetic QA complete. Production execution and
weekly scheduling are not authorized by this document.

## Fixed method

1. Re-identify the OWC source and encrypted SanDisk destination by physical
   serial, APFS volume UUID, mount, and canonical path.
2. Require a one-shot plan whose SHA-256, run ID, start window, source paths,
   prior generation, tool identity, limits, and operator approval all match.
   The preflight command requires the approved digest as
   `--expected-plan-sha256`; calculating and printing a new digest is not an
   approval substitute.
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
   or the writer hold reaches the plan's maximum (at most eight hours). Restore only labels that were loaded
   before the hold; never enable an intentionally disabled label.
7. After both syncs, restore the prior writer state and verify that daily
   schedules are unchanged. Destination-only verification may continue while
   Production runs.
8. For both markets require SHA-256, `quick_check`, full `integrity_check`, and
   a read-only reopen of the candidate. Then create an isolated APFS restore
   clone and require that its SHA-256 equals the candidate's and that it reopens
   read-only. The restore clone shares the candidate's blocks, so
   `integrity_check` runs once per market, on the candidate only (owner
   decision 2026-11-09, design B). Verification has one shared approval-plan
   deadline of at most 96 hours, including checks, restore clone creation, and
   hashing. It runs only against the candidate/restore files on the backup
   volume and must fit inside the overall execution window.
9. Recheck both market generation IDs and all checkpoint hashes. Publish a new
   `COMPLETE.manifest.json` atomically only after every check passes.

`runWeeklyBackupGeneration` is the only acquisition/promotion orchestrator. It
enforces the approved plan digest before writing, verifies the frozen runbook,
prior manifest, and SQLite tool binaries, applies one Writer Hold around the JP
then US syncs, restores writers, and only then starts the shared destination-only
verification deadline. A failure leaves the candidate unpublished.

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

Accepted risks (recorded, not coded; owner-approved 2026-11-09): each runtime
identity check runs `system_profiler` once per volume; the resulting stop
latency is the worst case given under "Abort and writer restoration". Only `com.stockboard.*` LaunchAgents and
update locks are checked for writers, so do not run manual `sqlite3`/Node tools
against Production during the hold. While writers are stopped, do not operate
on the StockBoard repository or databases from the Codex app or from another
Claude Code session. A write by such a tool changes the WAL's mtime (even when
SQLite reuses the WAL at the same length) or the main file's size/mtime; the
monitor checks these every second during each copy, and the runner compares
both markets' database and WAL files (device, inode, size, mtime, ctime) from
just after the writers stop to just before they are restored; any difference
fails the run without publishing. Observe mode calls
`/api/health`, which writes the same storage-probe telemetry as the existing
`com.stockboard.web-health` job; it does not write to the databases.

## Abort and writer restoration

The plan's `maximumWriterHoldMs` is the hold limit (3 hours for the first
Production run). Run the CLI detached from the terminal so that closing the
terminal cannot kill it:

`nohup <execute command> > <log path> 2>&1 &`, then follow the log with `tail -f`.
Immediately before starting, record which approved writer labels are loaded
(the plan's `writerLabels`; readers and the capacity monitor stay online and are
never touched):
`launchctl list | grep com.stockboard > <pre-run label file>`. For each
writer label, also record its process group (`ps -o pgid= -p <pid>` for a
running PID) and its definition hash
(`shasum -a 256 ~/Library/LaunchAgents/<label>.plist`) in the same file.

1. **Automatic stop at the hold limit.** The sync monitor stops `sqlite3_rsync`
   (SIGTERM, then SIGKILL after 5 seconds) when the hold deadline passes. The
   error propagates to the Writer Hold, which restores every label that was
   loaded before the hold, then the CLI exits non-zero. The candidate stays
   unpublished. The log shows `SQLITE_RSYNC_DEADLINE_EXCEEDED` (or
   `WRITER_HOLD_LIMIT_EXCEEDED` if the limit passes while writers are stopping
   or between markets) and no
   `WRITERS_RESTORED` phase line, followed by `FAILED`.
2. **Operator abort during the hold.** Send `kill -INT <CLI node pid>`. The CLI
   does not exit on SIGINT/SIGTERM/SIGHUP; it fails the next runtime-identity
   check with `OPERATOR_ABORT_REQUESTED`, stops
   `sqlite3_rsync`, restores the writers, and exits non-zero. Do not use
   `kill -9` on the CLI while writers are held.
   The monitor checks the hold deadline, then the abort flag and volume
   identity, about once a second. The identity probes normally take about one
   second together. Each of the up to four probes per volume (diskutil, plutil,
   system_profiler, ioreg) times out after 15 seconds and a timeout fails the
   run, so in the worst case a stop can lag the hold limit or the signal by
   about two minutes.
3. **After any non-zero exit,** confirm:
   - no `sqlite3_rsync` process remains (`pgrep -fl sqlite3_rsync` prints nothing);
   - every label that was loaded before the run is loaded again
     (`launchctl print gui/$(id -u)/<label>` returns 0), and no label that was
     unloaded or disabled before the run was loaded.
4. **Manual restoration (only if the CLI died without restoring, e.g. SIGKILL
   or power loss).** In this order:
   1. Stop a surviving copy: `pkill -TERM -f 'sqlite-3.54.1/sqlite3_rsync'`; if
      `pgrep -fl sqlite3_rsync` still prints it after 5 seconds, repeat with
      `-KILL`. Continue only when it prints nothing.
   2. For each recorded process group, `pgrep -g <pgid>` must print nothing
      (the old writer has fully exited).
   3. `shasum -a 256` of each plist must equal the recorded hash. If any
      differs, do not bootstrap it; report to the owner.
   4. Bootstrap only the labels that are in the plan's `writerLabels`, were
      listed in the pre-run label file, are not disabled, and are not loaded now:
      `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.
   Then confirm Web/Analog health and the active writer locks. Leave the
   candidate directory in place; it is never published without a new run.

Verification starts only after the writers are restored, so aborting during
verification needs no writer action. Send the signal to the CLI and to the
running `sqlite3` child (`pkill -INT -f '<generation root>'`, or Ctrl-C if the
CLI was started in the foreground): a check that is already running finishes
only when its process ends. The CLI rechecks the abort flag after postflight,
immediately before publishing, so the candidate stays unpublished.

## First Production approval must name

- exact source and destination physical serials, volume UUIDs, mounts, and JP/US
  database paths;
- exact prior-generation ID and its `ACQUIRED_WITH_LIMITATIONS` status;
- pinned SQLite/sqlite3_rsync version and tool archive digest;
- one run ID, start deadline, finish deadline, writer-hold maximum, candidate
  growth cap, absolute WAL cap, and zero WAL-growth cap;
- approval for the backup-only Production SQLite read connections, temporary
  writer/coordinator hold, and new candidate writes on SanDisk;
- the approved plan SHA-256 supplied unchanged to both preflight and execution,
  plus the canonical LaunchAgent definition hashes and executable paths used by
  the Writer Hold driver;
- the operator responsible for abort and restoration of the prior LaunchAgent
  state.

Weekly LaunchAgent installation/enabling is a separate approval after one manual
generation completes successfully. The first run does not authorize automatic
deletion, rotation, Production schema changes, Storage Guard changes, or
research access.

The two optional SanDisk hardware-fixture scripts are separately gated by
`STOCKBOARD_WEEKLY_BACKUP_HARDWARE_QA` having the exact value
`WRITE_ISOLATED_WEEKLY_BACKUP_FIXTURE_TO_APPROVED_SANDISK`. Normal CI and
ordinary npm invocation cannot write those fixtures.
