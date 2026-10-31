# ADR: JP OHLCV coverage, conflict, and source publication

Status: Proposed for Production; implemented only in the isolated Phase 2 branch.

## Decision dimensions

The updater records three independent decisions. They must not be collapsed to
one `success` flag.

| Missing coverage | Data-quality conflict | Source publication | Meaning |
| --- | --- | --- | --- |
| `COMPLETE` | `CLEAN` | `PUBLISHABLE` | Every official target-session row is present and equal. |
| `COMPLETE` | `KNOWN_CONFLICTS` | `PARTIAL_HOLD` | No row is missing, but one or more sealed conflicts remain unchanged. |
| `INCOMPLETE` | `CLEAN` or `KNOWN_CONFLICTS` | `PARTIAL_HOLD` | Official rows remain absent. |
| any | `NEW_CONFLICTS` | `HOLD` | An unapproved provider/value disagreement was observed. |
| any | evidence or CAS failure | `HOLD` | The result cannot be attributed to the sealed Source Run. |

Zero inserted rows are therefore valid evidence. A complete, clean session
produces a `PUBLISHABLE` receipt with `insertedKeys=[]`; a complete session with
known conflicts produces a `PARTIAL_HOLD` receipt instead of an exception.

## Historical conflicts

The current policy remains conservative: every open historical conflict is
part of the coverage projection, so 1447 and 2164 keep Source Publication in
`PARTIAL_HOLD`. This preserves the existing fail-closed contract and is not a
claim that a historical conflict must block every future session forever.

A future scoped-publication policy may permit a new clean session while keeping
historical conflicts quarantined, but only after every direct reader and cache
can consume the issue scope and Source/Serving lineage. That policy is not
enabled by this PR.

## Commit boundaries

1. `ohlcv_daily` insert-only writes, the immutable daily Receipt, and Coverage
   Head CAS commit in one SQLite transaction while the matching `batch_runs`
   row remains `running`.
2. Derived and cache refreshes run outside that transaction. Their failure does
   not erase source evidence and cannot make the Source Run publishable.
3. Source publication is a separate SQLite write transaction after the Coverage
   Head is rechecked. The Coverage freshness row, J-Quants sync `success`, and
   `batch_runs` success CAS commit together. A `partial` or failed run never
   replaces the latest successful Source Run or writes success freshness.

The history API still reads the live database directly, and not every cache has
an immutable Source receipt. Production design approval therefore remains
`HOLD` until the direct-reader and cache lineage migration is complete.

## Corporate actions and fallback

The existing full-history corporate-action path uses UPSERT and can change
previously stored values. The ticker fallback also bypasses the daily boundary.
Both are rejected before source mutation by the isolated updater connection.
They require a separate bounded contract that validates provider revision,
Price Basis, affected dates, and open conflict protection. This ADR does not
weaken that requirement.

The daily provider envelope proves only the target session. Revisions to older
dates without an open ledger issue are not inferred from that envelope. A
multi-date Corporate Action or historical reconciliation must supply its own
sealed provider evidence before it may update those rows.
