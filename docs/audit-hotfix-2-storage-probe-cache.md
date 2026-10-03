# AUDIT-HOTFIX-2: Storage Probe Reliability and Rebuildable Cache Isolation

## Incident and recovery

- Production incident: `9f280c56-2a78-44f2-a7c4-fa6fd091eb3d`
- Failure stage: `DISKUTIL_INFO`
- Attempts: three; all ended with `SIGPIPE` after 10.704s, 10.697s, and 8.426s.
- The 8-second command timeout was not increased. The elapsed time includes child termination and pipe teardown.
- Physical evidence remained stable: the APFS volume was mounted, its UUID and device matched, it was writable, the main DB and WAL/SHM were present, and no detach or storage I/O error was observed.
- All loaded StockBoard LaunchAgents were stopped gracefully and DB/WAL/SHM handles reached zero.
- Formal `storage:recover` completed 21/21 observations and archived the latch with resolution `TRANSIENT_CHECK_FAILURE`. The incident and probe-event originals remain intact.
- The pre-deploy baseline then returned HTTP 200 for health, quote 7003, stock 7003, and Trigger options; the Historical worker was running.

## Root cause and probe lifecycle

The guard already separated `PROBE_FAILED` from confirmed storage failure and blocked writes during confirmation. The remaining reliability gap was probe coordination: every Node process and every guarded DB could start its own synchronous `diskutil info -plist` certification for the same volume. The incident log did not record successful probe starts, so the exact historical concurrent count cannot be reconstructed. Source inspection proves that the pre-fix upper bound was unbounded across processes, and the audit window had Web, Analog, Historical, US analytics, and audit readers active.

The fix adds a Volume-mount-keyed coordinator on the internal incident disk:

- one cross-process lock permits at most one full `diskutil` certification per volume;
- concurrent callers share a two-second certified result after validating the current mount device;
- a stale lock is only removed after its owner is gone;
- a bounded waiter never starts a second competing full probe;
- `PROBE_UNCERTAIN` continues to block new DB transactions and business-operation retries;
- confirmation now permits a fourth serialized certification, so three transient process failures followed by a valid UUID certification do not create a permanent latch;
- confirmed mount loss, UUID mismatch, device change, read-only/full required storage, and SQLite/OS I/O errors remain immediately fatal.

An eight-process isolated regression produced one full certification. SIGPIPE fixtures verify three transient failures followed by a successful certification with no latch. Permanently failed certification, UUID mismatch, mount loss, device change, and EIO fixtures still create `FAILED_SAFE`.

## Resource criticality

| Resource | Criticality | Missing behavior | Fatal scope |
| --- | --- | --- | --- |
| `stockboard.db` | `PRIMARY_REQUIRED_DB` | fatal | shared volume latch |
| US analytics DB | `REQUIRED_DERIVED_DB` | unavailable/fatal under its existing required contract | shared volume latch |
| MA trajectory shadow DB | `OPTIONAL_READ_ARTIFACT` | `available=false`, no file creation | feature-local |
| Analog sequence index | `OPTIONAL_READ_ARTIFACT` | `meta=null`; an existence/open race is also feature-local | feature-local unless confirmed volume failure |
| API serving cache | `REBUILDABLE_SERVING_CACHE` | reads return cache miss; write path may recreate | feature-local unless confirmed volume failure |

The serving cache is not a source of truth. Its consumers are JP Screener, Period Explorer, ML Pattern Search, US Screener, Historical Analogs, and Backtest Coverage. A missing cache now behaves as a miss without creating a file on the read path. A later cache write may rebuild it after full writable-volume verification. Cache-local corruption or schema mismatch is feature-local; EIO, ENODEV, read-only/full storage, mount loss, device change, and UUID mismatch remain volume-fatal.

The repository-wide scan found no additional optional SQLite resource that should be changed in this hotfix. Required source/derived databases retain their existing fatal contract. Runtime research files and generated datasets are feature-local artifacts and do not use the primary DB guard path.

## Scope

- Phase 16 code and contracts: unchanged.
- DB schema/migration: none.
- Production DB destructive writes: none.
- Runtime DB, WAL/SHM, incident logs, environment files, and credentials are excluded from Git.
- P2 audit issues are intentionally unchanged.
