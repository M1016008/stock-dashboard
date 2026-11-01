# Phase 2 PR K: Production-scale safety evidence

Status date: 2026-11-01. This document records isolated evidence only. It does
not authorize a Production repair, service operation, Generation change or
main merge.

## Environment and scope

| Item | Observed identity |
| --- | --- |
| Production volume | `/Volumes/OWC Express 1M2 80G`, APFS `disk7s1`, UUID `11FDA3F5-D89E-414D-9B95-C2069FF0B204`, separate NVMe physical store |
| Production DB | `stockboard.db`, 551,171,977,216 bytes; observed read-only only |
| Isolated evidence volume | `/Volumes/StockBoard Backup`, encrypted APFS `disk5s1`, UUID `9FE99B78-6AF2-4493-AEF5-A1E5BDCDE683`, separate USB physical store |
| Immutable source bundle | 550,778,204,160-byte DB + 1,278,048,752-byte WAL + 2,490,368-byte SHM; target hash `678bc76b1012fe8ac89bb838facdbf9d78b55d535696823ee418fcedff1c27b0` |
| Code baseline | PR #43 head `47c8ff663fd17259a6fc0f25f030178d536dfd3c` |
| Evidence run | `phase2-p0-scale-20261101-v2`; `evidence.json` SHA-256 `f9d7c00838c83a7e6d875eed031c30948e89807eef7313a675094608c62dd8c7` |
| Prepare receipt | `prepare-result.json` SHA-256 `9a02f88d12c4be4ca5fe92657d42747e2abfb39584013be7176e01f135b36d5f` |
| Supplemental read-only receipt | `supplemental-evidence.json` SHA-256 `b0c6500054ec976ff70c57924c9a45f2820479ab8c405ab9f1e94cdace4224fc` |
| Recovered transformed-code manifest | `measurement-cache-manifest.json` SHA-256 `d20daabefeb71bb6eed6403b5bc68a2889b68f77b698d1b18988df701d2299c8` |

The source bundle is a 2026-10-21 checkpoint. Current Production coverage was
recaptured separately using read-only evidence and modeled on the candidate:
157 existing rows, 155 exact official matches, 4,061 missing rows and the two
preserved conflicts `1447`/`2164`. No file was created on the Production OWC
volume.

The provider capture was recorded at `2026-11-01 04:02:23 JST`; its accepted
content SHA-256 is
`cfbf6d48f9b0f2438484f04154a800a55bd41d03a2d5622f9be44e4c7ac2bb20`.
The Production coverage capture was recorded at `2026-11-01 04:39:07 JST`;
its sorted-row SHA-256 is
`f99b15aedd35e37efe68b41621f27f1c762cae5bd9e5521746b5e1cdd379a507`.
The official, Production-row and coverage-summary file hashes are respectively
`8c2b2fe28ccfb32944f9383931591d988856508b6fdafedc18eadf62b830d194`,
`9927b0fcf08185185f275a6e2db09ee9a77a2440ed1766c9d53aa80403dbf2bb`
and `693fb807c27ec32b66036f51e59c0d730db5c6ca33066a756115251132677e6d`.
The captures remain local audit evidence and are deliberately not added to
Git.

The scale run invokes the real ingestion boundary and the real Snapshot,
six-stage, Screener, Trigger and Dashboard commands. Its 27-row baseline setup,
Source Generation and orchestration are measurement-specific; it is not a
substitute for the sealed Production package, service hold or publication path.

## Reproducibility and invariants

The temporary measurement harness sealed the Node binary, baseline Git
commit/index tree, every invoked script, official-provider capture and
read-only Production row capture. The untracked measurement scripts were
covered by explicit per-file hashes rather than the index tree. It rejected a
changed runtime or evidence file on resume.

The exact temporary TypeScript harness sources were not retained. The original
source hashes remain in `evidence.json`, and the original host's transformed
`tsx` cache records were recovered and sealed in the cache manifest above, but
they are not source-equivalent archives. Past execution is auditable at the
transformed-code level and is not source-replayable. This is a P1 evidence
limitation; the harness is not promoted into permanent application code.

