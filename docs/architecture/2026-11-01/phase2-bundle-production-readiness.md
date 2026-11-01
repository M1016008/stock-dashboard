# Phase 2 bundle Production readiness

Status: read-only design evidence. Production, OWC, DB/WAL, LaunchAgents,
Generation and `main` were not changed. The dedicated-directory Bundle remains
the selected repair strategy. This document adds no Recovery framework.

Observation time: 2026-11-01 17:31 JST.

## Production usability baseline

| Surface | Observation | Classification |
| --- | --- | --- |
| Web `127.0.0.1:3000` | `/api/health` HTTP 200, `overall=healthy` | usable |
| Analog `127.0.0.1:3105` | `/api/health` HTTP 200, `overall=healthy` | usable |
| Friend Gateway `127.0.0.1:3136` | immutable runtime PID `87979`; `/api/health` HTTP 200 | usable; external OTP completion not reverified |
| Dashboard, JP/US detail, six-stage, Screener, AI Lens | HTTP 200 in the local Production path | available; data quality limitations remain |
| `7003` detail and SMA Dynamics | browser readback showed the 2026-10-30 quote, six-stage data and the Lab UI; the Lab uses the common History API | available; JP coverage is limited by 4,061 missing rows and two conflicts |
| JP History `7003`, US History `SPY` | HTTP 200 | available with source limitations |
| JP freshness | expected/price/derived date `2026-10-30`, `fresh=true` | date-fresh, not coverage-complete |
| US freshness | expected `2026-10-30`, price `2026-10-29`, 99.35% coverage, ingestion `partial` | data-limited; must not be reported as normal |

The site baseline remains available. This audit performed no intentional
Production mutation. Friend OTP end-to-end remains `UNVERIFIED`.

## OWC capacity and retention

### Live storage identity

| Item | Read-only observation |
| --- | --- |
| Volume | `/Volumes/OWC Express 1M2 80G` |
| APFS UUID | `11FDA3F5-D89E-414D-9B95-C2069FF0B204` |
| Total | `4,000,577,273,856` bytes |
| Free | `979,982,606,336` bytes |
| Conservative admission | `1,100,000,000,000` free bytes |
| Shortfall | `120,017,393,664` bytes |

Four 551,171,977,216-byte files remain on OWC:

| Artifact | Inode | Retention decision |
| --- | ---: | --- |
| active `stockboard.db` | 1961766 | retain; Production source |
| `stockboard.db.failed-1793380144053-98117` | 5648 | retain; failed-state forensic evidence |
| Backup `1793380144053-98117.sqlite` | 1956847 | retain; the incident Retention record requires it to remain immutable, recorded SHA `ae7c6c1785c63834818036d9b24b8cd35443c30966ca21437f5a9cc4d8744eb2` |
| Backup `1793348893462-59084.sqlite` | 1934886 | eligible for a separate retention-release review, but not authorized for deletion |

No process held either Backup or the failed DB during this audit. APFS block
counts are not unique-extent accounting and do not prove how many bytes a
deletion would reclaim. `diskutil apfs listSnapshots` reported no OWC snapshots
at this observation boundary, but the check must be repeated immediately before
any approved release operation.

Transaction `1793348893462-59084` is the only bounded release candidate:

- it ended before a Production insert, Generation change, derived rebuild or
  restore;
- its archived evidence records `productionDataMutation=false`;
- its Source/Serving generations predate the current restored baseline;
- as of the observation boundary, no live Package, Journal or process refers to
  it as an available rollback;
- its Journal explicitly prohibits deletion without a new approval.

The separate encrypted APFS volume `/Volumes/StockBoard Backup` has UUID
`9FE99B78-6AF2-4493-AEF5-A1E5BDCDE683` and `894,185,275,392` free bytes. It can
hold one 551 GB evidence copy, but that does not itself authorize a transfer.
The copy would leave approximately `343,013,298,176` bytes free and would
constrain future 551 GB isolated scale runs on that volume.

### Recommended retention release

Use a separate, hash-bound retention operation rather than deleting an OWC
file as part of the repair:

1. bind the exact source inode, size, current SHA, archived prewrite Journal and
   destination volume UUID in a retention approval;
2. copy only `1793348893462-59084.sqlite` to an immutable incident-evidence
   directory on `StockBoard Backup`;
3. fsync and independently hash the destination, then compare source and
   destination bytes; preserve the archived Journal and measurement receipt;
4. obtain a second exact deletion approval for the OWC source;
5. repeat the APFS snapshot inventory, unlink only that exact source rather than
   moving it to Trash, re-read OWC free space, and keep the Bundle test `HOLD`
   unless the measured free space is at least 1.10 TB.

Shared APFS extents can leave the reclaimed amount near zero, so the result is
`UNKNOWN` until OWC is remeasured. The `179338...` Backup and failed DB are not
cleanup candidates in this plan.

## Direct DB consumer refresh

