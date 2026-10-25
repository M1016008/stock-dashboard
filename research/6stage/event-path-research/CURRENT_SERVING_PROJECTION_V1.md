# Current Serving Projection Connection V2

Plan ID: `SIX_STAGE_CURRENT_SERVING_PROJECTION_CONNECTION_V2`

Status: `READY_FOR_EXPLICIT_PRODUCTION_APPROVAL`

Supersedes plan SHA-256 `c900fad1f280a4a23514f088e75739a6ad7eb9234f4bf41c93e2197ce05881b6`.
The prior plan and any prior approval are not reusable.

This plan connects current JP/US Serving features to the already-frozen Discovery research without adding current outcomes to Discovery. It does not authorize execution by itself.

## Fixed implementation

- Integration commit: `1e6538c926aaab3a6da890ef9b6c514e50f6534e`
- Production baseline that may receive the selective hook only: `034310b72f57163ee4607c05d1057310277a787d`
- Runner: `scripts/build-six-stage-current-serving-projection.ts`
- Runner SHA-256: `895de1a3dd740e5ad2d7c41e9bc2a7bf93f14395a5b3a1cb573153accad66d01`
- Runner process SHA-256: `52e3c7749b8410f8e47ee87c2a14d8f817066a005fd7787cf21a9bded30c6875`
- Runner attestation SHA-256: `86ee65dcdea9aed412c7454e1396e7125619296e31b8cd5730ec4a6eefc55b13`
- `tsx` CLI SHA-256: `8690135061bc49d187143493b82d26a09b7fb71d6dd817d2242cc9dc52506de9`
- `tsconfig.json` SHA-256: `8bfad791bc4b05646d03aaf269e2af7040657275ebb4fa5daa798b1e09380dbf`
- `package-lock.json` SHA-256: `82df6d57da29984a1ee3e939aaef0efbbefc27f3ae996a502e25bcaf45a4faec`
- JP hook source SHA-256: `77a6d6fd68e2ccb54c7539d3b0db63d51c7c0f038a6b22308cf6b897ae4eac48`
- US hook source SHA-256: `de3a6c4a23d305c4704209780c328d7d1ecfadad65bef4c0e4238f5fc3c366e5`

The integration checkout must be a clean, dedicated OWC checkout at the exact integration commit. The runner refuses a different commit, dirty tracked files, a runner outside that checkout, or a dependency hash mismatch. Runtime uses the checkout-local Node/`tsx`/`tsconfig`/lockfile; it does not resolve an arbitrary global executable.

## Source and semantics

The adapter runs only as an opt-in post-success step while the existing JP or US daily update lock is still held. It reuses the guarded Serving clients already owned by that update process. A research API request cannot start the adapter and cannot open either Production database.

Per market, the adapter reads only current indexed rows from:

- `ticker_universe`: exact active ticker population and non-empty identity;
- `daily_snapshots`: latest six-stage state and SMA values;
- `ohlcv_daily`: current close on the same market date;
- `ml_feature_vectors_v2`: `ma_physics_v4`, exact stage age, and SMA200;
- `feature_snapshots`: daily SMA slopes and curvatures;
- `physical_momentum_metrics`: raw velocity, acceleration, Momentum, Force, Energy, and official PMS/PFS/PES when present;
- US only, `us_analytics_metadata.ohlcv_price_basis`.

The latest active Universe count must exactly equal the current valid-stage population, identity count, and current-close count. ML, SMA, and Physical rows must match at least 95% of that exact population and must have the identical market date. Missing values within the accepted auxiliary coverage remain `null`; they are never filled with zero. A market with a missing active ticker snapshot, invalid current stage, missing identity, or missing current close fails closed and retains the prior generation.

Price basis is a fixed code contract, not a configurable label:

- JP: `jp-split-normalized-v1`, produced by the pinned J-Quants adjusted-ingestion implementation.
- US: `tiingo_adj_ohlc_ratio_v1`, additionally required to match `us_analytics_metadata` at runtime.

Two-state and three-state transitions use contiguous distinct regimes, not the latest two or three rows. An invalid stage or a gap greater than 60 calendar days terminates continuity. The current state age, when present, must be a positive integer exactly equal to the observed consecutive current-regime length. A missing age remains `null`. The history walk is indexed, bounded at 4,096 rows per ticker, and fails closed if that bound prevents establishing the required regimes.