Verified invariants:

- source DB/WAL/SHM were opened read-only and retained their original metadata;
- clone member hashes matched the immutable source bundle; later source checks
  reused those hashes only while file metadata remained unchanged;
- current 157-row Production evidence was an exact superset of the checkpoint's
  130 target-date rows before the 27 additional exact rows were modeled;
- ingestion inserted only the 4,061 missing approved rows;
- ingestion classified 155 exact rows as already satisfied and immediately
  re-read the two conflict values unchanged; a final all-row comparison after
  every derived stage was not performed;
- missing coverage became complete while publication remained `PARTIAL_HOLD`;
- no Production DB, WAL, service, Source/Serving pointer or cache was changed.

## Incremental rebuild on a Production-size database

| Stage | Actual isolated duration | Result |
| --- | ---: | --- |
| Missing-only ingestion | 2.712 s | 4,061 inserted, 155 already satisfied, 0 missing, 2 conflicts preserved |
| Snapshot crash injection | 0.590 s | `SIGKILL` after the 4,061-ticker Snapshot process announced start; a DB write or open transaction was not proven |
| Snapshot rebuild | 89.002 s | 4,061/4,061 tickers, 236,431 snapshots, 0 failures |
| Six-stage transitions | 279.459 s | six axes, 216 cells |
| Integrated Screener | 330.823 s | 4,637 rows, 3,743,744 logical DB bytes added |
| Trigger reevaluation | 22.884 s | completed, notifications suppressed, repair Source Generation recorded |
| Dashboard cache | 37.394 s | trade and earnings cache updated |
| Total listed repair/derived work | 762.864 s | Measured normal-path completion with the limitations below |

Semantic checks found 4,218 target-date rows, Snapshot output for `1306` and
`7003`, six transition axes, 45 Screener dates and 98 Dashboard rows. Trigger
evidence was tied to `jp-source-scale-evidence-20261101`.

The Snapshot ticker filter covered the 4,061 repaired rows. It intentionally did
not recompute the two preserved conflicts, so downstream aggregate success is
not evidence that `1447`/`2164` were adjudicated or refreshed.

The crash test proves process interruption followed by a successful full rerun;
it does not prove transaction-level recovery or a hot rollback-journal path. It
also exposed an operational P1 rather than hiding it:
`batch_runs` retained the injected `snapshot_compute` run as `running`. The
source checkpoint already contained an older `update_latest` run in the same
ambiguous state. A successful derived rerun does not make either row success;
the normal process-level recovery contract must classify or close these rows.

## SQLite and APFS evidence

| Evidence | Result | Guarantee / limitation |
| --- | --- | --- |
| Initial APFS clone | DB 0.796 s, WAL 0.009 s, SHM 0.005 s (0.810 s total) | Member hashes matched. Filesystem free-space delta was within 12 KiB observation noise. |
| Candidate normalization | 0.213 s, observed delta 69,632 bytes | Source metadata remained unchanged and sealed hashes were reused; checkpoint had no WAL frames to apply; `journal_mode=delete`. |
| Ingestion and derived CoW | observed filesystem delta 423,600,128 bytes | Filesystem-wide free-space observation on a non-exclusive volume, not per-file physical allocation; representative of this isolated run only. |
| Candidate full `quick_check` | `ok` in 17,721.346 s (4h55m21.346s) | Full check ran against the changed 550,787,080,192-byte candidate. It exceeds the configured 265-minute stage cap by 30m21.346s. |
| Candidate whole-file SHA-256 | 951.420 s; `aa5abdb824fe948fdd6bd427f5d80c418270dcaf4316c21d44f1a02054d4d179` | Establishes the measured post-write byte identity. Activation re-hashed the same bytes in 948.351 s and matched. |
| Activation / rollback sequence | Candidate clone 1.847 s; restored DB/WAL/SHM hashes matched the sealed source | The tested two-step rollback rename has a crash gap with no active bundle. It is not an atomic replacement proof. |
| Protected-row recheck | 157 rows; `f99b15aedd35e37efe68b41621f27f1c762cae5bd9e5521746b5e1cdd379a507` | Includes the preserved `1447`/`2164` conflicts and matches the read-only Production capture. |
| Capacity after activation/restore | 894,185,541,632 bytes free; 300 GB reserve present | The 551GB ENOSPC path was not exercised. Filesystem-wide delta was negative 15,417,344 bytes and is measurement noise, not reclaimed-capacity proof. |

