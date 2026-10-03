# Phase 16A-3: revision semantics and market-price candidate audit

**Phase 16A-3 Complete: NO. Phase 16B Gate: NO-GO.** This is a research-only
snapshot. No ranking, public API/UI, model change, deployment, commit or push.

## Revision identity and effective snapshot

The actual EDINET instances expose `jpdei_cor:NumberOfSubmissionDEI` and
`jpdei_cor:IdentificationOfDocumentSubjectToAmendmentDEI`. They do **not**
expose a separate report-serial DEI fact in this sample. The report serial
is read, with its source recorded, from `DocumentTitleCoverPage` (e.g.
`変更報告書 No.1`); initial reports use 0. The EDINET document-index timestamp,
not the original date repeated inside an amended XBRL, supplies `submittedAt`.
The formal amended-document ID is retained unchanged. A correction supplies
its own complete corrected snapshot; no patch merging of holdings is performed.

The revision resolver groups by formal root and checks issuer, serial, source
hash and chronology. Unequal correction submission counts order the revision
when consistent with submission times. A direct parent link or one of the two
source-hash-locked, correction-narrative-adjudicated cases can order equal-count
corrections; an unknown equal-count fork fails closed. An as-of `YYYY-MM-DD`
includes the end of that day; an optional `YYYY-MM-DD HH:mm[:ss]` selects only
documents submitted at or before that minute/second. Withdrawal time is also
compared at timestamp precision. The full saved XBRL for each effective
document is selected without merging revisions.

| Root | Document | Cover serial | DEI count | Index submittedAt | Formal target | Effective predecessor |
| --- | --- | ---: | ---: | --- | --- | --- |
| S100Y0JP | S100Y0JP | 0 | 1 | 2026-04-24 14:56 | - | - |
| S100Y0JP | S100Y1GY | 0 | 2 | 2026-04-30 09:32 | S100Y0JP | S100Y0JP |
| S100Y0JP | S100Y1RL | 0 | **2** | 2026-05-01 09:10 | S100Y0JP | S100Y1GY (audited) |
| S100YZFC | S100YZFC | 1 | 1 | 2026-08-28 16:45 | - | - |
| S100YZFC | S100Z1X5 | 1 | 2 | 2026-09-14 14:39 | S100YZFC | S100YZFC |
| S100YZFC | S100Z26F | 1 | **2** | 2026-09-14 15:25 | S100YZFC | S100Z1X5 (audited) |

The two later corrections **cannot** be sequenced by their DEI counts alone.
Their existing signed-off adjudications cite immutable SHA-256 source snapshots
and the correction text; a missing predecessor or changed SHA aborts. Across
170 stored documents the independent audit finds zero currently unresolved
chains. Six intraday as-of transitions in these two groups pass. In other
documents, 12 amendment XBRLs repeat `NumberOfSubmissionDEI=1`, while five
non-amendment change reports have a count other than 1 (including report No.16
with count 16). The count must not be described as a universally reliable
correction ordinal; this remains a release blocker for unreviewed new forks.