No outcome, forward price, realized return, MFE/MAE, target, label, Validation/Holdout field, or recommendation is read or published. Current rows are query vectors only and never enter frozen Discovery distributions.

## Projection contract

- Definition: `six_stage_current_serving_projection_v1`
- Markets: JP and US, independently staged and jointly published.
- Maximum combined rows: 20,000.
- Maximum immutable generation size: 64 MiB.
- Maximum adapter wall time per market: 5 minutes.
- Source reader concurrency: 1.
- Auxiliary coverage floor: 95% for ML, SMA, and Physical rows.
- Freshness: each market as-of date no older than 8 days at publish and read time.
- JP/US as-of skew: at most 4 days.
- API page size: at most 200.
- API rate: at most 2 requests/second per loopback process.

Each market is first written to a new immutable stage with row hashes and a complete manifest. Combined publication occurs only after both market stages pass definition, source-generation, coverage, freshness, hash, row, and byte checks. The combined generation is written to a partial directory, fsynced, renamed atomically, and selected by atomic replacement of `CURRENT.json`. A verified orphan from interruption may be adopted idempotently. The prior selected generation is never overwritten or deleted by this integration.

## OWC output identity

- Mount: `/Volumes/OWC Express 1M2 80G`
- Volume UUID: `11FDA3F5-D89E-414D-9B95-C2069FF0B204`
- Projection root: `/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage/current-serving-projection`
- Required owner: the daily update runtime user.
- Required mode: `0700`; no group or other permissions.
- Required free space: at least 5 GiB and the existing Storage Guard free-space policy.

The runner verifies the real path, volume UUID, filesystem device, owner, mode, symlink absence, and free space before writing. A missing or changed OWC mount cannot fall back to the internal SSD.

## Release isolation

No Web build or application deployment is used. `.next-live` and `.next-live-prev` are not switched. No schema migration, index, scheduler, LaunchAgent label, schedule, or enabled/disabled state is changed.

The only Production source change permitted is a selective backport onto exact baseline `034310b72f57163ee4607c05d1057310277a787d`:

1. Add the fixed runner-process and runner-attestation helper files.
2. Add the reviewed opt-in post-success hook hunks to `scripts/update-latest.ts` and `scripts/update-us-latest.ts`.
3. Verify the resulting diff contains only those two imports, two bounded post-success hook blocks, and the two helper files.

The full main branch, PRs #12-#17, API route, UI, and other undeployed changes must not be copied into Production. Any baseline or selective-diff mismatch is `NO-GO`.

## Activation configuration

Only the existing JP and US daily update LaunchAgents may receive these environment values; their labels, programs, schedules, disabled flags, and all unrelated values remain byte-for-byte unchanged:

- `CURRENT_SERVING_PROJECTION_ENABLED=1`
- `CURRENT_SERVING_PROJECTION_INTEGRATION_ROOT=<dedicated OWC checkout>`
- `CURRENT_SERVING_PROJECTION_INTEGRATION_COMMIT=1e6538c926aaab3a6da890ef9b6c514e50f6534e`
- `CURRENT_SERVING_PROJECTION_RUNNER_PATH=<integration root>/scripts/build-six-stage-current-serving-projection.ts`
- `CURRENT_SERVING_PROJECTION_RUNNER_SHA256=895de1a3dd740e5ad2d7c41e9bc2a7bf93f14395a5b3a1cb573153accad66d01`
- `CURRENT_SERVING_PROJECTION_TSX_SHA256=8690135061bc49d187143493b82d26a09b7fb71d6dd817d2242cc9dc52506de9`
- `CURRENT_SERVING_PROJECTION_TSCONFIG_SHA256=8bfad791bc4b05646d03aaf269e2af7040657275ebb4fa5daa798b1e09380dbf`
- `CURRENT_SERVING_PROJECTION_PACKAGE_LOCK_SHA256=82df6d57da29984a1ee3e939aaef0efbbefc27f3ae996a502e25bcaf45a4faec`
- `CURRENT_SERVING_PROJECTION_ROOT=/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage/current-serving-projection`
- `CURRENT_SERVING_PROJECTION_MOUNT_PATH=/Volumes/OWC Express 1M2 80G`
- `CURRENT_SERVING_PROJECTION_VOLUME_UUID=11FDA3F5-D89E-414D-9B95-C2069FF0B204`
- `CURRENT_SERVING_PROJECTION_MIN_FREE_BYTES=5368709120`
- `CURRENT_SERVING_PROJECTION_JP_MIN_ROWS=<approved preflight value>`
- `CURRENT_SERVING_PROJECTION_US_MIN_ROWS=<approved preflight value>`
- `CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE=0.95`

