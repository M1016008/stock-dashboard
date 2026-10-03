# Phase 16B-1: Current large-holder read model

Status: **Phase 16B-1 functional gate PASS; Phase 16C UI gate GO.** No production deploy or 16B commit/push has been performed.

## Data contract

- `scripts/build-large-holder-ranking-snapshot.ts` is an offline, read-only materializer. It requires a content-addressed 16A-8 evidence manifest and a read-only SQLite connection. It verifies the official raw archive and derived-fact/decision hashes, resolves corrections with the unchanged 16A revision contract, confirms the latest entity-by-issuer position set, and rejects a stale market date.
- Only the manifest's 179 positive lineages become `PUBLIC_CURRENT_VALUATION_READY`. The other current positions remain unvalued; their missing value is never added as zero.
- The output is a create-only, content-addressed JSON file outside Git and the production DB. No runtime artifact belongs in the repository.
- API requests load this snapshot once, then run four small read-only freshness checks against filing, price, market and position fingerprints. A changed database or absent snapshot returns 503 rather than an old ranking.
- `LARGE_HOLDER_RANKING_SNAPSHOT_PATH` and `STOCKBOARD_DB_PATH` must be configured before serving the new APIs. Phase 16B-1 does not deploy or change production configuration.
- Default ranking basis is `OWNERSHIP`; `INVESTMENT_AUTHORITY` is separate. Neither is a cost basis or a buy/sell amount.

## Activity limitation

Activity rows require both filings' official raw archives to match the stored XBRL, an effective non-amendment root filing, and the same single direct instrument, unit and legal basis as the current certified position. A rate-limited append-only 16B activity manifest supplies the 22 effective historical filings absent from the 16A-8 archive. With it, all effective filings are archived, and the current certifiable universe has 10 new-5% events, 5 increases and 4 decreases. These are not exhaustive market-wide activity counts; the API states `FULL_EFFECTIVE_FILINGS_CERTIFIED_INSTRUMENTS` only when every effective filing is verified.

All 19 available certified activity events and 138 valued investor totals were independently checked against read-only SQLite data with zero mismatches. The snapshot must be regenerated after new EDINET filings or a newer market-price date; until then, the API fails closed with 503. Production deployment requires an explicit later release decision.
