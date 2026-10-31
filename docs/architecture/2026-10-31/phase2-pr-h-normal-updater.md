# Phase 2 PR H: normal JP OHLCV updater connection

This PR separates normal daily ingestion from Historical Repair.

- Daily ingestion accepts a complete session with zero inserts and emits an
  immutable Receipt.
- Historical Repair retains its non-empty approved-key set, approval hash, and
  residual-key contract unchanged.
- The normal date-bulk path binds the Coverage transition to the real running
  `batch_runs.id`.
- Source publication is permitted only when Missing Coverage is complete, Data
  Quality Conflict is clean, and the Coverage Head is for that same Source Run.
- Existing open conflicts remain observable and non-publishable. New conflicts,
  provider revisions, stale CAS, and changed protected values fail closed.
- Corporate-action full-history writes, per-ticker fallback, filtered runs, and
  forced full-history runs are intentionally not connected. They cannot silently
  fall back to the old UPSERT path.

The Production bootstrap must be generated from approved evidence containing
the open 1447 and 2164 issues. The normal updater refuses to invent a first head
from a later clean trading day.

## Remaining Production blockers

1. Corporate-action history needs a sealed multi-date Price Basis contract.
2. Every direct reader and Source-dependent cache, including two-year Line
   Search, needs an attributable Source/Serving receipt before a clean run can
   be published atomically.
3. PR #34/#35 Production-scale integrity, APFS clone capacity, and 12-hour
   failure-path measurements remain open.
4. Current Adjusted Price Basis and Corporate Action evidence for the residual
   4,061 keys is not yet complete.

No Production database, service, Generation, or main branch is changed by this
PR.