Sources: [EDINET correction guidance](https://disclosure2dl.edinet-fsa.go.jp/guide/static/submit/WZEK0090_001.html),
[EDINET API v2 specification](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf),
[FSA 2026 form and 2026-05-01 changeover](https://www.fsa.go.jp/common/shinsei/tairyohoyu/index.html).

## Security/basis and pricing contract

The observed old/new taxonomy fact names are mapped into direct security,
subscription right, convertible bond, covered warrant, depository receipt,
trust beneficiary security, redeemable bond, exchangeable security and unknown
other. Every nonzero source fact preserves concept, holder context, quantity,
XBRL unit and the legal basis: main clause (ownership-like), item 1 (voting),
item 2 (investment authority), item 3 (derivative). The statutory main/item
columns and the group total are **not** a single investor-owned share count.
Margin-sale and joint-holder deductions are captured separately. If their
allocation to the direct row is unknown, market-price units remain null.
Potential securities are never multiplied by a common-share quote.

For the research candidate assessment, the direct row must be a positive safe
integer in XBRL shares, have exactly one positive legal basis, be bounded by
the position's reported total, have no unallocated deduction/class note, and
map by source issuer code to exactly one ticker-universe/dated historical
member and a recent-enough PIT close. The listed marker is taken from the
EDINET issuer cover. Mixed direct/potential filings price only the direct
component. `market_price_basis_json` keeps ownership/voting/investment/
derivative quantities distinct. These checks do not establish beneficial
ownership or an asset manager's own capital commitment.

The 170 documents (70 legacy/100 current, 20 initial/116 change/34 amendment)
contain 318 individual positions and 170 group totals, with 77 multi-holder
documents. Independent SAX XML checks cover **all 170 source documents**, all
318 holders, every stored direct/potential component and nonzero deduction:
zero source-field and group-total mismatches. Composition: 310 positions have
a positive direct row, two have only potential securities, 44 have both.

| Research assessment | Positions |
| --- | ---: |
| FULL_DIRECT candidate | 212 |
| PARTIAL_DIRECT candidate | 21 |
| AMBIGUOUS | 77 |
| NOT_APPLICABLE | 8 |

There are 233 price candidates in this limited sample; mean direct/total
coverage is 94.81%. Of these, 174 carry ownership-like basis and 59 carry
investment-authority basis. These are **not an investor-wealth ranking**.
The 20-position independent check rereads source facts, PIT `ohlcv_daily`
close and latest price, and recomputes units times close: zero differences.
The 2025-02-28 sample for ticker 8230 has ownership-like 2,202,002 units,
PIT close 310 yen and 682,620,620 yen research value. The 2026-03-23 sample
for 3290 has 26,365 investment-authority units, PIT close 81,400 yen and
2,146,111,000 yen *authority-based* value. No double counting of the 170
group totals. A historical quote is not automatically a current quote: ticker
555A's 2026-04-22 quote is stale relative to the 2026-09-18 market snapshot;
its current value is null, though its historical PIT value can be checked.

**Release blocker (P1):** the existing `ticker_universe` +
`historical_universe` + `ohlcv_daily` identify ticker, listing window and
prices, but do not explicitly encode the listed instrument's share class or
whether a quote is per equity share versus investment unit. The EDINET direct
row itself is `株券又は投資証券等（株・口）`, not necessarily common shares.
Research statuses above are therefore *candidates*, not final certified
eligibility for publication. An instrument/class/unit provenance audit must
precede a Phase 16B GO; do not silently treat 233 as approved valuations.
The 77 ambiguous rows must stay N/A.

The legal form explicitly distinguishes these security and deduction rows:
[FSA first form](https://www.fsa.go.jp/common/shinsei/tairyohoyu/05.pdf).

## Investor identity and independent QA

Of 165 investor identities: 56 individual, 16 institutional (nine domestic
asset managers, two foreign asset managers, four funds, one financial
institution), zero other, 93 unclassified. Automatic institutional evidence
comes exclusively from the holder's `IndividualOrCorporation` and
`DescriptionOfBusiness` (plus explicit foreign-entity status or a domestic
address), saved with source and confidence. Existing manual overrides are
untouched. Validation includes the EDINET-described investment-management
activity of Strategic Capital and an overseas Taiwan/Hong Kong manager, the
reported fund-management activity of two fund entities, and the explicit
`銀行業` activity of Macquarie Bank. A name containing “Asset” or “Capital”
is never sufficient. Unknown corporate business remains unclassified.

Dedicated synthetic tests cover source parsing, old/new forms, changes,
corrections with distinct/equal counts, unknown fork fail-closed, six timestamp
transitions, direct/potential separation, joint deductions, legal basis,
individual/institutional evidence, withdrawal and idempotent ingestion.
Research replay was performed twice from the saved immutable XBRL without
external requests, with stable 170/318/165 totals. The independent SAX audit
reports zero mismatches and zero unresolved revisions. `next typegen`,
`tsc --noEmit`, `npm run build`, and production smoke on the **unchanged**
port 3000 all passed (150/150). This production smoke does not validate
these undeployed research modules.

Raw stored XBRL text is 9,520,861 bytes. Newly retained structured position
payloads total 181,699 bytes, excluding SQLite page/index overhead; the
entire pre-existing external DB is approximately 546.8 GB, so no reliable
before/after file-size delta can be attributed to this phase. Neither Gmail
delivery nor a web deploy was invoked. Remaining P1: explicit class/unit
mapping provenance and non-universal DEI submission ordering in new correction
forks. No Phase 16B ranking/API/UI is permitted yet.

The independent market-price audit took 2.02 seconds elapsed and 249,561,088
bytes maximum RSS on this workstation. This is an offline replay/audit, not a
web-API latency claim. The stored research data remains in the existing DB;
no model, dataset artifact, or new web build was installed into production.
