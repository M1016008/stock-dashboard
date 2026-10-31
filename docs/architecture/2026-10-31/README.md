# StockBoard Architecture and JP OHLCV Phase 0-1

Status: `PHASE0_CONDITIONAL_GO / PHASE1_DIRECTION_GO_DESIGN_HOLD / PRODUCTION_HOLD`

This directory records the Phase 0 baseline audit and the Phase 1 target design
for StockBoard at Git head `4a6562a9f7713681b26039acbb8977feb53b4d64`.
It does not authorize a Production write, service transition, Forward Repair,
or merge to `main`.

## Decisions

- Continue designing Strategy A, a narrowed version of the existing in-place
  repair contract, for the one-time 2026-07-17 repair. It is not yet approved:
  the deterministic post-write timeout and rollback-capacity defects must be
  resolved in design and isolation first.
- Treat Strategy B, immutable/versioned serving generations, as the target
  architecture. It is not ready for the immediate repair because current readers
  do not all observe one atomic generation boundary.
- Preserve existing values for `1447` and `2164`; they remain a separate data
  quality HOLD even after missing rows are repaired.
- Keep one full integrity verification per immutable backup byte identity. Do
  not repeatedly scan 551 GB where a receipt plus a fresh byte identity proves
  the same invariant. Keep a distinct post-write integrity proof for the
  mutated live database; it cannot simply be deleted as a duplicate.
- Replace synthetic Source/Serving pointers over time with persisted source
  generations and immutable serving publication manifests that readers actually
  consume.
- Move one-time recovery orchestration out of the normal application runtime
  after its audit and rollback retention obligations expire.

## Current read-only evidence

At `2026-10-31T13:42:12.904Z`:

- Provider envelope: 4,442 rows
- Accepted trading rows: 4,218
- Valid no-trade rows: 224
- Invalid provider rows: 0
- Production rows for 2026-07-17: 157
- Exact matches: 155
- Residual missing rows: 4,061
- Preserved conflicts: `1447`, `2164`
- Production mutation by this audit: none

The complete evidence summary is in
`jp-2026-07-17-live-coverage-evidence.json`. Raw provider and Production-row
captures remain outside Git under `.audit/architecture-ohlcv-phase0-20261031`.

## Delivery index

Phase 0:

- `architecture-inventory.md`
- `dependency-map.md`
- `technical-debt-register.csv`
- `baseline-metrics.json`
- `ADR-architecture-options.md`
- `jp-2026-07-17-live-coverage-evidence.json`
- `jp-price-basis-lineage.md`
- `jp-source-serving-lineage-map.md`
- `isolated-e2e-baseline.md`
- `claude-independent-review.md`

Phase 1:

- `ADR-jp-gap-repair-strategy.md`
- `data-lineage-matrix.md`
- `rollback-state-diagram.md`

## Implementation sequence

1. Freeze the current safety contract with characterization tests and evidence
   schemas; do not change Production behavior.
2. Extract pure OHLCV, price-basis, coverage, and conflict rules into one domain
   owner without moving I/O code yet.
3. Make the real source watermark and serving publication manifest the single
   truth; include cache keys such as the two-year line search, and retain
   compatibility readers until every consumer migrates.
4. Complete the existing 260-session coverage gate: persist the outcome, stop
   treating `partial` as publishable, and retain unresolved gaps beyond the
   rolling window until they are explicitly resolved.
5. Separate three different proofs: immutable-backup integrity, mutated-live-DB
   integrity, and restore identity. Remove a full scan only when the same bytes
   and invariant are already attested, and prove rollback has enough space.
6. Run the complete Strategy A E2E in isolation, including 4,061 inserts, two
   preserved conflicts, crash recovery, derived rebuild, and service lifecycle.
7. Request a separate hash-bound Production approval only after Phase 2 has
   `P0=0`, `P1=0` and all UNKNOWN items needed by the run are resolved.
8. After Production repair is complete, split the architecture work into small
   module-level PRs. Do not mix it into the repair PR.

## Completion gates

Phase 0 is conditionally complete when every inventory item has an owner,
evidence source, and known/unknown status, the live read-only evidence is
reproducible, and the remaining Production-runtime commit identity is recorded.

Phase 1 is complete when the selected repair strategy, target dependency
direction, generation contract, rollback contract, and migration order are
approved. A design document alone does not make Production repair ready.

The existing isolated repair E2E passes as characterization only. Phase 1 design
remains HOLD until the two P0 defects and the P1 design findings in the ADR are
closed. Phase 2 has not started on this branch.

The overall architecture project is complete only when dependency cycles are
removed, critical logic has one owner, temporary recovery code is isolated or
retired with evidence preserved, Production no longer depends on a development
checkout, regression/safety tests remain green, and architecture checks prevent
the same coupling from returning.
