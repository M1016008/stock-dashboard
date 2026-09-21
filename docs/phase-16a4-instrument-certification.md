# Phase 16A-4: official instrument identity and price units

**Phase 16A-4 Complete: NO. Phase 16B Gate: NO-GO.** This is a research-only
assessment at 2026-09-18. No ranking, public API/UI, deploy, commit or push.
Phase 16A-3's NO-GO remains in force. Phase 15F-Ops is untouched.

## Contract and sources

`large_holder_instrument_master` preserves the official five-character code
as text, dated issuer/master identity, product category, market, optional ISIN
and listing boundaries, full source row and SHA-256. `large_holder_price_evidence`
preserves the dated raw J-Quants close (`C`), adjusted close (`AdjC`), local
adjusted close, full official bar row and its SHA-256. The local `ohlcv_daily`
close is adjusted; it is reconciled to `AdjC` but is **not** used as the raw
per-share/per-unit valuation quote. `large_holder_position_certifications`
keeps research status separate from public status, PIT/current values separate,
evidence hashes and a reason. A missing current quote leaves current value
null even when a historical PIT quote exists.

The official dated master and bars come from J-Quants v2 `equities/master` and
`equities/bars/daily`. The JPX August 2026 listed-issues workbook is only a
cross-check on/after its September publication, never backfilled into an
earlier PIT date. J-Quants' domestic-equity category 011 and full code identify
the listed quote; category 013 spans REIT/infrastructure-fund products and is
left `UNRESOLVED` without a dated official subtype. The current JPX REIT list
confirms 3290 and 8968, but a current page is not historical PIT evidence.
Official listed-issue peer codes are stored; a same-prefix search does not
prove that an EDINET generic holding row names a particular listed class.

Sources: [JPX listed issues](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html),
[JPX REIT issues](https://www.jpx.co.jp/equities/products/reits/issues/),
[J-Quants listed-info code semantics](https://jpx.gitbook.io/j-quants-pro-ja/api-reference/listed_info),
[JPX stock trading unit](https://www.jpx.co.jp/equities/trading/domestic/03.html).
The 100-share **trading lot** is not a multiplier for a per-share market quote.

## Fail-closed public valuation

`PUBLIC_VALUATION_READY` requires a unique dated listed instrument, issuer
code/name, common-stock or separately proven REIT unit class, a direct EDINET
security component, matching explicit present-holding note and quantity
(`普通株式 N株` or `投資口 N口`), source-document hash, certified quote unit, official
raw quote with a rehashable source row, a reconciled local price series and a
fresh same-day current quote. No generic `株券又は投資証券等（株・口）` fact is accepted as
proof of ordinary shares or investment units. The synthetic regressions cover
2,202,002 shares x 310 yen = 682,620,620 yen (never x100) and 26,365 units x
81,400 yen = 2,146,111,000 yen **only with explicit REIT/unit evidence**.
These are contract fixtures, not public approvals for actual 8230/3290 filings.

The 233 actual research candidates (212 `FULL_DIRECT`, 21 `PARTIAL_DIRECT`)
have **zero** qualifying class-and-quantity holding notes in their saved EDINET
XBRL. One source document has a general investment-authority note with no
instrument class or quantity. Its previously persisted parsed JSON omitted
that note; the certification audit now reads the original SHA-256-verified
XML, so this old parse is not used to grant eligibility. Their direct-security
count is evidence for a research candidate, not
the listed common share or REIT investment unit. Accordingly:

| Public status | Position count |
| --- | ---: |
| PUBLIC_VALUATION_READY | 0 |
| SECURITY_CLASS_AMBIGUOUS | 233 |
| PRICE_UNIT_UNPROVEN | 0 (masked by class ambiguity) |
| PRICE_SERIES_MISSING | 0 (masked by class ambiguity) |
| STALE_ONLY | 0 (masked by class ambiguity) |
| OTHER | 0 |

The *separate official-instrument price-series* field is `CERTIFIED` on 231
candidate positions and `STALE_ONLY` on two 555A positions. The J-Quants
2026-09-18 row for 555A has `C=null`; its 2026-04-22 close cannot be called a
current value. Do not read the price-series status as permission to multiply
an unproved EDINET security quantity.

## Independent audit and coverage

The read-only cross-check script rehashes all **170 EDINET XML source documents**,
**198 master snapshots** and **198 official price rows** (90 unique
five-character instruments) independently
of the certification function. It checks source code/date/name/category,
unadjusted/adjusted values and local-series reconciliation. One current
official row is a no-trade/null-close row, not a usable quote. **217** candidate
positions have an exact EDINET code -> dated official instrument -> official
price-row chain; the minimum 50/50 mapping checks are exceeded with zero
source-field mismatches. The two historical issuer-name differences 6459
(`大和冷機工業` versus `だいわ`) and 7604 (`梅の花` versus `梅の花グループ`)
remain fail-closed until dated identity-change evidence is supplied.
Twenty research-candidate arithmetic examples were recomputed independently;
**zero public valuation examples exist**, so the required 20 public checks
cannot pass. No public value is stored for any of the 233 candidates.
The one old parsed-JSON note omission is recorded separately from source-field
mismatches; it does not identify a listed share class.

The existing latest-effective-revision selection returns 224 current
positions for 165 investors. Counting only positions in that selection (not
the 170 document group totals or superseded corrections) gives 0 COMPLETE,
0 PARTIAL and 165 NONE portfolios. This is count-based completeness; shares
from different issuers are never summed into a coverage percentage. Ownership
and investment-authority bases remain distinct and neither implies own funds.

Research storage adds 198 master rows, 198 price rows and 233 certification
rows: 629 rows and about 143 KB of saved source-evidence JSON, excluding SQL
row/index overhead. This is not a measured database-file delta; the external
SQLite file and its WAL have other concurrent writers. A repeat assessment
reuses the same primary keys and updates rows rather than appending duplicates.

## Remaining gate failures

- **P1:** no source-backed ordinary-share or investment-unit identity for any
  actual candidate holding; therefore 0 public-ready valuations and no 20-case
  independent public valuation check.
- **P1:** same-issuer class uniqueness cannot be established solely by the
  current same-code-prefix peer search. A different listed code/class and
  unlisted classes need explicit issuer/class linkage.
- **P1:** J-Quants' dated master row does not provide the issuer's EDINET
  code. The current mapping corroborates EDINET's own issuer code/name against
  the JPX-listed code/name, but is not a separate official EDINET-code
  crosswalk. It cannot by itself resolve historical renames or class identity.
- **P2:** the two category-013 instruments lack dated REIT-vs-infrastructure
  subtype and per-unit source evidence in the research master.
- **P2:** one historical parsed payload omitted a general holding note;
  source-XML reread now prevents that omission from affecting certification.
- **P2:** the historical issuer-name changes at 6459 and 7604 need dated
  rename/EDINET identity evidence before those old filings can be linked.
- **P2:** ISIN and exact listed-from/to are nullable and not independently
  populated for most snapshots. A dated master row proves presence only on
  that date, not an entire uninterrupted listing interval.

The source/price/hash checks and dedicated 100x and REIT unit fixtures pass;
those are insufficient for Phase 16B. Unresolved rows remain excluded. No
estimates, rankings or investor totals are exposed to users.
