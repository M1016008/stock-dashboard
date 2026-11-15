# StockBoard Weekly SQLite Backup Runbook

Status: implementation and synthetic QA complete. Production execution and
weekly scheduling are not authorized by this document.

## Fixed method

Clone first, then sync (schema 2, owner decision 2026-11-15 after the v2 run failed because
Web/Analog, which stay online, wrote dashboard caches into the JP database during a 97-minute hold).

1. Re-identify the OWC source and encrypted SanDisk destination by physical
   serial, APFS volume UUID, mount, and canonical path.
2. Require a one-shot plan whose SHA-256, run ID, start window, source paths,
   prior generation, tool identity (sqlite3, sqlite3_rsync, the clonefile helper),
   limits, and operator approval all match. The preflight command requires the
   approved digest as `--expected-plan-sha256`; calculating and printing a new
   digest is not an approval substitute.
3. Keep Web, Analog Search, Friend Gateway, and Web Health online. Temporarily
   boot out only the complete approved writer/coordinator allowlist. Preserve
   each label's prior loaded/disabled state.
4. Reject an active writer lock, unknown writer, daily-update overlap, source
   WAL over the approved cap, destination collision, staging collision, source
   volume free space below `sourceReserveBytes`, or unhealthy read service.
5. APFS-clone the prior generation into a unique candidate on SanDisk (before
   the hold).
6. Under the writer hold, take one point-in-time snapshot of JP and US on the
   source volume (`lib/storage/locked-sqlite-snapshot.ts`):
   - open one pinned `sqlite3` connection per database with
     `.dbconfig no_ckpt_on_close on`, then `BEGIN IMMEDIATE`; both locks are
     taken before the first clone and held until the last one;
   - per market, clone the main file and then the WAL with the native
     `clonefile(2)` helper (`scripts/native/apfs-clone-file.c`: refuses an
     existing destination, never falls back to a full copy, then `F_FULLFSYNC`
     and a directory fsync) into `<stagingRoot>/<runId>/<market>/`; `-shm` is
     never cloned;
   - fail if a WAL's inode, size or header changed under the lock, a WAL
     appeared, a source path was replaced, or `maximumSnapshotLockMs` passed;
   - roll back and close. Nothing is written to Production. A source without a
     WAL gets an empty one from the lock connection (SQLite ignores an empty WAL).
   Web/Analog writes wait for the lock (busy timeout 5 s, 3 retries); a lock held
   longer than that fails those requests, which is why the lock limit is short.
7. Restore the writers. The hold is normally seconds plus writer stop/start.
   From here only the private clones and SanDisk are read; Production is not
   touched again, and later Production writes neither fail the run nor reach the
   generation.
