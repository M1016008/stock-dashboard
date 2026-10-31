# Phase 2 PR G: JP OHLCV ingestion boundary

The boundary performs target-date reads, old open-issue observations,
insert-only writes, ingestion Receipt construction, and coverage-head CAS in
one SQLite write transaction. A failed head write therefore rolls back the
OHLCV inserts too.

Only conflicts already sealed in the prior ledger are carried forward. The
first bootstrap requires an explicit conflict ticker set; later bootstraps are
rejected. New conflicts, changed protected conflicts, missing observations,
and stale heads fail before commit.

Bootstrap covers only conflicts observed on the target date. The next
Production adapter must obtain the bootstrap ticker set and its hash from a
sealed approval, rather than constructing approval from the live rows.

This PR remains an isolated adapter. `batch-ohlcv.ts` is not switched to it,
and no Production schema or service changes. The next PR must make this the
single normal-updater write path and atomically map `PUBLISHABLE` to Source
`success` while mapping every partial result to non-publishable `partial`.
