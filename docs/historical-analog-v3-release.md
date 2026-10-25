# Historical Analog v3 release gate

`MA_SEQUENCE_VERSION=3` changes the on-disk index contract. The v3 index must
be built and verified before a Web build containing this version is promoted.
This procedure does not authorize a Production build, database write, service
restart, or index generation by itself.

## Preconditions

- Use a clean release checkout at the approved merge commit. Record the live
  build ID and the enabled/disabled LaunchAgent inventory.
- Confirm Storage Guard health, the approved JP and US source identities, free
  capacity, and that no conflicting analog-index writer is running.
- Keep the existing v2 files and live Web build in place. The v3 defaults use
  separate `analog-sequence-jp-v3.db` and `analog-sequence-us-v3.db` paths.
- Use only the existing guarded source and target clients. Do not change an
  expected identity or bypass a failed guard.

## Build and verify

1. Hold the existing analog-index update chain for the approved maintenance
   window. This does not require stopping read-only Web traffic.
2. From the release checkout, run `npm run batch:analog-index:jp-full`, then
   `npm run batch:analog-index:us-full`, with the approved environment and
   explicit source/target paths. Do not rely on an unreviewed relative path.
3. A target remains unpublished while `analog_sequence_meta.completed` is
   `0`. Accept a market only after the builder exits successfully and records:
   `version=3`, `completed=1`, the expected market/source date, non-empty
   coverage and row count, the frozen feature schema and embedding width,
   `price_completed=1`, and `price_chunks_completed=1`.
4. Reopen each v3 target read-only through the guarded client. Require its
   source date to equal the latest approved source date and run the existing
   analog regression/smoke checks. Runtime checks reject a missing, stale,
   `completed=0`, or wrong-version target with a feature-local 503. The price
   completion flags, feature schema, and embedding width are additional
   manual release gates; do not promote merely because the endpoint can use a
   slower fallback.
5. Start the staged Web build on its private port and smoke both JP and US
   Historical Analog endpoints. Promote only when both markets return the
   expected result set from v3.

The response cache does not need a destructive purge. Its key includes
`MA_SEQUENCE_VERSION`, score version, source date, and source-generation file
identity, so v2 entries cannot satisfy a v3 request.

## Cutover, daily update, and rollback

- Promote the staged Web build atomically only after both v3 indexes pass.
  Resume the held update chain after ordinary Web, Analog, and Storage smoke
  checks pass.
- Subsequent daily updates use the existing JP-then-US index update chain.
  While a market is incomplete or stale, its Analog endpoint fails closed;
  the other market and ordinary StockBoard functions remain independent.
- Roll back by restoring the recorded prior Web build, which continues to use
  the untouched v2 paths. Do not delete v2, delete a failed v3 target, rewrite
  metadata, or alter Storage Guard identity as part of rollback.
- Any new `FAILED_SAFE`, source/target identity mismatch, incomplete metadata,
  stale source date, unexpected LaunchAgent change, or JP/US smoke mismatch
  aborts the release and follows the existing Production recovery procedure.