The two minimum-row values must be recorded from the latest previously successful normal Serving generation before activation and may not be lowered during execution. They are additional floors; exact active-Universe equality remains mandatory.

## Initial connection execution

After separate approval, execute once in this order:

1. Verify Production baseline commit and the four-file selective diff; verify the dedicated OWC integration checkout, hashes, OWC identity, permissions, capacity, Storage Guard health, and current Web/Analog health.
2. Record both daily LaunchAgent definitions and states. Apply only the approved environment additions without changing labels, schedules, programs, or disabled states.
3. Run the existing JP daily update entry point once through its normal guarded path, or allow its next already-scheduled successful run. The adapter must observe the exact JP update lock, complete within 5 minutes, and stage JP without selecting a combined generation.
4. Repeat for US through its normal guarded path. US source metadata must attest `tiingo_adj_ohlc_ratio_v1`.
5. Publish only after both market stages pass. Validate generation and file hashes, manifests, row/byte limits, market dates, source generations, null/coverage semantics, loopback API page/rate limits, and exact/similarity fixture parity.
6. Confirm the normal JP/US updates succeeded independently of projection publication and that Web/Analog/Storage Guard remain healthy.

There is no projection retry loop. A projection failure logs a bounded error, keeps the prior generation, and does not convert a successful price update into failure or retry. External SIGINT/SIGTERM and the 5-minute deadline are forwarded to the detached process group; residual descendants are terminated and treated as failure.

## Loopback boundary

The research API reads only the immutable OWC artifact. It performs no SQLite call. It requires the isolated research runtime, `SIX_STAGE_REAL_RESEARCH_ONLY=1`, loopback listening, and loopback request provenance. Public hosts, forwarded public hosts, Cloudflare headers, preview/share mode, missing runtime evidence, generation mismatch, stale data, or excessive rate/page size return a closed response. Similarity is labeled as deterministic feature closeness, never a probability or recommendation.

## Rollback and stop conditions

Stop without publication on any commit/hash/path/UUID/owner/mode mismatch; Storage Guard error; source-generation change; incomplete active Universe; source date or price-basis mismatch; stale JP/US market; row/byte/deadline breach; partial market stage; publication hash failure; public-route exposure; or normal daily update conflict.

Rollback is limited to:

1. Set `CURRENT_SERVING_PROJECTION_ENABLED=0` or restore the two LaunchAgent environment dictionaries to their recorded prior values.
2. Restore only the four selectively changed Production source files from the exact baseline snapshot.
3. Leave the previous verified projection generation selected; do not delete incomplete evidence automatically.

Rollback does not run `web:deploy`, switch Web builds, restore a database, alter Storage Guard, change a schedule, or touch Discovery, Validation/Holdout, SanDisk, or Production schema.

## Verified QA

- Adapter fixture: PASS, including exact Universe/identity/close coverage, auxiliary coverage, source-date and price-basis mismatch, C-age parity, invalid/gapped regime boundaries, update-lock ownership, process-group timeout, and interruption recovery.
- Projection fixture/API: PASS, 36 JP/US rows, atomic publication, old-generation protection, public-route rejection, page/rate limits.
- Frozen real research Store regression: PASS, 11,179,679 events unchanged.
- Storage Guard regression suite: PASS.
- TypeScript: PASS.
- Isolated Production Build on OWC: PASS.
- Codex independent reviews: `NO_P0_P1`.
- Claude Code read-only review: `NO_P0_P1`.

## Exact separate approval required

One explicit approval must name this plan's final SHA-256 and authorize only:

1. creation of the clean OWC integration checkout at the fixed integration commit;
2. the four-file selective Production source integration described above;
3. the two existing daily LaunchAgent environment-only changes described above;
4. creation of the exact OWC projection root;
5. one bounded initial JP then US projection generation through the normal guarded daily update contexts;
6. verification and atomic selection of the combined generation; and
7. rollback of only those changes if a stop condition occurs.

It must not authorize a Web deploy, `.next-live` switch, full-main release, schema/index change, new scheduler, LaunchAgent enablement, research-side Production DB connection, Discovery Store mutation, future outcome ingestion, Validation/Holdout access, SanDisk operation, or SMA Dynamics Lab deployment.
