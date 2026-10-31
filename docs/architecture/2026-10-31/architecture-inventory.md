# Architecture Inventory

## Scope and method

Baseline: `4a6562a9f7713681b26039acbb8977feb53b4d64`.

The inventory combines tracked-file counts, TypeScript AST metrics, static import
edges, Next.js entry points, npm commands, launchd installers, child-process
entry points, and targeted execution-path review. Static imports alone are not
used to label code as unused; CLI, launchd, dynamic imports, and Next.js routing
remain part of the reachability model.

## Repository surface

| Area | Current responsibility | Main risk | Intended owner |
| --- | --- | --- | --- |
| `app` | Pages, route handlers, validation, orchestration | Routes contain DB, calendar, price adjustment, and side effects | `ui` and `serving` |
| `components` | View state, charts, domain calculations | Large components and parent-child type cycles | `ui` |
| `lib/db` | Connection, schema, migrations, query helpers | `client.ts` is a 314-import hub; schema/migration are very large | `data/storage` |
| `lib` market/data modules | Provider parsing, calculations, serving rules | Price-basis and generation logic has multiple owners | `domain`, `adapters`, `data/*`, `serving` |
| `scripts` | Tests, batch jobs, installers, release/recovery | 477 npm entries; operations and tests are mixed | `operations`, `data/ingestion`, `tests` |
| `types` | Shared API and UI types | Some types remain owned by UI parents, creating cycles | owning domain module |
| `.audit` artifacts | Approval, lineage, recovery evidence | Synthetic pointers can be mistaken for live serving boundaries | `operations/evidence` outside runtime |

## Quantitative hotspots

- 1,344 tracked JS/TS-family files, 357,786 lines.
- 53 files have at least 1,000 lines.
- 24,604 function-like AST nodes.
- 504 functions are at least 100 lines.
- 605 functions have approximate cyclomatic complexity at least 20; 185 are at
  least 40.
- 168 API route files and 57 page files.
- 477 npm scripts: 205 `test:*`, 17 `audit:*`, and 19 install-related entries.
- 246 tracked test-like files, mostly mixed into `scripts`; no dedicated test
  ownership boundary.
- The repair/recovery branch delta from Production baseline adds 39 files and
  17,399 lines in the narrowly named JP OHLCV family. This is not the whole
  branch delta: `034310b..4a6562a` changes 365 files, adds 76,595 lines, and
  deletes 1,634. The narrower metric is retained only to size the incident
  subsystem, not the total change surface.

Largest files include:

| File | Lines | Observation |
| --- | ---: | --- |
| `app/stock/[ticker]/StockDetailClient.tsx` | 4,738 | stock detail workflow and presentation are coupled |
| `lib/db/schema.ts` | 3,640 | unrelated schemas share one owner |
| `app/screener/page.tsx` | 3,258 | page, data model, filtering, and rendering are mixed |
| `lib/db/migrate.ts` | 2,971 | migration history and active migration mechanics are coupled |
| `components/charts/CandlestickChart.tsx` | 2,163 | rendering, interaction, and chart-domain rules are mixed |
| `lib/jp-ohlcv-production-repair.ts` | 1,686 | approval, journal, rollback, and lifecycle state share one module |
| `scripts/orchestrate-jp-ohlcv-rollback-finalization.ts` | 1,452 | gateway, services, evidence, journal, and writer recovery are coupled |

## Runtime ownership findings

### History serving

`app/api/history/[ticker]/route.ts` currently owns DB reads, manual-data fallback,
corporate-action normalization, a 1306-derived market calendar, timeframe
aggregation, and two-year registry side effects. The main chart and SMA Lab both
depend on this route, so one route change can alter data, calculations, and UI.

### Database access

`lib/db/client.ts` selects the database, initializes Storage Guard, classifies
mutating SQL, enforces the repair barrier, configures PRAGMAs, exposes QA hooks,
and participates in schema migration. Its 314 importers make it a system-wide
blast-radius multiplier.

### OHLCV ingestion and quality

The current Head includes a 260-session historical-gap gate in
`scripts/batch-ohlcv.ts`. It can downgrade a run to `partial` and exit nonzero,
but the deployed updater predates that gate. The design is still incomplete:
`partial` remains publishable in at least one cache watermark, the rolling
window eventually forgets an unresolved gap, and the result is not a durable
coverage ledger. A successful later day therefore still does not provide a
system-wide proof that every earlier required session is complete.

### Repair and recovery

The repair subsystem correctly accumulated fail-closed checks in response to
real incidents, but approval identity, backup verification, process supervision,
launchd state, read readiness, gateway migration, data mutation, generation
publication, rollback, and finalization now form one operational state machine.
This makes a local correction capable of invalidating a nested sealed identity
or unrelated recovery stage.

### Production runtime

Some immutable runtime checks and a bundled Friend Gateway exist, but there is
no repository-owned producer for the general runtime manifest. All 20 legacy
installers still derive paths from `process.cwd()`, three embed
`node --import tsx`, and daily jobs shell through `npx tsx` in that captured
working directory. Production can therefore regress to a mutable development
dependency unless every installer accepts only an explicit, content-hashed
runtime manifest.

## Safety contracts to preserve

- Storage Guard and `FAILED_SAFE` remain fail-closed.
- Production and isolated paths cannot alias or escape the isolation root.
- Provider envelope, accepted rows, no-trade rows, and rejected-row reasons are
  hash-bound.
- Approved repair keys may shrink only when the exact official row is already
  present; new keys and value conflicts remain HOLD.
- Plain `INSERT`, unique key enforcement, and affected-row verification are the
  repair success path; conflict suppression is not success evidence.
- `1447` and `2164` are preserved, not silently adjudicated.
- Source/Serving lineage, PIT boundaries, stopped research, and writer/read
  service identities remain explicit.
- Automatic retry, lock deletion, evidence rewriting, and unapproved rollback
  remain forbidden.

## Initial GO/HOLD

- Phase 0 architecture work: GO.
- Phase 1 direction: GO; Strategy A design sign-off: HOLD.
- Phase 2 implementation/E2E: not started in this branch.
- Production repair or service changes: HOLD pending a later explicit approval.