APFS allocation measurements are filesystem-wide observations and were made on
the separate encrypted USB APFS volume. They prove the tested filesystem's
behavior at 551GB scale, not OWC-specific clone allocation or performance.
Because writing a test clone on the Production volume was not authorized, that
OWC-specific condition remains `UNKNOWN`.

The existing small fixture rejects insufficient capacity and changed source
identity, and proves clone-only operation without a copy fallback. The scale run
does not manufacture an out-of-space condition on the 2 TB evidence disk, so it
does not promote that fixture negative into a 551 GB ENOSPC or partial-restore
proof.

The changed candidate is sealed in `journal_mode=DELETE`, while the immutable
source/restore bundle contains DB/WAL/SHM. Returning a published candidate to
WAL mode would write bytes after the measured hash unless that transition is an
explicitly verified publication stage. A stale 32,768-byte candidate SHM was
observed after normalization but is excluded from the DB-only candidate bundle.

The incomplete-bundle case was observed with WAL/SHM absent, but the Production
partial-restore validator was not executed. The restore measurement recovered
the source DB, WAL and SHM with hashes
`34882e6d43ea5627ba721761161fad34ba0e34026cb04a006629fc5b7c7d283c`,
`f1163773e4aa542b0c4f0f3cfb1ea29531e7bfa8ebe8778950582323746c6680`
and `d6af985934e3532dc12c1e0d6051a96eedc6ed36b65d3005fb634c636d908649`.
That proves byte restoration on the isolated APFS volume, not a safe atomic
Production activation.

The evidence directory deliberately retains `activation/restore.partial` and
`activation/failed.bundle` as failed-path artifacts. The receipt identifies the
missing members but does not assign either directory a valid restore status.
Their presence is evidence of the tested crash gap, not a recoverable package.

At the final read-only observation, the Production APFS container reported
980,065,521,664 bytes free. This is a point-in-time capacity observation only;
no clone, allocation or write was attempted on OWC, so it does not prove
Production CoW growth or failure-space sufficiency.

## Twelve-hour contract

Existing Production read-only measurements remain the applicable OWC timing
baseline: backup copy 14m44s, full `quick_check` 3h30m24.68s and SHA-256
14m7.79s. The isolated derived work above is 12m42.864s. The changed-candidate
full `quick_check` took 4h55m21.346s on the isolated USB APFS volume. That is
30m21.346s beyond the configured 265-minute verification limit, so the current
stage contract deterministically fails in the measured environment.

Substituting the measured check for the configured 265-minute allowance gives
arithmetic projections of about 610.36 minutes normal, 565.36 minutes for the
pre-activation failure path and 650.36 minutes for the post-activation failure
path. The last path leaves about 69.64 minutes and therefore violates the
existing 90-minute minimum recovery margin. All three are arithmetic only:
writer/read-service
recovery, the two-step activation crash gap, 551GB ENOSPC and Production OWC
write performance were not exercised end to end. No timeout is raised merely
to make the budget pass.

The 4h55m result is specific to the isolated encrypted USB APFS volume. There
is no unchanged-source USB control, so it is neither an upper nor a lower bound
for OWC. It does, however, prove that the current 265-minute configured stage
cannot safely claim portability across the approved isolated test environment.

