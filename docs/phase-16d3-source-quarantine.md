# Phase 16D-3: Source Quarantine Audit

## Gate

Phase 16D-3 Complete: **NO**. Production Canary Gate: **NO-GO**.

The two reviewed 2026-09-18 documents are quarantined without guessed holder reconciliation. The other 59 same-day documents are ready and an isolated snapshot was published as `VALIDATED_WITH_QUARANTINE`. A real three-chunk backfill stopped at the first chunk on a *new*, unreviewed holder-count inconsistency (`S100Z2WE`, submitted 2026-09-17). It remains `REVIEW_REQUIRED_SOURCE_INCONSISTENCY`; it was not added to the reviewed quarantine list. Atomic failpoint, price-only refresh, classification override, and completed backfill resume were not demonstrated on the real shadow. Do not enable the production scheduler or deploy.

## Reviewed Official Source Evidence

| Document | Issuer | Submitted | Cover holders | Parsed legal holders | Raw axis members | Raw XBRL SHA-256 | Official ZIP SHA-256 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `S100Z34W` | 7956 Pigeon | 2026-09-18 14:26 | 2 | 3 | 3 | `b76ebaabaf1d65fbab54ce9952b3caf3436b85f813749d1bea0be15b6b5ab872` | `7cc753c70c12df8d7ae8218a5c8daa85c921d937ee0ffbc7d16130f39a39f711` |
| `S100Z3AM` | 8136 Sanrio | 2026-09-18 15:35 | 6 | 7 | 7 | `c3e063cfeb2f8fdbe188e32910d35981093eaf3ba25de27f36adb838d5c64ad3` | `be0ce6e05b5004fd7ebe1a3d3c3a55326c169dd2bab23a0351d9548e5a33bafc` |

The original EDINET ZIP files are in `/Volumes/OWC Express 1M2 80G/stock-dashboard/qa/phase16d-shadow/phase16d2-official-evidence/`. Their official document endpoints are `https://api.edinet-fsa.go.jp/api/v2/documents/S100Z34W?type=1` and `https://api.edinet-fsa.go.jp/api/v2/documents/S100Z3AM?type=1`. The shadow DB retains the complete XBRL XML and the separate review record in `large_holder_filings.raw_parsed_payload_json`. The document ID **and** exact raw XBRL SHA are required for reviewed quarantine. A different SHA or document ID fails closed. No axis-count-minus-one, zero-share exclusion, or member dropping is used.

`S100Z34W` has three distinct named/addressed positive holders. `S100Z3AM` has seven distinct named/addressed holders; one has zero current shares with previous holding. Both have internally conflicting official facts. The review record preserves the full member list, source SHA, parser version, reason, counts, and review status. These facts are suitable for an EDINET inquiry; no authoritative reconciliation was inferred.

## Shadow Result

Fresh shadow: `/Volumes/OWC Express 1M2 80G/stock-dashboard/qa/phase16d-shadow/run-20260922-d3-1/`. Production source was read-only. Baseline table hashes matched the seed report: 170 filings, 318 positions, 170 source documents. Baseline immutable snapshot `c87f5e4ea278a47d41a652e6d52674ccdee73515fb008fe40fc30cd8c16cb86a`: 223 current positions, 164 investors, 178 public valuation-ready positions, 19 activities.

The 2026-09-18 Daily run examined 61 target documents: 59 ready, 2 quarantined, 0 parser failures. Supporting correction ancestors are fetched separately; the resulting snapshot source watermark is 236 filings, not 231. The isolated immutable snapshot `833c85cb0e46e5e35804e3a471d3d468bc46b974ddebb7d9326ee7fed393a28f` has 313 current positions, 210 investors, 183 public valuation-ready positions and 21 activities. Portfolio completeness is COMPLETE 133, PARTIAL 9, NONE 68. Activities are NEW 11, INCREASE 6, DECREASE 4, EXIT 0. Its pointer status is `VALIDATED_WITH_QUARANTINE`, with 2 documents, 10 affected raw holder members, 2 issuers and 0 safely identifiable prior investor entities. Both affected issuers have **zero** snapshot positions, activities or filing rows; their stock detail is blocked from presenting an old value as current. Other investors' status would become PARTIAL/NONE when a prior certified affected position exists.

Independent shadow-DB price x quantity checks for 15 individual and 15 institutional COMPLETE investors: **30/30 equal, 0 mismatch**. For ticker 6459, the current entity/ticker position population has no duplicate, source-backed correction mapping is retained, and correction-created fake activity is 0. Same-day re-run: 0 missing documents, same snapshot ID, `UNCHANGED`, no duplicate activity. Shadow `PRAGMA integrity_check`: `ok`. The snapshot generation took 693,197 ms; initial 61-document ingestion took about 132 seconds. The DB grew from 52,920,320 to 58,081,280 bytes before the later backfill attempt. Exact SQL query count, all EDINET document-request count, and peak RSS were not instrumented, so they are **not claimed**.

## Backfill Stop

Requested real-document range: 2026-09-17 through 2026-09-19 in three one-day chunks. The first chunk fetched real 2026-09-17 documents and stopped before publication at `S100Z2WE` (4502 Takeda): cover 13, parsed 14, raw axis 14, XBRL SHA `8bb22620485e05aa26c094779d70054bfc76ad2e96e964d09658bd34fe0ab760`. Status is `review_required_source_inconsistency`, review `PENDING`. The first-chunk checkpoint is `FETCHED`, then `FAILED`; no chunk was marked `PUBLISHED`. This is the required fail-closed behavior for an unknown mismatch, but it prevents a PASS for real backfill resume. Its source facts require separate review; the two approved quarantines do not apply.

The post-failure shadow operations status is `STALE` with `CURRENT_POSITION_CHANGED`, `EDINET_SOURCE_CHANGED`, and `UNRESOLVED_SOURCE`; unresolved source count is 1. `PRAGMA integrity_check` remains `ok`. Production `/api/health` remained HTTP 200, `overall=healthy`, `storageStatus=available` (final probe about 4 ms). No shadow storage incident record was created.

The failed backfill added earlier-day source records to this disposable shadow only. The already published 2026-09-18 snapshot remains an immutable QA artifact, but should not be treated as a current snapshot of the *subsequently modified* shadow DB. No production DB write, migration, deployment, scheduler enablement, commit or push occurred.

## Remaining Gate Work

Review `S100Z2WE` against its official source and establish whether it is a source inconsistency or parser defect. Do not broaden the two-document allowlist by analogy. Then seed a **new** shadow from the read-only production baseline and rerun the full 61-document Daily, real three-chunk interrupted/resumed backfill, real-data atomic failpoints, price-only refresh, classification override, and resource/query metrics. Preserve the external-writer parent-connection close fix. Until every gate passes, Phase 16D production canary remains **NO-GO**. INFRA-S2 remains blocked by the absence of an independent backup destination.
