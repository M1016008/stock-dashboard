# Phase 2 Production blocker evidence matrix

Status date: 2026-11-01. `VERIFIED` means exercised in isolation or supported by
the cited immutable evidence. `UNKNOWN` is never treated as PASS.

| Blocker | Status | Implemented | Verified evidence | Unresolved / Production status |
| --- | --- | --- | --- | --- |
| Historical Repair writer hold | `PARTIAL` | 16 writer-label sealed inventory and 13-loaded-writer/3-unloaded-writer restore contract | Executable-plan E2E and crash recovery | Live identity must be freshly observed before any Production action. Bundle path migration also needs a separately sealed old-to-new definition identity mapping; the existing hold-time hashes cannot restore rewritten plists. |
| Historical Repair read hold | `HOLD` | Four services held; six boundary probes; receipts journaled | PR J unit negatives plus full executable-plan E2E; 2026-11-01 live `lsof` observed the same-user Trigger worker holding DB/WAL/SHM. Static runtime audit also confirms Web cache writes and WAL initialization plus Trigger job/lock writes. | The probes detect but do not prevent a new same-user handle. The old site cannot be treated as a byte-immutable Reader during the proposed three-hour interval; Production remains `HOLD`. |
| Durable Recovery approval | `PARTIAL` | Typed hash contract binds Transaction, journal canonical/file hashes, manifests, integrity/barrier receipt hashes, exact no-swap operation and <=15-minute validity | Unrelated, altered, extra-key, invalid-time, overlong and expired objects rejected; a matching object records `SWAPPED` without invoking swap | The adapter proves integrity/scope, not who authorized it. Production Package authority and independently derived barrier receipt remain P1. |
| Durable pending artifacts | `PARTIAL` | Read-only classifier distinguishes clean, unpublished, published-pending-cleanup and ambiguous evidence | SIGKILL/fsync fixtures classify both recoverable shapes without mutation; dangling symlink, insecure pending file, malformed temporary and internally inconsistent classification receipt fail closed; journal is reread after scan | Evidence can still change after the point-in-time scan, and a self-hashed receipt is not external authority. Identity-bound archive/clear executor is not implemented; manual deletion remains prohibited and Production P1 stays open. |
| Durable journal concurrency | `PARTIAL` | Existing pending lock and CAS reused | Coordinated contention by two independent Node writers permits only the pending-lock holder to advance; independent second-CAS displacement is rejected | Fixture behavior is verified; physical power/OWC behavior remains `UNKNOWN`. |
| Reader/Source inventory | `PARTIAL` | 94 `app/`/`lib/` source readers classified | Static inventory in `jp-source-reader-lineage-inventory.md` | Runtime SQL paths, live PIDs and every cache dependency are not yet all dynamically traced. |
| Normal updater process contract | `PARTIAL` | Source Run, Receipt, Coverage and process-level recovery implemented | PR #41/#42 process E2E and CI | Live readers still see in-place rows without Versioned Serving. |
| Missing / conflict / publication separation | `PARTIAL` | Independent Coverage and publishability contracts | Unit and normal-updater E2E verify the domain split | Quarantine policy is ADR-only and Production publication remains stop-all, so the Production publication path is not verified. |
| `1447` / `2164` protection | `PARTIAL` | Repair and normal-ingestion conflict preservation implemented | Existing repair/updater fixtures | Corporate Action/Price Basis adjudication unresolved; both remain HOLD. |
| 4,061 Price Basis / Corporate Action | `PARTIAL` | Provider envelope and adjusted-field source are sealed | `jp-2026-07-17-price-basis-evidence.json` records the 2026-11-01 live replay: 4,061/4,061 finite Raw/Adjusted pairs, all Raw=Adjusted, all target-date factors=1, pair SHA `6fb2f93b2fe07d90669c2a7ff929e73115a6fc04fc5e21025f0583cbf581d34e`; adjusted content hash remains `cfbf6d48f9b0f2438484f04154a800a55bd41d03a2d5622f9be44e4c7ac2bb20`. `8105` primary rows show 135 close on 07-16 and 99 on 07-17 with Raw=Adjusted/factor=1, and no provider non-unit factor through 10-30. | Provider data supplies no Corporate Action adjustment for the `8105` boundary; that does not independently prove the economic cause. Raw provider rows and a committed all-ticker later-factor-chain replay are absent, so Production blocker P1 remains. |
| Coverage bootstrap | `HOLD` | Ledger schema/store and design exist | Fresh read-only query at 2026-11-01 15:42 JST: 157 existing, 155 exact, 4,061 missing, conflicts only `1447`/`2164`; row SHA remains `f99b15aedd35e37efe68b41621f27f1c762cae5bd9e5521746b5e1cdd379a507` | Bootstrap package and Reader adoption are not executed. |
| Source Generation / Receipt | `PARTIAL` | Transactional Source Run and ingestion Receipt implemented for updater | PR #41/#42 E2E | Repair receipt is not yet the source of truth for every Reader/cache. |
| Serving / cache lineage | `HOLD` | Target manifest and migration map documented | Static lineage matrix | History, SMA, six-stage, Screener, Trigger, Dashboard and two-year line cache are not all pinned to one immutable manifest; P1 open. |
| Post-write DB integrity | `HOLD` | Independent verification contracts designed in PR #34 | Changed 550,787,080,192-byte candidate full `quick_check=ok` in 4h55m21.346s; whole-file SHA `aa5abdb824fe948fdd6bd427f5d80c418270dcaf4316c21d44f1a02054d4d179` in 15m51.420s | Isolated integrity proof is verified, but the check exceeds the configured 265-minute stage cap by 30m21.346s. Current execution contract remains blocked. |
| APFS Clone rollback capacity | `HOLD` | Candidate contract designed in PR #35; atomic sibling-directory swap, durable Journal and pre-consumer reverse implemented | Separate encrypted APFS fixture proved inode exchange. PR #50 proves `REVERSE_INTENT`/`PRE_CONSUMER_REVERSED`, SIGKILL classification, old-byte and no-WAL/SHM checks, and rejects reverse after Generation reconciliation or `COMMITTED`. | Reverse is intentionally limited to the pre-consumer boundary. Physical power loss, Production path migration, 551GB ENOSPC, OWC allocation and scale rollback remain unproved; P0 open. |
| 12-hour maintenance budget | `HOLD` | Stage budget model and atomic-swap recovery model exist | Substituting the isolated USB check projects about 610.36m normal and 565.36m pre-activation failure for the previously modeled proof set. A separately full-verified old Bundle adds another Production-scale integrity proof that is not included in those totals. | The current Bundle sequence therefore has no proven 12-hour bound. Swap-back is unimplemented, USB timing is not an OWC bound, and full abnormal recovery plus writer/read restore remain unmeasured; P0 open. |
| Derived rebuild at Production scale | `HOLD` | Approved sequence and aggregate timeout exist | 551GB-sized isolated DB, incremental 4,061-row path: 4,061 inserts, 236,431 snapshots, six transition axes, Screener, one Trigger definition and Dashboard completed in 762.864s; `1306`/`7003` rows and SMA75 were checked | This is not a full Production-equivalent rebuild; prior budget evidence records 46m6s for the current full rebuild. SIGKILL occurred before a write/open transaction was proven and left an ambiguous `batch_runs` row. Failure/recovery and workload equivalence remain P0; run classification is P1. |
| Runtime immutability | `HOLD` | Exact Node/physical `tsx`, runtime manifest and per-file hashes are sealed by historical packages; immutable Trigger target and two-step Consumer Admission contract are documented | Synthetic fixture creates a metadata-level pre-start Permit, then checks Web/Analog/Gateway/Trigger execution identities, DB inode and generations after a simulated WAL sidecar appears; Trigger is cross-bound to its active writer PID and the 13-loaded/3-unloaded launchd state permits idle periodic jobs. | This is contract evidence, not live process evidence. Production health payloads and independent handle observations do not expose all bound identities; post-start observations are not independently re-derived; the Permit is not Package-sealed; Immutable Trigger and old-to-new plist migration are absent; actual Reader/Cache convergence remains unproved. P1 remains. |
| OWC capacity / retention | `HOLD` | Read-only artifact inventory and a bounded retention-release candidate are documented | APFS UUID and four retained 551,171,977,216-byte files identified; free `979,982,606,336` bytes and no OWC APFS snapshots at the 2026-11-01 observation boundary. Prewrite Transaction `1793348893462-59084` records no Production data mutation; encrypted `StockBoard Backup` has `894,185,275,392` free bytes, about `343,013,298,176` after one logical 551GB copy. | 1.10 TB admission is short by `120,017,393,664` bytes. Transfer/deletion are unapproved; snapshot state must be rechecked and APFS unique reclaimed allocation is unknown until an approved unlink is followed by remeasurement. P0 remains blocked. |