All 19 plists still contain
`/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`. Sixteen are loaded
and three are unloaded. Only Web, Analog and Trigger had live DB/WAL/SHM handles
at the observation boundary.

| Label suffix | Loaded | Role / reconnect rule |
| --- | --- | --- |
| `analog-search` | yes, PID 54063 | Reader; restart, prove active inode and Serving/Cache generations |
| `classification-sync` | yes | Writer; hold and restore saved state |
| `data-freshness-guard` | yes | Monitor/Reader behavior; policy classifies it as a writer label |
| `db-maintenance` | yes | Writer; hold and restore saved state |
| `earnings-refresh` | yes | Writer; hold and preserve deferred state |
| `kabutan-material-news` | yes | Writer; hold and verify no descendant handle |
| `kabutan-themes` | yes | Writer; hold and verify no descendant handle |
| `large-holder-update` | no | Writer; preserve unloaded state |
| `ml-freshness-guard` | yes | Monitor/Reader behavior; policy classifies it as a writer label |
| `ml-learning` | yes | Writer; hold and preserve scheduler state |
| `ml-weekly-governance` | no, disabled | Research writer; preserve unloaded/disabled state |
| `trigger-historical-scan` | yes, PID 88798 | Reader/Writer; mutable `node --import tsx` runtime remains P1 |
| `trigger-ml-frozen-monitor` | yes | Monitor/Reader behavior; policy classifies it as a writer label |
| `update-latest` | yes | Primary writer; hold and restore saved state |
| `us-ml-weekly` | no, disabled | Research writer; preserve unloaded/disabled state |
| `us-update-latest` | yes | Writer; hold because it receives the common JP path |
| `web-health` | yes | HTTP monitor; resume only after Web readiness |
| `web` | yes, PID 54082 | Reader; restart, prove active inode and Serving/Cache generations |
| `weekly-optimization` | yes | Writer/research definition; preserve loaded/not-running, never kickstart |

Friend Gateway is not a twentieth DB consumer. It is nevertheless one of the
four held Reader labels; it proxies Web and must remain held until Web reports
the activated generation.

## Minimal Bundle migration contract

The migration reuses these existing components, with only the narrow extensions
called out below:

- `apfs-atomic-sqlite-bundle.ts` for manifests and `RENAME_SWAP`;
- `durable-atomic-bundle-activation.ts` for the one durable activation Journal;
- `sqlite-integrity-contract.ts` for full Candidate integrity evidence;
- `launchd-writer-hold-driver.ts` and the existing read-hold contract;
- existing Storage Guard, Repair Receipt and Generation checks.

No second Journal, service manager or Recovery state machine is permitted.

### Fixed topology

The approved migration Package must select sibling, real directories on OWC,
for example:

```text
.../jp-serving/active/stockboard.db
.../jp-serving/candidate-<transaction>/stockboard.db
.../jp-serving-state/activation-journal.json
```

The exact paths are Package inputs, not implicit defaults. Symlinks and the old
single-file path are rejected by the sealed plist set and zero-handle checks
after migration. The legacy file remains a retained forensic copy, not a proven
rollback path; its mere presence is not a valid connection target.

The existing atomic-swap primitive requires the Candidate to use
`journal_mode=DELETE` with no WAL/SHM. This design additionally proposes a
DELETE-mode old Bundle so a future rollback design can start from symmetric,
sealed artifacts; that is a design constraint, not a capability of the current
primitive. The held legacy WAL source is not modified in place: a
SQLite-consistent old-generation Bundle is materialized, normalized to DELETE
mode, fully verified and given its own manifest and Integrity Receipt. The
repair Candidate is cloned from that verified Bundle and receives an
independent Receipt after repair and rebuild.

The current runtimes normally use WAL. Opening the activated DELETE-mode
Candidate may transition it back to WAL and changes concurrency behavior. That
transition, its Reader/Writer blocking characteristics and the resulting
manifest invalidation are unverified Production conditions, not implied by a
successful directory swap.

### One-time migration and repair order

1. Seal separate old and proposed-new plist bytes and hashes, executable/runtime
   identities, the 16-loaded-plist and 3-unloaded-plist states, Bundle paths,
   manifests, Receipt hashes and Generations. Seal Gateway's unchanged plist
   and runtime identity separately; it is a Reader label but not one of the 19
   direct-path plist rewrites.
2. Hold the 13 loaded writer labels and all four Reader labels (Web, Analog,
   Gateway and Web Health); preserve all three unloaded writers. Do not
   kickstart scheduled jobs.
3. Prove zero DB/WAL/SHM handles for both the legacy and Bundle paths. A new
   unapproved handle is a fail-closed condition.
4. Under the same barrier, create and seal the DELETE-mode old-generation
   `active` Bundle, then create the repair Candidate as an APFS clone. Preserve
   the old Bundle's full integrity evidence and charge its verification time to
   the 12-hour budget. With the currently measured full-check duration, a second
   independent old-Bundle full verification in addition to Candidate validation
   makes the present sequence exceed the 12-hour limit.
   Receipt reuse or an out-of-window proof is not yet approved, so this remains
   a P0/HOLD rather than an executable sequence.
