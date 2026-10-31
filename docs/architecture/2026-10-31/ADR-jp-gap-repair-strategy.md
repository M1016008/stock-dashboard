# ADR: JP 2026-07-17 Gap Repair Strategy

Status: Direction selected; Strategy A design HOLD; Production execution HOLD

## Problem

The current Production database contains 157 rows for 2026-07-17. The latest
official adjusted source contains 4,218 trading rows and 224 valid no-trade rows.
There are 155 exact matches, 4,061 missing rows, and two preserved conflicts.

The repair must not overwrite `1447` or `2164`, expose a mixed Source/Serving
state, lose later valid updates during rollback, or repeat whole-database checks
that prove no new invariant.

## Strategies

### A. Narrowed in-place transaction with bounded maintenance

Keep the current writer/read hold and full consistent backup, but simplify the
contract around one owner per invariant.

Flow:

1. Seal provider envelope, accepted content, no-trade content, approved keys,
   conflict values, real source watermark, and current serving watermark.
2. Hold all writers and prove no unknown DB handle.
3. Create one SQLite-consistent backup.
4. Normalize it, run one full `quick_check`, calculate one SHA-256, and issue an
   immutable backup verification receipt.
5. Renew the short-lived DB/source/serving snapshot after the long backup stage.
6. Hold direct readers.
7. Insert only residual approved keys with plain `INSERT` in one transaction;
   prove `approved = alreadySatisfiedExact + inserted` from affected rows.
8. Rebuild the approved derived DAG from one real source identity.
9. Verify target keys, conflicts, lineage, derived outputs, and service health.
   Provide a separate integrity proof for the mutated live DB; the present full
   `quick_check` cannot fit inside its 10-minute semantic stage, but deleting it
   without a replacement would remove the only post-write whole-DB check.
10. Resume readers and writers only after the in-place state is coherent.

Advantages: smallest Production behavior change, reuses tested barriers and
backup, and can be fully exercised in isolation.

Costs: long maintenance, approximately another 551 GB artifact, and expensive
rollback. Direct readers still require a hold. With about 915 GiB free before a
551 GB backup, the current rollback's extra `copyFileSync` temporary file is not
proven to fit and is a Production blocker.

Candidate variants to evaluate before implementation:

- **A1, current copy/restore:** keep only if preflight proves space for the live
  DB, verified backup, restore temporary file, failed-state retention, and
  operational reserve at the same time.
- **A2, filesystem clone/reflink:** use the existing copy-on-write clone
  capability only after filesystem support, allocation behavior, crash
  semantics, and independent byte verification are proven. This can reduce
  temporary capacity and I/O without changing the logical repair.
- **A3, fused restore copy and hash:** compute the trusted destination hash while
  copying, avoiding repeated reads of unchanged backup bytes. This is acceptable
  only if the backup receipt and destination verification remain independent.

### B. Immutable staged source/serving generation

Build a complete new source/derived generation outside the live database and
atomically switch a serving publication manifest.

Advantages: shorter final publication window, simpler rollback pointer, and a
clear long-term generation model.

Current blockers: the history API and other readers access the live source DB;
derived tables do not share one generation schema; valid writes after the staged
snapshot need a proven delta protocol; a second full database still needs space
and I/O. A pointer switch would not currently be atomic for all readers.

Decision: target architecture, not the immediate repair.

### C. Pre-validated old backup outside the writer hold

Reuse a previously checked backup to reduce maintenance.

Rejected. A backup that predates later valid updates cannot safely restore the
current Production state. Hash equality proves the backup's bytes, not equality
with the live DB. A delta/redo protocol would be a new recovery architecture and
is outside the minimal repair.

## Comparison

