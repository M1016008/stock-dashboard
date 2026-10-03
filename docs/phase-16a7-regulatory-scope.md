# Phase 16A-7: Regulatory-Scope Instrument Certification

Phase 16A-7 research implementation: **YES**. Phase 16B Current Ranking release gate: **NO-GO** until the P1 items below are addressed. Historical PIT gate: **NO-GO**. No ranking API/UI, migration, production integration, deploy, commit, or push is part of this phase. The older Phase 16A-6 `RETROSPECTIVE_TRUTH` and `AS_KNOWN_AT_TIME` contracts remain unchanged; `REGULATORY_CURRENT` is the new, explicit current-only mode. It must never be used for historical backtests.

## Authority and scope

- The [FSA large-holdings overview](https://www.fsa.go.jp/common/shinsei/tairyohoyu/summary/index.html) describes the reported securities, excludes non-voting shares under its conditions, and includes investment securities. The [FSA Q&A, question 7](https://www.fsa.go.jp/news/21/sonota/20100331-12/03.pdf) explicitly keeps otherwise non-voting shares in scope when they can be exchanged for voting shares. Conditional voting and unknown rights are not excluded.
- The [JPX code definition](https://www.jpx.co.jp/glossary/ma/429.html) describes the four-character issuer identity and fifth class-specific character. Filing-native code is retained as text; a five-character code is never silently shortened. Four-character filing codes select the *listed* peer candidates from the complete date-specific J-Quants master, not from the 90 locally cached target rows.
- Class-specific controls: [25935](https://www.jpx.co.jp/equities/products/preferred-stocks/issues/tvdivq0000007usm-att/25935g.pdf) has conditional voting rights and stays ambiguous; [94345](https://www2.jpx.co.jp/disc/94340/140120230925557770.pdf) is expressly non-voting without conversion to common and can be excluded for its own effective interval only. Neither rule is generalized to all preferred shares. An unknown class is never excluded.
- The [JPX REIT issues list](https://www.jpx.co.jp/equities/products/reits/issues/) identifies 3290 (JP3047640002, One REIT) and 8968 (JP3046240002, Fukuoka REIT) as investment-corporation securities. The issuer name, filing code/exchange, current product 013 row, XBRL direct-security quantity, and raw price series must agree. The 3290 statutory issuer record is supplemental; a historical complete class table and historical JPX interval are not prerequisites for the **current** estimate. Any observed transition contradiction fails closed.

The scope registry stores type, voting state, eligibility, effective interval, authority, reference, normalized source evidence, and its hash. **The hash authenticates the curated interpretation, not the bytes of the JPX/FSA website or PDF.** This is an evidence-strength limitation for an eventual public ranking. `issuedTotal` is supporting only. A strictly recognized transaction row in the 60-day text block supplies optional class context, never current held units. Potential securities and transaction quantities are not priced. No lot-size multiplier is applied. Institutional ownership and investment-authority bases remain distinct; investor class `UNCLASSIFIED` remains unclassified.

## Read-only real-data audit (2026-09-21)

Valuation and latest market date: **2026-09-18**. Full J-Quants master: **4,451** distinct current securities, paginated and content-digested. Research candidate positions: **233**. Latest effective direct candidates: **179**; superseded positions: **54**, not ranked.

| Classification | Count |
| --- | ---: |
| `FILING_EXPLICIT_CLASS` (A) | 0 |
| `FILING_CODE_REGULATORY_UNIQUE` (B) | 174 |
| `CROSS_DOCUMENT_REGULATORY_UNIQUE` (C) | 5 |
| `MULTIPLE_ELIGIBLE_CLASSES` | 0 |
| `UNKNOWN_REGULATORY_SCOPE` | 0 |
| `CODE_AMBIGUOUS` | 0 |
| `REIT_UNRESOLVED` | 0 |
| `STALE_PRICE` | 0 |
| `OTHER` | 0 |

Research-only `PUBLIC_CURRENT_VALUATION_READY`: **179** (ordinary **174**, REIT **5**). None is served publicly yet. Portfolios: **131 COMPLETE / 7 PARTIAL / 27 NONE** across 165 entities; the remaining latest positions may have non-direct or otherwise ineligible quantities. Independent official EDINET redownload and J-Quants master/bar/amount comparison: **55 positive positions** (first 50 plus 5 REIT), **0 mismatches**. Correction unresolved: **0**. Observed filing-to-obligation instrument conflicts: **0** (only saved dated instrument evidence can be checked; absence is not proof of absence). Real negative controls include conditional 25935 and non-voting 94345; dedicated synthetic fixtures also cover multiple voting classes, unknown rights, missing and stale data, transition, potential securities, 100x multiplication, and unresolved REIT. No actual multi-class holder occurred among the 179 current candidates.

Investor class foundation: **56 individual / 16 institutional / 93 unclassified** entities. The unclassified group must not enter either named-category ranking by inference. Joint-holder entity keys, effective correction revisions, and ownership-versus-investment-authority parsing remain as in earlier phases; foundation and current/PIT regression tests pass.

## Gate and remaining risks

- **P0 0; P1 2; P2 2.** P1: immutable raw official JPX/FSA class/list source evidence has not been pinned and independently re-verified by the research runner; the curated listing and class-rights records currently hash only their interpreted JSON. P1: live production health was HTTP 200 but slow (~14.5 s) on the first read-only probe, then timed out after 12 s even after the isolated build had completed; `/stock/7003` timed out after 25 s and `/api/quote/7003` after 20 s. These are production-process observations, not evidence that this undeployed change caused them. P2: 93 investors are unclassified; observed transition checks are limited to available dated instrument rows, not a complete corporate-action history.
- The current **research** contract and 55 sample values pass, but the Phase 16B **public-release** gate remains NO-GO pending those P1 checks. Do not publish the inferred amounts, build a ranking API/UI, or turn this mode into a historical analysis. Historical PIT keeps its separate NO-GO and its strict historical source rules.
- The audit opens the live SQLite file with `readOnly: true` and `PRAGMA query_only=ON`. J-Quants and EDINET requests are reads. Approximate runtime **35 seconds**, peak RSS **172 MB**, DB schema change **0**, DB writes **0**. Production `.next-live/BUILD_ID` remains `oUvilpUSCSqYkRtuwuV3Q`.

Reproduce (read-only): `STOCKBOARD_DB_PATH=<existing DB> node --env-file=.env.local ./node_modules/.bin/tsx scripts/audit-large-holder-regulatory-current.ts --as-of=2026-09-18`. This uses the API credentials already in the local environment without logging them. It does not invoke any DB-writing Phase 16A ingest/reassessment script.
