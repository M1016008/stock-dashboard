# JP Source and Serving Lineage Map

## Current source watermark

The real operational source watermark is the latest publishable
`batch_runs` row where `job_type='ohlcv_fetch:jquants'`. At the Phase 0 read:

- latest run: 8718
- latest publishable run: 8718
- running runs: 0
- status: `success`

Repair package files named `source-generation.json` are synthetic evidence. The
ordinary updater does not read or update them, so they cannot independently prove
that Production source bytes are unchanged.

The repair currently creates no new `batch_runs` row. Consumers such as the
two-year line-search cache treat `success` and `partial` batch runs as
publishable and key cache identity on that run ID. A repair that changes source
bytes while run ID 8718 remains current can therefore leave a pre-repair cache
apparently valid.

## Current serving watermark

The repair snapshot infers serving state from aggregates:

| Read model | Rows | Latest data date | Latest calculation |
| --- | ---: | --- | ---: |
| `daily_snapshots` | 13,334,306 | 2026-10-30 | 1793346086 |
| `stock_screening_serving_dates` | 52 | 2026-10-30 | 1793362444 |
| `dashboard_cache` | 105 | 2026-10-30 | 1793367130 |

This is a watermark, not a generation boundary. The history API reads
`ohlcv_daily` directly and does not select a serving generation. Consequently,
changing a sidecar serving pointer does not atomically change every reader.

## Current lineage classes

| Consumer | Input | Generation-aware today | Immediate repair requirement |
| --- | --- | --- | --- |
| History API / main chart | live `ohlcv_daily` | no | read hold during in-place mutation |
| SMA Dynamics Lab | History API + calendar | inherited, no independent generation | same hold and post-repair golden check |
| Daily snapshots | live source DB | aggregate watermark only | rebuild and verify source watermark |
| 6-stage current serving | source + serving projections | partial generation metadata | rebuild only approved current-serving outputs |
| Stage History | materialized DB data | table-specific | verify/rebuild if source-derived |
| Screener | snapshots/serving tables | table-specific | verify common source lineage |
| Trigger/Historical Scan | source/derived evidence | explicit repair generation in some paths | keep stopped where contract is sealed |
| Dashboard/API cache | materialized cache | aggregate watermark only | invalidate/rebuild with source lineage |
| Two-year line-search cache | live source + latest publishable `batch_runs` ID | run ID cache key; `partial` accepted | create a repair/source receipt and invalidate or rebuild against it |

## Target model

`SourceGeneration` is persisted in the same transaction as the source mutation
or is attested by a transactionally written repair receipt with equivalent
identity. It includes:

- generation ID and parent;
- provider contract/content hash;
- price basis;
- source batch run ID;
- schema identity;
- per-session coverage digest;
- publication timestamp and status.

`ServingPublication` is immutable and references one Source Generation plus the
hash and schema of every required read model. Readers consume exactly one
publication manifest. A publication is current only after every required artifact
passes semantic verification.

## Migration rule

Until a consumer uses `ServingPublication`, it is classified as direct-source and
cannot justify zero-downtime publication. Strategy A therefore retains bounded
read-service hold. Strategy B becomes eligible only when the lineage matrix has
no unclassified direct reader for the affected data.