The source checkpoint predates the current Production Source Run, so these
measurements prove scale and code-path behavior, not current Production lineage.
Writer/read-service restore timing is covered only by existing fixtures and
prior incident evidence, not by this isolated scale run.

## Target-symbol semantic check

The changed candidate contains the captured official adjusted rows for `1306`
(`415.9/416.8/401.9/407.9`, volume `31,540,630`) and `7003`
(`4567/4571/4326/4434`, volume `2,073,200`) on 2026-07-17. Running the real SMA
Lab calculation on the isolated candidate at its 2026-10-15 boundary produced
an `ok` SMA75 with no invalid bars in the 75-session window for both tickers:
`425.5213333333335` for `1306` and `4341.72` for `7003`. These are isolated
checkpoint results and are not presented as current Production values. The
inputs and outputs are sealed in the supplemental receipt identified above.

## Reader admission and lineage

The 2026-11-01 live observation found the Production Trigger worker, running as
the same macOS user as the repair, holding DB/WAL/SHM. PR #43's six probes can
detect a handle at their boundaries but cannot prevent a new same-user handle
between them. Extra `lsof` samples or owner-mode changes do not close that race.

The immediate candidate-and-atomic-activation evolution prevents partial
candidate writes from becoming visible, but stale old-inode readers and cache
publication still require a binding contract. Versioned Serving remains the
target architecture. Source `success` alone is not Serving/cache proof.

The current direct-read Trigger worker was observed as PID `88798`, loading
`node --import tsx` from the mutable development release path
`/Users/yoshio/dev/stock-dashboard-release-7df6c23` and holding DB/WAL/SHM.
This is evidence of both the admission race and an unsealed Production runtime;
the PID itself is an observation, not a durable identity. The point-in-time
command and open-handle paths are sealed in the supplemental receipt.

## Coverage and Price Basis

The fresh provider envelope remained 4,442 rows: 4,218 accepted, 224 all-null
no-trade and zero invalid. The 4,061 residual rows all identify
`jquants-adjusted-ohlcv-v1`, have a 2026-07-17 adjustment factor of 1 and finite,
internally consistent OHLCV values. The accepted-row capture is intentionally
lossy: it retains only normalized OHLCV and adjustment factor, not the raw and
adjusted provider field pairs or a later factor chain.

A read-only replay of the normal updater's Corporate Action boundary heuristic
found a previous Production close for all 4,061 rows. It flagged one unresolved
candidate: `8105`, from 135 on 2026-07-16 to the official adjusted close 99 on
2026-07-17. The target-date factor is 1. This replay was a read-only session
check, not a sealed per-ticker Corporate Action proof.

This evidence does not contain the provider's Raw-versus-Adjusted field pairs or
the complete later corporate-action factor chain for every ticker. Therefore it
does not independently prove current adjusted Price Basis and corporate-action
lineage for all 4,061 rows, nor adjudicate whether `8105` is a Corporate Action
or a genuine price move. That remains a Production-blocking P1. The two
conflicts remain quarantined by policy and are not overwritten or adjudicated.

## Gate

- PR K documentation and isolated evidence: eligible for Draft technical review
  after independent Claude Code review and CI.
- Phase 2 isolated development: `GO`.
- In-place Strategy A Production repair: `HOLD`.
- Post-write full-DB integrity: isolated `PASS`; the USB test exceeded the
  configured stage while OWC duration remains unbounded by this measurement.
- APFS rollback: byte restoration measured, but atomic activation, Production
  filesystem behavior, partial-restore rejection and scale ENOSPC remain P0.
- Derived rebuild: incremental normal path measured; full failure/recovery and
  Production-equivalent workload remain P0.
- Evidence reproducibility: transformed-code cache retained, exact temporary
  TypeScript harness source unavailable; P1.
- Candidate activation evolution: evidence-bearing design only, not Production
  approval.
- Production package generation: prohibited while P0/P1 or required UNKNOWNs
  remain.