| Dimension | A: bounded in-place | B: versioned staging | C: old backup |
| --- | --- | --- | --- |
| Immediate code change | Medium, if narrowed | High across readers and derived tables | Low code, unsafe data semantics |
| Writer/read hold | Long writer hold; direct readers held around mutation | Short publication hold only after all readers migrate | Does not solve later-update preservation |
| Storage | Live DB + full backup + proven restore workspace | At least one full staged source/serving generation | Existing artifact, but stale relative to live DB |
| Rollback | Expensive restore; current copy path does not fit proven capacity | Publication pointer plus staged artifact retention | Would discard valid later updates |
| Generation integrity | Must add real repair/source receipt and rebuild all affected consumers | Native goal of the design | No current-generation proof |
| Testability | Good with a Production-scale time/capacity model | Good after migration; poor before it | Hash alone cannot prove applicability |
| Permanent operational load | Moderate if incident layers are retired | Lower long term, high migration cost | Unacceptable correctness risk |
| Decision | Recommended direction, design HOLD | Target architecture, not immediate repair | Rejected |

## Timing and storage evidence

Measured on a 551,171,977,216-byte artifact:

- SQLite backup copy: about 14m44s
- full `quick_check`: 3h30m24.68s
- SHA-256: 14m7.79s

The Production volume is APFS (`disk7s1`, UUID
`11FDA3F5-D89E-414D-9B95-C2069FF0B204`). At audit time it had about 915.3 GiB
free. A 513.3 GiB backup would leave about 402.0 GiB, while the current restore
temporary copy needs about 513.3 GiB before reserve or failed-state retention.
APFS supports clone semantics in principle, but the exact helper, allocation,
verification, and crash behavior for this path remain unproven.

Configured maxima currently include 5h45m for backup creation, 4h25m for full
check, 30m for SHA, 140m for the forward derived aggregate, 30m writer-stop SLO,
60m writer-restore SLO, and a 12h maintenance ceiling. This budget can fit only
if repeated whole-file checks are removed where they prove identical bytes, and
if final semantic verification does not run a 551 GB full scan in a 10-minute
stage. The configured caps themselves have almost no slack, so measured averages
are not sufficient evidence of maintenance-contract safety.

The immutable receipt does not weaken verification:

- backup creation proves SQLite integrity and content hash;
- receipt consumers prove receipt hash and current byte identity; inode/path
  metadata alone does not prove bytes remained unchanged;
- restore proves restored DB SHA equals the already verified backup SHA;
- a separately budgeted live-DB proof plus target/derived verification proves
  post-operation integrity, semantics, and lineage.

Any byte change invalidates the receipt and requires a new full verification.

## Required changes before Phase 2 GO

1. Replace the impossible 10-minute post-write full-DB `quick_check` contract
   with a budgeted post-write integrity proof. Retain targeted semantic checks;
   do not simply remove whole-DB integrity verification.
2. Prove rollback capacity before writer hold, including the restore temporary
   file and failed-state retention, or validate a filesystem-clone design.
3. Stop calling audit-only JSON pointers an atomic Source/Serving publication.
   Create a real source-run/repair receipt transactionally and update every
   affected serving/cache watermark, including the two-year line-search cache.
4. Make the ordinary updater report affected rows, not planned missing rows.
5. Complete the existing historical coverage gate: persist key/value/envelope
   evidence, keep unresolved gaps beyond the rolling window, and do not treat a
   `partial` run as publishable.
6. Define a deletion/retirement list for incident recovery, emergency recovery,
   resealing, and finalization layers after the incident retention period.
7. Measure corporate-action basis compatibility for all 4,061 missing tickers;
   preserve `1447` and `2164` beyond the one-time repair path.
8. Update stale runbook text that still says 4,067 rows and conflict-ignore.
9. Run the full isolated E2E with 157 existing, 155 exact, 4,061 inserts, two
   conflicts, Provider 4,442/4,218/224/0, derived rebuild, crash, and recovery.

## Production gate

Strategy A remains the recommended direction over B, but is not signed off as
written. The current Forward Package is not approved. Production remains HOLD
until Phase 2 resolves the blockers above, proves `P0=0/P1=0`, produces a current
live snapshot and hash-bound package, and receives a separate explicit approval.
