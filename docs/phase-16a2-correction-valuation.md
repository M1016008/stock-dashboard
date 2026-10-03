# Phase 16A-2: Correction chain and valuation evidence audit

Status: **NO-GO** for Phase 16B, ranking, public APIs, and production deploy.
This is a research-only ingestion/read-model checkpoint. No legacy large-holding
pipeline or Trigger/ML calculation was changed.

## Primary sources and rules

- [EDINET API v2 specification](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf): document types 350/360 and `parentDocID` (a correction's source or a change report's source *if provided*). The index submission timestamp is authoritative; dates in attached files only provide index lookup hints.
- [EDINET large-holding correction guidance](https://disclosure2dl.edinet-fsa.go.jp/guide/static/submit/WZEK0090_001.html): corrected inline-XBRL is a complete revised instance, and the DEI submission count should increment for each correction. The two real parallel cases below both reuse count 2, so that count cannot establish their sequence. The correction narrative and immutable source hashes support the two explicit predecessor adjudications instead.
- [FSA 2026-05-01 large-holding reform](https://www.fsa.go.jp/common/shinsei/tairyohoyu/index.html): choose the legacy/current form by **obligation date**, even for a post-reform submission about a pre-reform obligation.
- The observed EDINET XBRL holder axis is `FilersLargeVolumeHoldersAndJointHoldersAxis`. Its un-dimensioned total is a group aggregate, never another investor. Observed numeric `StocksOrInvestmentSecuritiesEtcArticle27233MainClause` is broader than ordinary shares. Transaction detail mentioning ordinary shares does not prove the current ordinary-share position.

## Implementation and limits

Direct EDINET document-ID retrieval plus the public cover HTML and XBRL archive
filename supplies candidate index dates; only a matching document-ID row in the
date-indexed API establishes `submittedAt`. A correction's attached XBRL and
sometimes its public header retain the original filing date, so these are never
treated as its actual submission date. A correction recursively fetches
its target until the original/change filing is found. Raw index snapshots and
SHA-checked XBRL are retained; a changed XBRL for a known ID aborts. Position,
classification and revision metadata are derived separately. A correction is
not an acquisition/disposal event. `resolveRevisionChains(asOf)` rejects a
missing origin, identity/time conflict, cycle or unknown parallel fork. The latest
position reader considers only known, unsuppressed, effective revisions at
the requested date; a later correction cannot change the earlier state.
`compareCorrection` exposes before/after issuer, obligation date and individual
holder shares/percent; group totals are not added to individual positions.

There were **two parallel-correction forks (four amendment documents)** whose
formal XBRL targets point to the same original rather than the earlier amendment.
The formal target remains unchanged in storage. An evidence-locked derived
predecessor is recorded for the two later corrections only:

- `S100Y0JP` -> `S100Y1GY` -> `S100Y1RL`: the latter's correction narrative explicitly identifies the 2026-04-30 correction cover as erroneous. The two attached XBRL instances have the same SHA-256 and holdings. The latter becomes effective only after its 2026-05-01 submission.
- `S100YZFC` -> `S100Z1X5` -> `S100Z26F`: the latter's correction narrative changes only the representative name, and its complete attached XBRL retains the earlier correction's 385,000-share holding (the original had 373,500). Both submitted on 2026-09-14; the later index timestamp is 15:25.

Each exception requires both audited XBRL SHA-256 values, the expected formal
target, and the predecessor to be visible. A changed source or a new unknown
fork fails closed. `compareCorrection` uses the derived predecessor, while the
raw EDINET `correctedDocumentId` remains intact. The 170-document audit now
finds **zero missing origins and zero unresolved revisions**. Stored derived
root/sequence columns were reconciled from the immutable saved source.

Valuation records numeric instrument components using their actual XBRL
concept/context. An eligible ordinary-share count requires an explicit,
entire-field present-holding note (`NotesNumberOfStocksEtcHeldTextBlock`,
`普通株式 N株`), bounded by the reported total and broad stock count. Its
fact/context/quantity is retained as evidence. Otherwise the position remains
NOT_PROVEN with null eligible shares; no use is made of recent transactions,
the broad stock row, ADR equivalent counts, or inferred common shares.
Synthetic eligible, ineligible and partial cases are tested. No positive
real-document example was found, so there is no PIT close multiplication to
validate on real positions.

Investor category storage supports individual, domestic/foreign asset
manager, fund, financial institution, operating company, other corporation,
and unclassified. Only the explicit `個人` source field auto-classifies.
Institutional/other categories require a documented evidence-backed manual
decision. The zero institutional count is therefore a **classifier coverage
limitation**, not evidence that the sample has no institutions.

## Research sample (2026-09-21)

Limited dates: 2026-04-30, 2026-05-01, 2026-09-14..17; recursive origins
include earlier dates. Not a historical backfill. The examined 170 filings
include 20 original, 116 change, 34 correction; 70 legacy and 100 current.
32 were submitted on/after May 1 for a pre-May 1 obligation. All 34
correction targets are present. Four amendments are in the two parallel forks.

There are 318 holder positions, 170 groups and 165 identities: 56 individual,
0 institutional, 0 other, 109 unclassified. 77 filings have multiple holders.
Ordinary-share proven 0, partial 0, not proven 300, not applicable 18;
eligible coverage is 0/318. Source XBRL is about 9.5 MB in the research DB.
The 100-document stratified independent SAX extraction compared issuer/code,
index submission, obligation date, regime, correction target and 167 named
positions (35 joint-holder filings) with zero mismatch. The expanded run covered
all 170 documents / 318 positions / 77 joint filings, now also checking filer
identity, prior holding percentages and group percentages: zero field or group
aggregate discrepancies. Four fork documents were additionally checked against
the public correction HTML and EDINET date index. Another ten correction IDs
(five legacy, five current) were resolved through the live document/index APIs:
submission time, formal target and regime matched in all ten. The independent XML route is
not a full PDF/manual audit, and no positive real valuation evidence was
available to cross-check. Across the sample, 92 documents mention ordinary
shares in a 60-day transaction block, but that does not prove current holdings.
Only three documents have a nonempty present-holding note mentioning ordinary
shares; those notes also describe preferred shares, warrants, ADRs or shared
investment authority, so none is eligible for ordinary-share close valuation.

Outstanding gates: real source-evidenced ordinary-share quantities (target 20
positions, currently zero); institution classification evidence/coverage; real
valuation-times-PIT-close checks. A `DescriptionOfBusiness` source field exists
for some institutional candidates, so institutional count zero is a deliberate
classifier-coverage limitation rather than a lack of such filers. No category
is inferred from the name alone. Correction chain, 2026 regime, issuer/filer
separation, and joint-holder aggregate integrity are now PASS; valuation and
the full Phase 16A-2 gate remain **NO-GO**.
Phase 16B remains **NO-GO**. No ranking/API/UI, production ML gate change,
Gmail action, commit, push, or web deployment follows from this audit.
The 170-document independent audit ran in 1.12 seconds with 227 MB maximum RSS
on this workstation. This correction-follow-up added no further DB schema;
the existing Phase 16A-2 raw-source and derived columns remain research-only.
The unchanged public server passed 150/150 production smoke checks, but that
smoke does not exercise these undeployed research modules.
