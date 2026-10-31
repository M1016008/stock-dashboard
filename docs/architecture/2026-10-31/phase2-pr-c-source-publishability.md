# Phase 2 PR C: JP OHLCV source publishability

## Safety contract

A JP `ohlcv_fetch:jquants` generation is publishable only when its latest run is
`success`. A terminal `partial` run remains evidence, but it cannot become the
source generation for a repair snapshot or a two-year line serving cache.

The rule is centralized in `lib/jp-ohlcv-source-generation.ts`. Runtime repair
snapshots and the JP two-year line reader use the same status constant. US
source-generation behavior is intentionally unchanged.

This deliberately makes JP serving unavailable after any terminal `partial`
run until a clean `success` run completes. That operational cost is preferable
to presenting a generation with unresolved coverage or post-refresh failures as
complete.

## Verification

- Runtime snapshot rejects a latest `partial` run while retaining the previous
  successful run as the last publishable run.
- The JP two-year line cache rejects a latest `partial` source generation.
- The existing US contract continues to accept a terminal `partial` generation.
- A subsequent clean `success` run can be captured and rebuilt normally.

Run `npm run test:jp-ohlcv-source-publishability` and `npx tsc --noEmit`.

## Remaining Phase 2 work

This PR does not create the persistent 260-session gap ledger, the DB-bound
repair receipt, or exact insertion receipts. It also does not claim that every
derived reader has migrated to versioned serving. Those remain blocking P1
work before a Production repair can be proposed.
