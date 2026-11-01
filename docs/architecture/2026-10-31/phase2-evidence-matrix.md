# Phase 2 Production blocker evidence matrix

Status date: 2026-11-01. `VERIFIED` means exercised in isolation or supported by
the cited immutable evidence. `UNKNOWN` is never treated as PASS.

| Blocker | Implemented | Verified evidence | Unresolved / Production status |
| --- | --- | --- | --- |
| Historical Repair writer hold | 16-label sealed inventory and 13-loaded/3-unloaded restore contract | Executable-plan E2E and crash recovery | Live identity must be freshly observed before any Production action. |
| Historical Repair read hold | Four services held; six boundary probes; receipts journaled | PR J unit negatives plus full executable-plan E2E; 2026-11-01 live `lsof` observed the same-user Trigger worker holding DB/WAL/SHM | The probes detect but do not prevent a new same-user handle. ADR reader-admission keeps in-place Strategy A Production `HOLD`. |
| Reader/Source inventory | 94 `app/`/`lib/` source readers classified | Static inventory in `jp-source-reader-lineage-inventory.md` | Runtime SQL paths, live PIDs and every cache dependency are not yet all dynamically traced. |
| Normal updater process contract | Source Run, Receipt, Coverage and process-level recovery implemented | PR #41/#42 process E2E and CI | Live readers still see in-place rows without Versioned Serving. |
| Missing / conflict / publication separation | Independent Coverage and publishability contracts | Unit and normal-updater E2E | Quarantine policy is ADR-only; Production publication remains stop-all. |
| `1447` / `2164` protection | Repair and normal-ingestion conflict preservation implemented | Existing repair/updater fixtures | Corporate Action/Price Basis adjudication unresolved; both remain HOLD. |
| 4,061 Price Basis / Corporate Action | Provider envelope and adjusted-field source are sealed | Fresh capture retains the same accepted hash; all 4,061 residual rows are normalized `jquants-adjusted-ohlcv-v1`, have target-date factor 1, and are finite and internally valid. A read-only session replay found one boundary candidate, `8105` (135 -> 99). | The accepted-row capture is lossy and does not retain provider Raw/Adjusted pairs or the later factor chain; the replay is not a sealed all-ticker proof and `8105` is not adjudicated. Independent per-ticker proof remains `UNKNOWN`; Production blocker P1. |
| Coverage bootstrap | Ledger schema/store and design exist | 2026-11-01 read-only Production recapture: 157 existing, 155 exact, 4,061 missing, conflicts only `1447`/`2164`; Source Run 8718 remains latest success | Bootstrap package and Reader adoption are not executed; `HOLD`. |
| Source Generation / Receipt | Transactional Source Run and ingestion Receipt implemented for updater | PR #41/#42 E2E | Repair receipt is not yet the source of truth for every Reader/cache. |
| Serving / cache lineage | Target manifest and migration map documented | Static lineage matrix | History, SMA, six-stage, Screener, Trigger, Dashboard and two-year line cache are not all pinned to one immutable manifest; P1 open. |
| Post-write DB integrity | Independent verification contracts designed in PR #34 | Changed 550,787,080,192-byte candidate full `quick_check=ok` in 4h55m21.346s; whole-file SHA `aa5abdb824fe948fdd6bd427f5d80c418270dcaf4316c21d44f1a02054d4d179` in 15m51.420s | Isolated integrity proof is `VERIFIED`, but the check exceeds the configured 265-minute stage cap by 30m21.346s. Current execution contract remains Production `HOLD`. |
| APFS Clone rollback capacity | Candidate contract designed in PR #35; atomic sibling-directory swap primitive implemented | Separate encrypted APFS volume: sealed DB/WAL/SHM cloned in 0.810s; candidate and restored-member hashes matched; fixture `RENAME_SWAP` exchanged bundle inodes with no missing-path interval and classified SIGKILL before/after | Atomic fixture is `PARTIAL`: an old-inode Reader retained old data. Physical power loss, Production partial restore, 551GB ENOSPC, OWC capability/allocation and scale swap-back remain unproved; P0 open. |
| 12-hour maintenance budget | Stage budget model and atomic-swap recovery model exist | Substituting the isolated USB check projects about 610.36m normal and 565.36m pre-activation failure. If a future OWC-scale swap-back is proven within 5m, post-activation projects 625.36m and 94.64m margin. | The five-minute swap-back is not measured at 551GB/OWC, and USB timing is not an OWC bound. Full abnormal recovery plus writer/read restore remain unmeasured; P0 open. |
| Derived rebuild at Production scale | Approved sequence and aggregate timeout exist | 551GB-sized isolated DB, incremental 4,061-row path: 4,061 inserts, 236,431 snapshots, six transition axes, Screener, one Trigger definition and Dashboard completed in 762.864s; `1306`/`7003` rows and SMA75 were checked | This is not a full Production-equivalent rebuild; prior budget evidence records 46m6s for the current full rebuild. SIGKILL occurred before a write/open transaction was proven and left an ambiguous `batch_runs` row. Failure/recovery and workload equivalence remain P0; run classification is P1. |
| Runtime immutability | Exact Node/physical `tsx`, runtime manifest and per-file hashes are sealed by packages | Configuration/package assertions and E2E | The live Trigger worker still runs `node --import tsx` from `/Users/yoshio/dev/stock-dashboard-release-7df6c23` under the same user. Immutable Trigger runtime design/test remains P1. |

## Current gate

- **Production: `HOLD` for every Strategy A path in this matrix.**
- This PR: Draft technical gate eligible after independent review and CI.
- Phase 2 isolated development: `GO`.
- Strategy A Production repair: `HOLD`.
- Production-blocking P0: APFS atomic rollback/capacity, current verification
  timeout contract, Production-equivalent derived rebuild, and full 12-hour
  failure/recovery path.
- Production-blocking P1: complete Price Basis/Corporate Action proof,
  Reader/cache lineage, ad-hoc read admission, ambiguous `batch_runs`, and
  immutable Production runtime. The exact temporary measurement source is also
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