5. Install the separately sealed new definitions for all 19 direct-path plists
   with `STOCKBOARD_DB_PATH` changed to
   `.../jp-serving/active/stockboard.db`; keep every job unloaded. The three
   previously unloaded definitions are rewritten but never bootstrapped. The
   current hold driver cannot restore these with the old definition hashes, so
   the old-to-new identity adapter remains an unimplemented Production P1.
6. Apply the approved 4,061-key insert-only repair to the Candidate, preserve
   `1447`/`2164`, rebuild all approved derived data and caches, and seal the
   full integrity and Generation Receipts.
7. Revalidate the continuous barrier and Candidate byte identity, perform one
   journaled and fsynced directory swap, then, while handles remain zero, record
   `GENERATION_RECONCILED` and `COMMITTED`. These Journal phases prove Bundle
   and Generation pointer state only; they do not prove Reader or Cache
   convergence. Software crash behavior is covered by the existing fixtures;
   physical power-loss durability on OWC remains `UNKNOWN`. Ambiguity or failure
   is HOLD; no automatic retry.
8. Start Web and Analog from their new sealed definitions. Require their PIDs
   to hold the new active inode and their API/Cache responses to report the exact
   Source/Serving/Cache generations. Resume Web Health only after Web readiness,
   and start Gateway only after Web convergence. Bind this evidence to a
   separate Reader-convergence Receipt outside the activation Journal.
9. Restore the 13 originally loaded writer labels using the new sealed identity
   set and saved reverse order without kickstarting weekly/research work.
   Preserve the three unloaded writers.
10. Run Freshness and Storage Guard checks. Preserve the COMMITTED Journal and
    only declare the operation complete after every Reader, Cache and writer
    state matches the Package and the convergence Receipt.

The existing primitive has no swap-back path. A swap-back before any Reader or
writer opens the newly active Bundle is only a design intent that would require
an approved Journal transition and isolated proof. Once consumers start, the
active bytes and journal mode can change. Pre-Reader and post-reconnect
swap-back therefore both remain Production P0/HOLD; no automatic swap-back is
claimed by this design.

### Remaining admission limit

The current same-user model cannot prevent an ad-hoc process from opening the
Bundle between finite `lsof` probes. The migration above controls all known
launchd consumers and removes the legacy path from their sealed definitions,
but it is not an OS-enforced admission boundary. Production remains `HOLD`
until the approved maintenance operation either supplies that boundary or
explicitly accepts a fully attended, no-other-session maintenance condition.
This document does not weaken the prior fail-closed rule.

## Evidence Matrix delta

| Production blocker | Before | Current result | Status |
| --- | --- | --- | --- |
| OWC capacity / Retention | no approved release candidate | exact prewrite-only candidate and encrypted destination identified | `HOLD`; no bytes reclaimed and no operation authorized |
| 19-agent Bundle migration | direct path inventory only | exact live state and minimal reconnect order fixed | `HOLD`; identity migration and post-reconnect rollback are unimplemented |
| Source/Serving/Cache convergence | static map | unchanged | `HOLD` |
| Full derived rebuild and 12-hour abnormal path | limited scale evidence | old-Bundle plus Candidate integrity proofs expose a second full-verification budget conflict | `HOLD` |
| 4,061 Price Basis / Corporate Action | target-day adjusted pairs verified | unchanged; later factor chain and `8105` cause unresolved | `HOLD` |

Production blockers cleared in this five-item readiness subset: **0 of 5**. Two
blockers now have a bounded next operation, but neither is verified or
authorized. The wider Evidence Matrix contains additional blockers.

## Code-size baseline

PR #48, commit `2e47fc367e109f4ce8a667f6b9bd6209501e9e2b`, remains the quality baseline:

- Active Runtime: 3,630 non-test `lib/`/`scripts/` LOC removed;
- repository delta: 71 additions, 4,185 deletions, net -4,114 LOC;
- broad tracked repository baseline: 411,959 newline-counted lines across all
  `git ls-files` before this readiness document (not a Production-code metric);
- incident Finalization state machine: removed;
- generic repair and durable Bundle activation state machines: retained;
- runtime code added by this readiness audit: 0 LOC.

The next deletion candidate must first prove reachability, Retention and active
rollback obligations. No further deletion is mixed into Bundle readiness.

## Independent audit resolution

Claude Code's read-only audits reported zero documentation P0 findings and
corrected documentation/design P1s. Production P0 blockers remain open. This
revision records the Candidate DELETE-mode swap precondition and that swap-back
is unimplemented, separates old/new plist identities, separates durable Journal
proof from Reader convergence, narrows usability claims, adds APFS
snapshot/unlink retention conditions, and exposes the second full-check budget
conflict. No runtime code was added to resolve the findings; Production remains
`HOLD`.
