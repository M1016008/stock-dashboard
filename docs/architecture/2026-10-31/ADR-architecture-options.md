# ADR: StockBoard Target Architecture

Status: Proposed for Phase 1

## Context

StockBoard is a large modular monolith with useful domain code, direct SQLite
read models, 168 API routes, 477 npm commands, and launchd-operated jobs. The
main problem is not the monolith itself. Ownership boundaries are implicit, a
few shared modules have system-wide fan-in, and incident-specific safety logic
has become part of the normal runtime surface.

The target must preserve fail-closed storage, PIT, lineage, generation, and
recovery behavior while reducing the number of modules that can define the same
truth.

## Options

### Option 1: File splitting without dependency changes

Split large files into smaller files while preserving imports and ownership.

Rejected. It improves navigation but does not change the DB client blast radius,
generation ambiguity, runtime coupling, or recovery state ownership. It can
increase indirection without reducing risk.

### Option 2: Immediate services/microservices split

Move ingestion, serving, derived calculations, and recovery into separate
processes and databases.

Rejected for the current project. The operational contract, deployment surface,
distributed transactions, and generation protocol would all grow before a
single source of truth exists. This is too large a change beside an unresolved
data repair.

### Option 3: Evolutionary modular monolith with immutable serving publications

Keep one repository and most current deployment units, but establish enforced
module ownership, pure domain contracts, explicit storage ports, persisted
source generations, immutable serving publications, and incident recovery
packages outside ordinary runtime code.

Accepted.

## Target modules

| Module | Owns | Must not own |
| --- | --- | --- |
| `domain/market-data` | OHLCV identity, price basis, sessions, coverage, conflicts, generation identifiers | HTTP, SQLite, filesystem, Next.js |
| `adapters/jquants` | API v2 paging, retries, provider envelope, provenance | DB writes, serving publication |
| `data/ingestion` | daily acquisition workflow, gap reconciliation, durable coverage completion | UI and launchd details |
| `data/storage/sqlite` | transaction, schema adapters, backup receipt, writer lease | provider or business decisions |
| `data/derived` | reproducible SMA/stage/screener/trigger build DAG | service lifecycle and approval |
| `serving` | versioned read models, publication manifest, read contracts | ingestion retries and repair policy |
| `operations/recovery` | approval, journal reducer, service lifecycle ports, runbooks | normal application business logic |
| `runtime/launchd` | immutable runtime manifests and launchd reconciliation | worktree discovery or dev dependencies |
| `ui` | presentation, interaction, loading/error/empty states | DB mutation and generation decisions |

## Source and serving truth

The target Source Generation is a persisted record created in the same database
transaction that makes an ingestion result publishable. It binds provider
contract, price basis, source run, schema identity, coverage digest, and parent
generation.

The target Serving Generation is an immutable manifest that references exactly
one Source Generation and hashes every published read model. A reader either
opens one manifest/generation or fails closed. An audit sidecar may mirror this
identity, but cannot be the only publication boundary.

Migration is incremental. Direct-source readers remain explicitly classified
and require read-service hold during an in-place repair until they consume a
versioned publication.

## Recovery model

Use a small append-only event journal and a pure transition reducer. Keep DB
backup/restore, service lifecycle, writer lease, and approval verification as
separate adapters. Incident-specific target rows, approval packages, and
fixtures live under an incident package and are removed from normal entrypoints
after retention requirements are met.

This does not remove safety checks. It makes each invariant have one verifier and
one signed receipt that downstream stages can validate.

## Consequences

- Existing routes and jobs remain while compatibility facades are introduced.
- Strategy B publication becomes possible only after all relevant readers use
  the publication manifest.
- Architecture work is delivered as small PRs with characterization tests and
  measured dependency changes.
- No directory-wide move or rewrite is authorized by this ADR.

## Architecture acceptance criteria

- No import cycle in the tracked TypeScript graph.
- Domain modules have no I/O framework imports.
- Every Production process is built from an immutable runtime manifest.
- Every JP OHLCV trading session has a durable coverage outcome and unresolved
  past gaps cannot be hidden by a later successful day.
- Every served derivative identifies the Source Generation that produced it.
- A backup's full integrity scan has one verification receipt bound to its
  current bytes; repeated scans are justified by a different invariant, not
  process boundaries alone. The mutated live DB retains an independently
  budgeted integrity proof.
- Incident recovery code is not reachable from ordinary application execution
  after closure.