## Current gate

- **Production: `HOLD` for every Strategy A path in this matrix.**
- This PR: Draft technical gate eligible after independent review and CI.
- Phase 2 isolated development: `GO`.
- Strategy A Production repair: `HOLD`.
- Production-blocking P0: APFS atomic rollback/capacity, current verification
  timeout contract, Production-equivalent derived rebuild, and full 12-hour
  failure/recovery path.
- Production-blocking P1: complete Price Basis/Corporate Action proof,
  Reader/cache lineage, ad-hoc read admission, pending-artifact recovery,
  ambiguous `batch_runs`, and immutable Production runtime. The exact temporary measurement source is also
  unavailable; recovered transformed-code caches are auditable but not
  source-replayable.

## Next evidence order

1. Extend the fixture-verified atomic bundle boundary to 551GB/OWC evidence,
   then exercise physical-loss recovery, stale-reader admission, partial
   restore and ENOSPC at representative scale.
2. Reconcile the 4h55m isolated full-check measurement with the verification
   stage contract without weakening changed-DB integrity.
3. Prove abnormal derived recovery and writer/read-service restoration within
   the 12-hour contract; classify ambiguous `batch_runs` fail-closed.
4. Complete the 4,061-row Price Basis/Corporate Action proof, Coverage bootstrap
   and dynamic Reader/cache lineage before proposing a Production package.
