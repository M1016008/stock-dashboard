# Dependency Map

## Static graph baseline

The tracked JS/TS graph has 1,344 nodes and 3,946 relative or alias import edges.
High-level edge counts are dominated by `scripts -> lib` (1,357), `lib -> lib`
(858), `app -> lib` (545), `app -> components` (325), `components -> components`
(312), and `components -> lib` (304). The graph also contains 51
`scripts -> components` and 45 `scripts -> app` edges, mostly because tests and
operations live together in `scripts`.

## Current high-level flow

```text
J-Quants
  -> lib/jquants.ts
  -> scripts/batch-ohlcv.ts
  -> lib/db/client.ts
  -> stockboard.db / ohlcv_daily
  -> derived tables and caches
  -> app/api/history + screeners + dashboards
  -> UI charts / SMA Lab

Repair evidence + package
  -> command adapter / runner / state machine
  -> writer hold
  -> 551 GB backup + integrity checks
  -> target-date insert
  -> derived rebuild
  -> synthetic source/serving pointers
  -> read service resume
  -> writer resume
```

The synthetic generation pointers are audit evidence. They are not a universal
read switch: the history route and many other consumers read the live database
directly.

## Highest fan-in modules

| Module | Importers | Consequence |
| --- | ---: | --- |
| `lib/db/client.ts` | 314 | connection, safety, and migration changes affect most features |
| `types/stock.ts` | 68 | broad shared model ownership |
| `components/ui/PageTitle.tsx` | 53 | expected UI utility fan-in |
| `lib/market-universe.ts` | 52 | universe policy affects many workflows |
| `lib/storage/external-storage-guard.ts` | 45 | legitimate safety hub but requires a stable interface |
| `lib/db/schema.ts` | 37 | schema ownership is too broad |
| `lib/jquants.ts` | 30 | provider adapter and adjustment logic are coupled |
| `lib/jp-ohlcv-data-quality.ts` | 29 | repair-specific and permanent quality rules share one file |

## Highest fan-out modules

`StockDetailClient.tsx` imports 37 modules, `SmaDynamicsView.tsx` 23, the hex
pages 19, the screener page 17, and the rollback finalizer 14. These are useful
indicators of orchestration ownership, not automatic reasons to split a file.

## Confirmed cycles

1. `components/hex/HexMap.tsx` and the `components/hex/stage-screener/*` cluster
   exchange UI types through the parent component. Move `HexMapStock` and shared
   result contracts to a type-only domain file.
2. `lib/large-holders/instrument-certification.ts` and
   `lib/large-holders/cross-document-evidence.ts` mutually import certification
   and evidence logic. Extract the shared evidence contract and pure matching
   rules below both modules.

## Target dependency direction

```text
ui
  -> serving contracts
serving
  -> data/derived read models
data/derived
  -> domain/market-data
data/ingestion
  -> domain/market-data
  -> data/storage ports
  -> adapters/jquants ports
adapters/jquants
  -> domain/market-data contracts
data/storage/sqlite
  -> domain identifiers only
operations/recovery
  -> application ports for storage, generation, and service lifecycle
runtime/launchd
  -> immutable runtime manifests
```

Forbidden target edges:

- domain modules to SQLite, HTTP, Next.js, launchd, or the filesystem;
- UI components to DB clients or repair state;
- provider adapters to serving publication;
- ordinary ingestion to one-time recovery packages;
- Production launchd manifests to a worktree or development `node_modules`;
- read APIs to audit-only synthetic generation pointers.

## Migration checks

Each extraction PR should add or update a boundary check, preserve golden output,
and reduce or hold the measured fan-in/fan-out for the touched owner. A file move
without a dependency-direction improvement does not satisfy the architecture
goal.
