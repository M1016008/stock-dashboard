# Phase 2 Production blocker evidence matrix

Status date: 2026-11-01. `VERIFIED` means exercised in isolation or supported by
the cited immutable evidence. `UNKNOWN` is never treated as PASS.

| Blocker | Implemented | Verified evidence | Unresolved / Production status |
| --- | --- | --- | --- |
| Historical Repair writer hold | 16-label sealed inventory and 13-loaded/3-unloaded restore contract | Executable-plan E2E and crash recovery | Live identity must be freshly observed before any Production action. |
| Historical Repair read hold | Four services held; six boundary probes; receipts journaled | PR J unit negatives plus full executable-plan E2E | Same-user ad-hoc admission race and current live handles remain `UNKNOWN`; Strategy A Production `HOLD`. |
| Reader/Source inventory | 94 `app/`/`lib/` source readers classified | Static inventory in `jp-source-reader-lineage-inventory.md` | Runtime SQL paths, live PIDs and every cache dependency are not yet all dynamically traced. |
| Normal updater process contract | Source Run, Receipt, Coverage and process-level recovery implemented | PR #41/#42 process E2E and CI | Live readers still see in-place rows without Versioned Serving. |
| Missing / conflict / publication separation | Independent Coverage and publishability contracts | Unit and normal-updater E2E | Quarantine policy is ADR-only; Production publication remains stop-all. |
| `1447` / `2164` protection | Repair and normal-ingestion conflict preservation implemented | Existing repair/updater fixtures | Corporate Action/Price Basis adjudication unresolved; both remain HOLD. |
| 4,061 Price Basis / Corporate Action | Provider envelope and adjusted-field source are sealed | Provider 4,442 / valid 4,218 / no-trade 224 / invalid 0 | Per-ticker current adjusted/CA proof for all 4,061 is `UNKNOWN`; Production blocker P1. |
| Coverage bootstrap | Ledger schema/store and design exist | Isolated ledger/store tests | Latest Production coverage recapture and bootstrap package not executed; `UNKNOWN`. |
| Source Generation / Receipt | Transactional Source Run and ingestion Receipt implemented for updater | PR #41/#42 E2E | Repair receipt is not yet the source of truth for every Reader/cache. |
| Serving / cache lineage | Target manifest and migration map documented | Static lineage matrix | History, SMA, six-stage, Screener, Trigger, Dashboard and two-year line cache are not all pinned to one immutable manifest; P1 open. |
| Post-write DB integrity | Independent verification contracts designed in PR #34 | Contract tests | 551GB-equivalent changed-DB proof is not yet measured; P0 open. |
| APFS Clone rollback capacity | Candidate contract designed in PR #35 | Small isolated fixtures only | Real APFS capacity, CoW growth, SIGKILL and partial restore at scale are `UNKNOWN`; P0 open. |
| 12-hour maintenance budget | Stage budget model exists | Budget unit tests and prior 551GB read-only timings | Full normal and failure+recovery paths at scale are not demonstrated; P0 open. |
| Derived rebuild at Production scale | Approved sequence and aggregate timeout exist | Fixture E2E | Production-size duration and output completeness are `UNKNOWN`; P0 open. |
| Runtime immutability | Exact Node/physical `tsx`, clean Git commit/tree, runtime manifest and physical `node_modules` are sealed | Configuration/package assertions and E2E | Live artifact identity must be recaptured; unrelated scripts using development commands are outside this package. |

## Current gate

- This PR: Draft technical gate eligible after independent review and CI.
- Phase 2 isolated development: `GO`.
- Strategy A Production repair: `HOLD`.
- Production-blocking P0: post-write integrity, APFS rollback capacity, 12-hour
  failure path, Production-scale derived rebuild.
- Production-blocking P1: complete Price Basis/Corporate Action proof,
  Reader/cache lineage and ad-hoc read admission.

## Next evidence order

1. Use only an approved isolated volume to measure APFS clone/CoW, changed-DB
   integrity and failure-space requirements at 551GB scale.
2. Run the actual derived commands against a Production-scale isolated copy and
   close the normal/failure/recovery time budget.
3. Generate the 4,061-row Price Basis/Corporate Action report and latest
   read-only Coverage evidence.
4. Build the Coverage bootstrap package and complete dynamic Reader/cache
   lineage before proposing a new Production package.
