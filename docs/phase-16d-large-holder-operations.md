# Phase 16D Large Holder Operations

## Release state

This branch is isolated development. Do not install the LaunchAgent, set the production
`LARGE_HOLDER_RANKING_CURRENT_PATH`, deploy, or run a write command against the production
database until the Phase 16D completion gate is approved. INFRA-S2 has no independent backup.
The existing Phase 16C snapshot remains the production source.

## Publication contract

`snapshot-refresh` reuses the Phase 16A-8 regulatory certification, EDINET archive,
activity archive, and Phase 16B materializer. It does not implement a second parser or
valuation method. A generated snapshot is validated, written as an immutable SHA-256-named
file, and only then is `current.json` atomically replaced. The pointer records the base
snapshot, source cutoff, price date, position/certification/classification/review hashes,
generator version, and generation time. An invalid or stale pointer causes the public API
to return the existing unavailable response, not a silently old ranking.
The pointer also records the certified filing count and import/submission watermarks. A
new disclosure invalidates serving until re-certification. An old backfill chunk that
predates the current cutoff and the last one-year activity window may acknowledge an
unchanged effective position by republishing pointer metadata without rewriting the
immutable ranking snapshot.

Price readiness requires all three pre-existing records for the same market date:
successful J-Quants date-bulk sync, matching daily coverage and OHLCV row count, and a
completed required `update_latest` run after the sync. The latest failed/running run blocks
publication. The JP update lock prevents concurrent writers. Storage guard fatal/uncertain
states block the update; a storage fatal is not retried.

## Commands (approval required for writes)

Run from the approved release checkout with its configured environment:

```sh
npm run large-holders:update-status
npm run large-holders:update-daily -- --dry-run --from=YYYY-MM-DD --to=YYYY-MM-DD
npm run large-holders:snapshot-refresh -- --dry-run
npm run large-holders:backfill -- --dry-run --from=YYYY-MM-DD --to=YYYY-MM-DD --chunk-days=3
```

Only after the completion gate and an independent backup are approved should the
corresponding write commands run. Daily update accepts at most 14 calendar days. Backfill
accepts at most 31 calendar days per invocation and 1-7 days per chunk; resume requires
`--resume` and skips chunks marked `PUBLISHED`. A failed chunk is rechecked against EDINET
and the idempotent filing store. No historical valuation ranking is generated.

The dedicated LaunchAgent source is `scripts/install-local-large-holder-update.ts`.
It is **not** included in the existing all-services installer. It proposes two weekday
slots, 22:30 and 23:30 JST, after JP prices. Installation and activation require a separate
production decision after end-to-end isolated QA. The lock and price completion proof,
not the wall clock alone, determine whether a run may publish.

## Entity review

`/large-holders/admin/entities` and both admin APIs require a server-configured
`LARGE_HOLDER_ADMIN_TOKEN` of at least 32 characters. The token is held in browser memory,
not persisted. Without a validated current pointer, writes are disabled. Decisions are
source-linked and appended to a SHA-linked review ledger. Preview is required before
commit; merge rejects overlapping ticker positions or activities; undo replays the
immutable base snapshot. Review decisions do not mutate raw EDINET filings or the DB.
An accepted decision leaves the public snapshot stale until a new validated snapshot is
published. Never classify an investor solely by name.

## Incident and rollback

Do not manually edit SQLite WAL/SHM or the pointer. On storage uncertainty or FAILED_SAFE,
stop and inspect the existing storage guard; do not retry the write command until storage
is formally healthy. Preserve the event log, checkpoint, immutable snapshots, and review
ledger. A bad candidate snapshot cannot become current before validation; an invalid or
stale current pointer fails closed. Restore a prior validated pointer only through an
audited, atomic publication procedure, never by overwriting an immutable snapshot.

No Gmail, ML, Trigger Score, or historical PIT valuation is part of Phase 16D.
