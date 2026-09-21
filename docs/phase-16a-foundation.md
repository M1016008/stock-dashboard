# Phase 16A: EDINET large-holder foundation

Status: **NO-GO for Phase 16B ranking / public release** (2026-09-21).

## Sources and boundaries

- EDINET API v2, 2026-06 specification: https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf
- FSA large-holding disclosure scope: https://www.fsa.go.jp/common/shinsei/tairyohoyu/summary/index.html
- `350` includes initial and change reports; `360` is the correction type in the live index. Preserve the actual `docDescription` and XBRL correction target. `parentDocID` is kept separately; it is not always a correction target.
- The issuer is read from XBRL `SecurityCodeOfIssuer`; index `secCode` usually identifies the filer and is frequently null. Do not use it as the issuer.
- Holder contexts use `FilersLargeVolumeHoldersAndJointHoldersAxis`. Un-dimensioned aggregate facts are group values, never additional investor positions.
- `StocksOrInvestmentSecuritiesEtcArticle27233MainClause` is broader than proven ordinary shares. It is retained as a candidate, not automatically multiplied by an ordinary-share close. Other instrument counts invalidate the candidate.

## Storage

Additive tables: `large_holder_filings`, `investor_entities`, `investor_aliases`, `investor_entity_relations`, `large_holder_groups`, `large_holder_positions`, `investor_identity_reviews`. The old `large_holding_reports` table and batch remain untouched.

Raw EDINET index and parsed source evidence are stored by immutable document ID; the EDINET document link and source timestamps remain attached. Holder addresses are private source/alias data and must never be sent through public APIs. A primary filer's EDINET code or exact normalized name plus address can resolve an entity; missing/ambiguous matches go to review. Corporate classification is not inferred from a name. Manual classification and confirmed relations are schema-level concepts only; no review UI yet.

`latestDisclosedPositions(asOf)` considers only documents submitted by the specified date. A correction supersedes its referenced source only when that source is ingested. A correction with a missing source is excluded rather than promoted to the latest position. A withdrawal notice excludes its target from its submission date onward; previous as-of dates retain their previous state. `GROUP` values are never aggregated with `ENTITY` positions.

## Sample ingest / gate

`USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/ingest-large-holders.ts --from=2026-09-17 --limit=20`

Limited live ingest (not a historical backfill): 20 filings, 42 holder positions, 20 groups, 32 entities (9 individual, 23 unclassified). Nine corrections reference filings not present in the sample. Valid latest positions at 2026-09-17: 21. Ordinary-share confirmed valuation positions: **0/42**. Raw filing JSON payloads total about 37.7 KB in the sample, excluding table/index overhead. No reliable full-DB before/after capacity measurement was taken.

The conservative valuation contract prevents the requested value/increase ranking from producing meaningful rows. Historic correction and withdrawal coverage also require chunked backfill and rescan. Do not expose an individual/institutional ranking as complete, or label an unclassified corporation institutional, based on this limited sample.

Before Phase 16B: establish document-backed ordinary share / listed unit eligibility rules and review ambiguous cases; ingest the referenced correction history; implement bounded resumable backfill and a withdrawal reconciliation audit. The latter is scoped to Phase 16D in the requested plan, so the ordering needs a safe data-coverage gate before a public Phase 16B/C ranking. No new public API, page, notification, or Gmail integration has been deployed by this phase.