8. Per market: checkpoint the clone's WAL into the clone (`PRAGMA
   wal_checkpoint(TRUNCATE)`, clone only), then `sqlite3_rsync --wal-only` from
   the clone to the candidate. The clone's WAL is not monitored (sqlite3_rsync,
   its only user, creates and removes it); the clone's size/mtime, the 150 GB
   destination reserve, the candidate-growth budget, volume identity and the
   source reserve are.
9. Verify per market: `quick_check` and full `integrity_check` on the **clone**
   (OWC, faster than the USB disk), a read-only reopen of the candidate, and
   equality of the candidate's and the clone's SQLite content digests (SHA-256
   with only the file change counter, bytes 24-27, and version-valid-for, bytes
   92-95, zeroed; sqlite3_rsync's commit on the replica bumps exactly those).
   Then the isolated APFS restore clone on SanDisk must equal the candidate's
   full SHA-256 and reopen read-only. One shared deadline of at most 96 hours
   covers the syncs and all checks.
10. Recheck the prior generation and the candidate/restore file identity (size,
   mtime, inode; not a second hash). Publish a new `COMPLETE.manifest.json`
   atomically only after every check passes.
11. Remove the staging clones in every case (success or failure). The
   source-volume reserve is checked about every second during syncs and checks,
   and every 1 GiB while hashing, until then.

`runWeeklyBackupGeneration` is the only acquisition/promotion orchestrator. A
failure leaves the candidate unpublished.

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

## Source volume (OWC) capacity contract

The clones share every block with Production when they are made. Each block
Production (or the clone's own checkpoint) rewrites afterwards is then stored
twice. `db-maintenance` never VACUUMs (`scripts/maintenance-db.ts`), so a day
is expected to cost a few GB, but that is not a bound. OWC holds Production, so:
- the plan's `sourceReserveBytes` (at least 300 GB) must be free before the hold
  and stays a hard floor until the clones are removed;
- a crossed floor stops the sync/check and removes the clones;
- after a crash, remove a leftover `<stagingRoot>/<runId>` by hand (see below)
  before anything else.

## Hold and runtime identity contract

Eight hours is an abnormal-stop ceiling, not an expected hold duration. The
hold covers writer shutdown, the post-stop gate, and the snapshot only. The
snapshot lock limit (`maximumSnapshotLockMs`, at most 5 minutes) is separate
and much shorter.

The sync monitor rechecks OWC/SanDisk identity throughout. A daily-update window
overlap, active writer lock, unknown writer, changed mount, UUID, physical
serial, or tool hash fails closed; the run is postponed rather than overlapped.

Pinned SQLite 3.54.1 tooling is stored outside Production under
`/Volumes/OWC Express 1M2 80G/StockBoard Development/tools/sqlite-3.54.1`.
Each one-shot plan fixes the sqlite3, sqlite3_rsync and clonefile helper
SHA-256 values plus the upstream archive SHA3-256. No binary is discovered from
`PATH` at execution. The helper is built once with
`cc -O2 -Wall -Werror -o <tools dir>/apfs-clone-file scripts/native/apfs-clone-file.c`
(placing it there needs approval) and its hash goes into the plan.

### Guarantee and accepted risks (schema 2, 2026-11-15)

Guarantee: JP and US in a published generation are the committed state of both
databases at the moment both write locks were held (one instant for both). It is
not guaranteed that a multi-transaction job, or one spanning JP and US, is
either wholly in or wholly out (accepted risks 1 and 2).

Operating rule: while writers are stopped, do not run manual `sqlite3`/Node
tools against Production, and do not operate on the StockBoard repository or
databases from the Codex app or from another Claude Code session.

Accepted risks (recorded, not coded):
1. A job (manual or an approved writer such as the resident
   trigger-historical-scan worker) that commits part of its work before the
   snapshot and the rest after leaves its partial state in the generation. The
   pre-start check below only shows that no writer was mid-job when it ran.
2. The update-lock and daily-window checks only observe one moment.
3. Only `com.stockboard.*` LaunchAgents and update locks are checked for
   writers; other writers are covered by the operating rule. A writer that
   ignores SQLite locks (direct file writes) is not excluded by the lock.
4. Observe mode calls `/api/health`, which writes the same storage-probe
   telemetry as `com.stockboard.web-health`; it does not write the databases.
5. Each runtime identity check runs `system_profiler` once per volume; see
   "Abort and writer restoration" for the stop latency.

## Abort and writer restoration

The plan's `maximumWriterHoldMs` is the hold limit (3 hours for the first
Production run). The CLI treats SIGHUP as an operator abort, so `nohup` alone
does not protect it from a closing terminal. Start it as one command line in a
single zsh, which records its PID, removes it from the shell's job table so that
closing the terminal sends it no SIGHUP, and keeps the Mac from idle sleep for
as long as the CLI runs (verification can take days):

```
nohup node --import tsx scripts/run-weekly-backup-generation.ts <execute arguments> > <log path> 2>&1 & cli_pid=$!; disown; nohup /usr/bin/caffeinate -i -w "$cli_pid" > /dev/null 2>&1 & disown; printf '%s\n' "$cli_pid" > <pid file>; ps -o pid=,command= -p "$cli_pid"
```

Replace each `<...>` placeholder with a quoted real path (the approval request
gives the exact line).

Start `node` directly (not through npm or a wrapper) so that `$!` is the CLI's
own PID; `;` keeps each step in the current shell, so `disown` acts on the
right job. The last command must print the CLI's `node` command line. If it prints
nothing, the CLI has already exited: treat the start as failed, read the log,
and follow step 3 below.

Then follow the log with `tail -f`. `caffeinate` does not prevent sleep from
closing the lid or from power loss.
Immediately before starting, record which approved writer labels are loaded
(the plan's `writerLabels`; readers and the capacity monitor stay online and are
never touched):
`launchctl list | grep com.stockboard > <pre-run label file>`. For each
writer label, also record its process group (`ps -o pgid= -p <pid>` for a
running PID) and its definition hash
(`shasum -a 256 ~/Library/LaunchAgents/<label>.plist`) in the same file.

Pre-start check (accepted risk 4): start only when every check below passes
(each looks for current writer activity or, for `updateWindowConflict`, a daily
update scheduled within the hold limit). It shows the state at the moment of the check only, and
it does not cover the trigger worker's own maintenance writes (recovery,
cleanup of expired rows and files, its lease).
- `launchctl list | grep com.stockboard`: every writer label other than
  `com.stockboard.trigger-historical-scan` shows `-` for its PID.
- the trigger worker has no claimed heavy job: this read-only query on the JP
  database prints `0` (a claimed job is `RUNNING`, or `CANCEL_REQUESTED` while
  it is being cancelled; the worker treats both as active):
  `<sqlite3> -readonly -cmd '.timeout 30000' <JP database> "SELECT (SELECT count(*) FROM historical_trigger_scan_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED')) + (SELECT count(*) FROM trigger_outcome_analysis_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED')) + (SELECT count(*) FROM trigger_path_research_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED')) + (SELECT count(*) FROM trigger_ml_dataset_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))"`
- the observe output shows `"writerLockOwners": []` (live update locks other
  than the resident trigger worker's own lease) and
  `"updateWindowConflict": false` (only the two daily update jobs: neither is
  running nor scheduled within the hold limit).
If any check fails, wait and repeat; do not start until all pass. A `RUNNING` or
`CANCEL_REQUESTED` row that does not clear (for example after a worker crash) is reported to the
owner instead of being changed.

0. **Snapshot failures.** If a lock cannot be taken within its wait, the lock
   limit passes, or a WAL changes under the lock, the snapshot releases its
   locks, removes what it created, and the hold restores the writers. The log
   shows `SNAPSHOT_...` inside `WRITER_HOLD_FAILED` and no `WRITERS_RESTORED`.
1. **Hold limit.** The hold now covers only writer stop, the post-stop gate and
   the snapshot. A hold that ends past `maximumWriterHoldMs` fails with
   `WRITER_HOLD_LIMIT_EXCEEDED` after `WRITERS_RESTORED`; the candidate stays
   unpublished. A sync that passes the shared 96-hour deadline is stopped
   (SIGTERM, then SIGKILL after 5 seconds) with `SQLITE_RSYNC_DEADLINE_EXCEEDED`.
2. **Operator abort.** Send `kill -INT <CLI node pid>`. The CLI does not exit on
   SIGINT/SIGTERM/SIGHUP; it fails its next runtime-identity check with
   `OPERATOR_ABORT_REQUESTED` (during the hold: before or after the snapshot;
   during a sync: within about a second, after which `sqlite3_rsync` is stopped),
   restores the writers if they are held, removes the clones and exits non-zero.
   Do not use `kill -9` on the CLI while writers are held.
   Each of the up to four identity probes per volume (diskutil, plutil,
   system_profiler, ioreg) times out after 15 seconds and a timeout fails the
   run, so in the worst case a stop can lag the signal by about two minutes.
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
5. **Leftover snapshot (only after a crash).** A lock connection whose parent
   died reads end-of-input, rolls back and exits without checkpointing
   (`no_ckpt_on_close`); confirm `pgrep -fl 'sqlite-3.54.1/sqlite3'` prints
   nothing. Then list `<stagingRoot>/<runId>/{JP,US}/` and delete only the
   files there (the clones and their `-wal`/`-shm`) and those two directories,
   never anything outside `<stagingRoot>/<runId>`.

Syncs and checks run after the writers are restored, so aborting then needs no
writer action. A running `quick_check`/`integrity_check` reads the clone, so stop
it with `pkill -INT -f '<stagingRoot>/<runId>'` (and signal the CLI): the check
fails, the CLI removes the clones and exits non-zero. Hashing runs inside the
CLI and stops at its next check. The CLI rechecks the abort flag after
postflight, immediately before publishing, so the candidate stays unpublished.

## First Production approval must name

- exact source and destination physical serials, volume UUIDs, mounts, and JP/US
  database paths;
- exact prior-generation ID and its `ACQUIRED_WITH_LIMITATIONS` status;
- pinned SQLite/sqlite3_rsync version and tool archive digest;
- one run ID, start deadline, finish deadline, writer-hold maximum, candidate
  growth cap, absolute WAL cap, and zero WAL-growth cap;
- approval for the backup-only Production SQLite connections (read, plus the
  two `BEGIN IMMEDIATE` lock connections that write nothing), the temporary
  writer/coordinator hold, the temporary clones under `stagingRoot` on OWC, and
  new candidate writes on SanDisk;
- the staging root, clonefile helper path and hash, `sourceReserveBytes` and
  `maximumSnapshotLockMs`;
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

## Point-in-time copy on OWC without a backup (P1 pre-deploy copy, rehearsal)

`scripts/run-locked-sqlite-snapshot.ts` uses the same snapshot module. Without
`--confirm=WRITE_APPROVED_LOCKED_SNAPSHOT` it only prints sizes and free space.

```
node --import tsx scripts/run-locked-sqlite-snapshot.ts --staging=<new dir on OWC> \
  --db=JP=<JP db> --db=US=<US db> [--db=<LABEL>=<other db> ...] \
  --sqlite3=<pinned sqlite3> --sqlite3-sha256=<hex> --clone-binary=<helper> --clone-binary-sha256=<hex> \
  --min-free-bytes=<n> [--max-lock-ms=60000] [--remove-after] [--confirm=...]
```

- Rehearsal: add `--remove-after`; the output gives `lockHeldMs`, elapsed time
  and free space before, after, and after removal.
- P1 copy: no `--remove-after`; the copy stays until its cleanup date in
  `docs/operations/P1-RUNBOOK.md`, and `dev-capacity-monitor` watches OWC free
  space hourly meanwhile.
- Every run is a Production operation (locks on Production, files on OWC) and
  needs the owner's approval first.

