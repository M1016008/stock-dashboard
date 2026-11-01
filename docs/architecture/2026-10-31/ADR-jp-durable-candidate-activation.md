# ADR: Durable JP candidate activation contract

Status: isolated software-crash contract `PARTIAL`; Production `HOLD`

## Decision

Keep the PR #45 `AtomicBundleActivationJournal` as the only activation state
machine. Add a filesystem adapter that persists each existing transition; do
not introduce a second Recovery orchestrator.

Before the swap, `SWAP_INTENT` is valid only after this sequence completes:

1. verify both bundle manifests and their sealed integrity receipts;
2. verify DB/WAL/SHM byte hashes once under the Reader/Writer barrier;
3. atomically acquire the pending artifact before evaluating journal CAS;
4. validate existence/CAS and write/fsync the pending write intent;
5. write and fsync the next journal to a same-directory temporary file;
6. revalidate CAS, publish the initial journal with no-replace linking or
   replace an existing journal, and fsync the parent directory;
7. remove the pending artifact, fsync the parent again, and read back the
   journal.

The pending artifact is not another state machine. It makes a failed journal
write observable after restart. Its presence always blocks swap, retry and
publication.

After restart, the durable journal and the two on-disk manifests classify the
filesystem as `OLD_ACTIVE`, `NEW_ACTIVE` or `AMBIGUOUS`. Classification is
read-only. It never invokes swap or changes a journal. `AMBIGUOUS`, corrupt
evidence and partial evidence remain operator-approved HOLD states.

## Integrity boundary

`full-quick-check-receipt.json` records the actual full-check artifact identity,
including the sealed SQLite executable, result, DB/WAL/SHM hashes and all three
generations. `integrity-receipt.json` binds that receipt and:

- DB, WAL and SHM SHA-256 identities;
- the independent full-`quick_check` receipt SHA-256;
- Source, Serving and Cache generations;
- journal mode and the candidate transaction.

The manifest seals the canonical integrity-receipt hash. A caller-provided
64-character placeholder is not accepted as full-check evidence. Full byte verification
is required before durable `SWAP_INTENT`. After that proof, metadata and receipt
identity may be used only while the Reader/Writer barrier remains valid. A
changed candidate, changed receipt, WAL/DELETE transition or unexpected sidecar
requires a new receipt and manifest.

This contract does not claim that a receipt created by a test fixture proves
Production database health. Production must provide the corresponding sealed
full-check artifact created by its approved executable.

## Software crash result

| Failure point | Restart classification | Automatic action |
| --- | --- | --- |
| before helper invocation | `OLD_ACTIVE` | none |
| after helper returns, before `SWAPPED` persistence | `NEW_ACTIVE` with journal at `SWAP_INTENT` | none |
| helper timeout before swap | `OLD_ACTIVE` | none |
| journal fsync/directory sync failure | pending artifact, HOLD | none |
| concurrent or stale journal writer | exclusive pending lock/CAS rejection | none |
| missing/corrupt journal, manifest or receipt | fail closed | none |
| both paths do not match sealed old/new manifests | `AMBIGUOUS` | none |

`fsync` and parent-directory sync are implemented. The fixture injects a
software exception immediately before a directory sync; it does not emulate a
kernel-level fsync failure. Sudden power loss, controller write-cache behavior and
`F_FULLFSYNC` durability on the Production OWC device are not proven and remain
`UNKNOWN`.

## Production path compatibility

Read-only observation at 2026-11-01 14:22 JST found the active JP database at:

`/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`

Nineteen LaunchAgent plists explicitly contain that file path. Web and Analog
receive it through their environments and may open it on demand. Trigger PID
`88798` and a running updater PID `5673` held the DB/WAL/SHM at the observation
boundary. Friend Gateway does not open the DB directly; it proxies Web at
`127.0.0.1:3000`.

A directory bundle would expose the database as, for example,
`.../jp-serving/active/stockboard.db`. That is not path-compatible with the
current single-file path. A symlink compatibility layer is rejected because it
does not force old-inode readers to reconnect and conflicts with realpath-based
Storage Guard contracts.

Production migration therefore requires a separately approved boundary:

1. move all approved runtime manifests and plist environments to the bundle
   member path;
2. hold every direct Reader/Writer before the first path change;
3. prove zero unapproved DB/WAL/SHM handles;
4. activate the sealed bundle;
5. restart/reconnect approved Readers from immutable runtimes;
6. prove each Reader and cache reports the new Source/Serving/Cache generation;
7. only then release Web, Analog, Gateway and writers.

The point-in-time handle scan cannot prevent a new same-user ad-hoc connection.
Reader admission and immutable Trigger runtime therefore remain Production P1
blockers. Atomic swap prevents partial candidate publication, but it does not
make stale Readers converge.

An open SQLite connection can retain the old DB inode and lazily reopen old
WAL/SHM paths. The Reader/Writer barrier must therefore remain continuously
enforced from final Candidate verification through service reconnection and
generation convergence. A finite `lsof` scan is evidence at one instant, not an
admission control mechanism.

## OWC test plan

No test file was created on OWC in this PR. Read-only evidence at 2026-11-01
14:22 JST:

- APFS volume `disk7s1`, UUID `11FDA3F5-D89E-414D-9B95-C2069FF0B204`;
- total 4,000,577,273,856 bytes;
- free 980,066,021,376 bytes;
- active DB 551,171,977,216 bytes, plus live WAL/SHM;
- multiple retained 551 GB repair/failed/evidence artifacts exist on the same
  volume and must not be deleted without separate identity-bound approval.

The approved test must state and measure:

1. pre/post physical allocation, not only logical file size;
2. initial clone allocation and deterministic CoW growth;
3. old bundle, candidate and existing Backup retention at every failure point;
4. swap and swap-back latency;
5. WAL/SHM and open-handle behavior;
6. a quota-isolated ENOSPC case that cannot exhaust the live Production
   container;
7. cleanup identities and an explicit cleanup approval.

Conservative admission requires at least 1.10 TB free before a 551 GB-scale
same-volume experiment: 551.2 GB worst-case candidate CoW, 400.1 GB operational
reserve (10% of the container), and 150 GB for WAL, temporary and failure
evidence margin. Current free space is about 120 GB below that threshold.
Creating a quota APFS test volume or removing retained artifacts is itself a
Production-storage change and needs separate approval. OWC-scale and ENOSPC
evidence therefore remain `HOLD`.

## Maintenance contract

The 4h55m changed-candidate full check and the earlier 46m6s full derived
rebuild remain the applicable evidence. The 762.864-second incremental run is
not substituted for the full rebuild. OWC swap/swap-back, service reconnection,
abnormal recovery and a minimum 90-minute reserve remain unmeasured, so the
12-hour Production contract is not yet proven.
