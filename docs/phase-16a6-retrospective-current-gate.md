# Phase 16A-6: Retrospective Truth and Current Ranking Gate

Phase 16A-6 Complete: **NO**. Contract separation and source audit are implemented, but real security-class certification and public current valuation are not ready. Phase 16B Current Ranking Gate: **NO-GO**. Historical PIT Valuation Gate: **NO-GO**. No ranking API, UI, deployment, commit, or push was performed.

## Certification contracts

- `RETROSPECTIVE_TRUTH` reconstructs the security identity for an obligation date using official evidence available on the certification date. A later-published source is admissible only if its effective/as-of evidence actually covers the obligation date. Price date and certification date are separate. The latest official market date is an explicit freshness input; an earlier raw close cannot be treated as current.
- `AS_KNOWN_AT_TIME` delegates to the existing PIT certification unchanged. A later-published source cannot enter historical research through the current-mode path. Current-ready and historical-PIT-ready are distinct flags.
- The filing's `FilingDateInstant` issuer name, security code, listed status, and exchange are recorded as source facts with concept, context, value, document ID, submission time, and XBRL hash. Filing-native code is the primary identifier; the current EDINET code list is reconciliation evidence, never an identity substitute or a historical-list hard blocker. Name differences generate a warning, not a failed join.
- Only the positive `DIRECT_SECURITY` breakdown is eligible. Total stocks-or-equivalents and potential securities are not multiplied by price. The direct component sum, source concept, and source unit must reconcile to the candidate quantity. A class table proves only its explicit as-of date unless independently dated effective intervals are available; today's single class cannot establish a past single class.
- A unique ordinary listed class requires `SHARE` and `JPY_PER_SHARE`. A REIT requires an issuer investment-unit fact, official dated JPX REIT identity/listing interval, `UNIT`, and `JPY_PER_UNIT`. Current JPX listing alone does not prove past listing. Multiple or unallocated classes fail closed. A trading lot is never applied to direct units.
- A public amount, if certified, is latest effective disclosed direct units times fresh unadjusted raw close. It retains holding-information date, latest filing date, price date, certification date, and disclosure age. This is a **latest-disclosure-based estimate**, not proof of continuing ownership.
- The Phase 16A-6 evaluator is research-only and in memory. It does not publish or persist valuation-ready rows. Existing immutable source XML supports re-parsing of old filings; new parser payloads carry the issuer source facts for future ingest. No live ingest or schema migration was run.

## Read-only audit, 2026-09-21

Price date: 2026-09-18, also the latest `ohlcv_daily` market date. Certification date: 2026-09-21. The production SQLite file was opened with `readOnly: true` and `PRAGMA query_only=ON`; no migration or write path was called.

| Result | Count |
| --- | ---: |
| Research candidate positions | 233 |
| `CURRENT_VALUATION_CANDIDATE` | 179 |
| `RETROSPECTIVE_UNIQUE_COMMON` | 0 |
| `RETROSPECTIVE_UNIQUE_REIT` | 0 |
| `MULTIPLE_CLASS_AMBIGUOUS` within 233 | 0 |
| `NO_HISTORICAL_CLASS_EVIDENCE` | 179 |
| `NO_FILING_SECURITY_CODE` | 0 |
| `NO_MARKET_INSTRUMENT` | 0 |
| `STALE_CURRENT_PRICE` | 0 |
| `OTHER` (superseded research rows) | 54 |
| `PUBLIC_CURRENT_VALUATION_READY` | 0 |
| `PUBLIC_HISTORICAL_PIT_VALUATION_READY` | 0 |
| Common / REIT ready | 0 / 0 |
| Portfolio COMPLETE / PARTIAL / NONE | 0 / 0 / 165 |

All 233 rows contain a filing-native issuer security code. All 233 lack a saved EDINET code-list snapshot before their obligation date; this is **not** the reason the 179 current candidates fail. Their first blocker is zero official class records with an as-of/effective date covering their own obligation date; accordingly zero have a complete issuer class count at that date. A dated market-instrument row exists for 182/233, so the remaining 51 would also need separate instrument evidence if they became current-ready candidates. The existing issuer capital extractor records a `FilingDateInstant` point only; it cannot be stretched backward or forward without official interval evidence. There were 9 issuer-name warnings, zero saved-source mismatches, zero direct-component mismatches, and zero unresolved correction chains. There are 224 latest effective positions across 165 portfolios. Investor-class foundation: 56 individual, 16 institutional, 93 unclassified.

An actual two-class issuer, 3350 (E02978), has common and preferred classes in a saved statutory record; its two position rows are `AMBIGUOUS` and outside the 233 direct research candidates. Independently downloaded official Ito En annual-report facts (E00414, 2026-07-21) also contain both ordinary and preferred shares. The multi-class negative-control rule is exercised in a dedicated regression, but no uncertified position was promoted to public-ready. A real REIT report (E27884, 2026-05-28) confirms 973,670 issued investment units. It does not supply the missing independently dated listed-instrument/class bridge for a held position, so the real-data REIT positive control **cannot pass**. Synthetic complete-evidence REIT fixtures verify only the unit contract; they are not production proof.

Independent re-download/check: 50 distinct latest-effective EDINET XBRL documents, 50 matching J-Quants official master rows, 50 matching unadjusted price rows, zero mismatches. Independent **public valuation** checks: zero, because the ready set is empty. The 50 source/price matches must not be described as 50 validated values. The real multiple-class and REIT source controls were fetched separately.

## Release blockers and verification

- P0: 0 identified. P1: 2: obligation-date complete class/listing-interval coverage for the 179 candidates; real REIT unique listed-instrument evidence. P2: 3: 51/233 positions lack a dated market-instrument row, 93 investor entities remain unclassified, and independent amount checks are impossible until there are ready values. P3: 0 identified. The complete joint-holder no-double-count property is covered by the existing foundation regression, but cannot be certified for a public ranking containing no ready values.
- Phase 16B remains NO-GO: `PUBLIC_CURRENT_VALUATION_READY` is 0 versus the minimum 20, and independent valuation checks are 0. The historical code-list/PIT gap remains a separate historical-research gate, not a current-ranking blocker. Do not add inferred valuation, ranking UI, or ranking API.
- Regression: current/PIT mode, later-published source, filing code, name warning, direct/potential split, multiple/preferred class, REIT units, 100x lot guard, missing/stale raw price, correction/joint-holder foundation, and old instrument certification passed. Next typegen, `tsc --noEmit`, and isolated production build passed. Build used a separate temporary SQLite path and `SKIP_SCHEMA_ENSURE=1`; the live OWC DB was not used for build writes.
- Full production smoke was **not rerun** because the existing 150-check suite writes and deletes a saved-screening QA definition in the live DB. Read-only live checks: `/api/health` 200, `/stock/7003` 200, `/api/quote/7003` 200 with price 4,383, and `/api/trigger-discovery/options` 200 in 41.4 seconds. A 20-second probe of the latter timed out; this is a live-service performance caveat, not a Phase 16A-6 code change. The last previously reported full smoke was 150/150; that is not a new result.
- Official cross-check runtime 37.9 s, peak RSS 220,020,736 bytes. No dataset/artifact was written; no production DB schema change or DB write. No production integration, Gmail delivery, deploy, commit, or push. Live build ID remained `oUvilpUSCSqYkRtuwuV3Q`.

Reproduce the read-only audit with `node --env-file=.env.local ./node_modules/.bin/tsx scripts/audit-large-holder-current-certification.ts --as-of=2026-09-18 --official-crosscheck`. This command does not call the earlier DB-writing Phase 16A instrument audit.
