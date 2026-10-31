# JP OHLCV Source and Reader lineage inventory

Status: Production blocker inventory. No Production reader was changed.

## Finding

Static inventory finds 94 files under `app/` and `lib/` that mention
`ohlcv_daily`. The table has no row-level Source Generation, and a Source Run
may commit insert-only rows before its derived refresh and publication finish.
Consequently, checking `batch_runs.status='success'` after reading is not an
atomic read barrier.

## Reader classes

| Class | Representative paths | Current source behavior | Strategy A requirement | Versioned Serving target |
| --- | --- | --- | --- | --- |
| Direct history and chart APIs | `app/api/history/[ticker]/route.ts`, `lib/custom-charts/server.ts`, `lib/chart-drill/server.ts` | Query live `ohlcv_daily`; can see `running` or `partial` inserts. | Hold Web, Analog, and Gateway before source mutation. | Read immutable Serving Generation. |
| Quote, stock, and screener APIs | `app/api/quote/[ticker]/route.ts`, `app/api/screener/route.ts`, `app/api/stock-snapshot/[ticker]/route.ts` | Mix live OHLCV with derived tables. | Hold read services until source and all required derived data agree. | Bind response to one Serving manifest. |
| Dashboard and sector reads | `lib/queries/dashboard.ts`, `lib/queries/sectors.ts`, `lib/queries/sector-stage-distribution.ts` | Live prices plus cached/derived rows; no shared receipt. | Rebuild and validate all affected caches before resume. | Manifest lists Source and cache generations. |
| Six-stage, Stage History, Trigger | `lib/research/six-stage-current-serving-adapter.ts`, `lib/server/trigger-*.ts` | Direct source reads and independently persisted derived rows. | Stop affected workers and readers during repair; verify lineage before resume. | Derived artifacts carry Source receipt identity. |
| Two-year line search | `lib/server/two-year-line-search.ts` | Fails closed unless latest JP Run is the latest successful Run, but reads live rows after the check. | Read hold remains necessary because check and read are not atomic. | Pin query to immutable generation. |
| Operational freshness/health | `lib/server/data-freshness.ts`, status routes | Uses live max dates and batch status, not a complete Serving manifest. | Report source and derived states independently. | Health validates one manifest. |

## Publication rule

Source `success` proves the target session Receipt and publication CAS only. It
does not prove that every Reader, derived table, or cache uses the same Source.
Production Serving is PASS only when a separate Serving manifest identifies the
Source Receipt and every required derived/cache generation.

Until that exists, Strategy A requires this read hold scope:

- Web and Analog;
- Friend Gateway/external tunnel origin access;
- Trigger and other workers that read live prices while persisting results;
- any ad-hoc report or API process connected directly to the Production DB.

The hold begins before the first source mutation and ends only after successful
Source publication plus derived/cache verification, or after verified rollback.

This hold is not enforced by the updater implementation in this PR. It remains
an operational Production blocker: live rows can become visible after Receipt
commit while the Source Run is still `running` or `partial`.

## Migration workstream

1. Add a single published Serving manifest and reader adapter.
2. Move History/SMA and core quote reads first.
3. Bind six-stage, Screener, Trigger, Dashboard, and two-year cache artifacts to
   the manifest's Source Receipt.
4. Reject mixed manifests and retain the read hold until every direct reader is
   migrated.

This is an independent workstream. This PR records the boundary but does not
claim the live-reader problem is solved.
