# Phase 16D-2 source forensics (2026-09-22)

**Phase 16D-2: NO. Production rollout: NO-GO. Phase 16E: NO-GO.**
This is a shadow-only investigation. Production DB writes, deploys, scheduler
enables, commits, and pushes: **0**. The production build remains
`-l8ohPKe8JxMJ2WV2lN9x`. INFRA-S2 remains `BLOCKED_BY_NO_DESTINATION`.

## Official source evidence and holder-count gate

Official EDINET type-1 ZIP archives for the six audited documents, plus the
XBRL fact/context inventory and archive/XBRL SHA-256s, are retained under
`/Volumes/OWC Express 1M2 80G/stock-dashboard/qa/phase16d-shadow/phase16d2-official-evidence/`.
`official-sources.json` records every holder-axis fact, its context and unit.
The cover concept in both mismatches is
`jplvh_cor:TotalNumberOfFilersAndJointHoldersCoverPage`, context
`FilingDateInstant`, unit `xbrli:pure`.

| Document | Cover | Named holder-axis members | Source finding |
| --- | ---: | ---: | --- |
| S100Z34W | 2 | 3 | Nomura Securities 12,205; Nomura International PLC 772,571; Nomura Asset Management 12,449,100 shares. All have distinct names/addresses and positive positions. |
| S100Z3AM | 6 | 7 | Seven distinct JPMorgan entities have names/addresses and holder facts. Member 5, JPMorgan Securities Japan, reports 0 current shares and a 0.14% previous holding. |

The XBRL dimensions are explicit `FilerLargeVolumeHolder{n}Member` members,
not an identified aggregate/total member. A zero current position alone does
not prove a non-legal or technical member: the accepted S100YQZ0 has five cover
holders, including a named zero-share holder. The official reporting guidance
describes individual filer/joint-holder sections separately from the group
summary (https://www.fsa.go.jp/common/shinsei/tairyohoyu/index.html).
No document-specific fact yet reconciles either count. Accordingly,
both filings remain **failed/fail-closed**; no `axis count - 1` or zero-share
exclusion was introduced. Existing 170 source filings and 318 source positions
were not reclassified; parser and certification contracts were not changed.

## 6459 correction re-adjudication

The four official raw XBRL files and EDINET index rows were compared. All
documents use filer E09744 and issuer E01961. The individually identified
holder is the same named person, 尾﨑 敦史, with 3,763,000 shares and 7.28%.

| Document | Submitted | Obligation | Serial / submission | Holder member | Address | Correction target |
| --- | --- | --- | --- | --- | --- | --- |
| S100YI0J | 2026-09-14 16:14 | 2021-12-10 | 16 / 16 | 5 | 大分県佐伯市長島町 | none |
| S100YQZ0 | 2026-09-14 16:16 | 2022-03-30 | 17 / 17 | 4 | 大分県佐伯市長島町 | none |
| S100YX61 | 2026-09-14 16:17 | 2026-05-01 | 18 / 18 | 4 | 大阪市天王寺清水谷町; former address supplied | none |
| S100Z2FD | 2026-09-18 16:41 | 2022-03-30 | 17 / 2 | 4 | 大分県佐伯市長島町 | S100YQZ0 |

The old and corrected serial-17 XBRL holder facts have the same five names,
addresses, positions and holding ratios. The changed holder-field value in
all five members is the contact organization, from 大和冷機工業株式会社 to だいわ株式会社;
the correction flags and explicit target also change. There is no changed
succession identity/position wording in the holder facts. This is a
**correction-only contact organization change**, not a new holder. The corrected
XBRL SHA-256 is pinned to
`13ffec57609b4cd4c437847df31769490be2ee9fb564e91958cdfcbfec4db831`
in the narrow adjudication. Unknown/new hashes still fail closed. A new unit
fixture tests S100Z2FD and the changed-hash rejection. Raw old/corrected
filings and raw holder entity IDs remain untouched. Full current-ranking
double-count and fake-activity checks on a *new certified snapshot* are still
**not run**, because the two holder-count blockers prevent safe publication.

## Malformed shadow file and repeatability

The original `run-20260922-2/shadow.db` is retained, unrepaired and unvacuumed.
Its SQLite header has 4,096-byte pages and declares 14,039 pages
(57,503,744 bytes), while its file length is 53,002,240 bytes (12,940 pages):
1,099 pages / 4,501,504 bytes short. The file was born 09:55:01 JST,
last modified 09:56:51 JST. Its zero-byte WAL was created 09:56:59;
the SHM remains retained. Operations events show ingestion start 09:55:20
and daily failure 09:56:51 with the two parser errors. The original seed
did not yet have a post-close integrity check; that check now exists. The
original seed was PID 91915 and the daily parent PID 91941; child PIDs were
not logged. The command log confirms the parent launched the ingestion child
while retaining its local libSQL connection for lock heartbeats. Do not label
this an SSD defect. The good `run-20260922-3` has the same 14,039-page header
and the full 57,503,744-byte length.

The first three source-read-only seed -> direct-ingest repetitions
(`run-20260922-{6,7,8}`) passed, but **did not** reproduce the original
parent/child execution path. The exact daily-CLI path in runs 9, 10 and 12
reproduced the same 1,099-page truncation. In run 10 the file was complete at
child close and after lock release, then truncated on parent exit. An abnormal
parent exit in run 11 left it intact. A standalone child with the same `tsx`
launcher (run 13) also left it intact. With parent heartbeats disabled but
its old connection retained (run 14), lock release raised `SQLITE_CORRUPT`
even though the file still had its complete length. These controls localize
the failure to the parent local-libSQL connection surviving a large
child-process SQLite write, not to `tsx` or the two parser errors.

The daily CLI now closes its local client before each external writer starts,
and does not reopen it for DB heartbeats during the bounded child run. The
3-hour lock lease exceeds the 2-hour maximum child timeout; 30-second storage
preflight remains active. Existing call-site heartbeats after completed child
stages and lock release use a fresh client. Three **exact daily-CLI**
repetitions with this change
(`run-20260922-{15,16,17}`) passed post-close seed integrity and post-ingest
`PRAGMA integrity_check=ok`, with matching 14,039-page headers and
57,503,744-byte lengths after process exit. Each still deliberately reports
the same two source/cover errors; final shadow rows are 234 ready + 2 failed.
An attempted additional pre-child heartbeat (run 18) caused a stale-connection
`SQLITE_CORRUPT` error at release and was **not retained** in the final code;
its shadow file was preserved. This makes the parent connection lifetime an
operational safety issue to keep under targeted regression before deployment.
This is a shadow-verified connection-lifetime correction, not a
production-deployed fix. All malformed runs remain preserved. Available macOS
log query for the original interval returned no NVMe/APFS/I/O event; the
production health endpoint remained HTTP 200 with storage available and
about 5-22 ms in spot checks. Historical log absence does not prove no
storage fault. The exact libSQL internal checkpoint/finalizer mechanism is
not proven; only the process-level cause and corrected execution boundary
were established. The retained shadow QA directory currently occupies about
985 MB and is not a backup.

## Gate disposition

| Gate | Result |
| --- | --- |
| S100Z34W reconciliation | FAIL |
| S100Z3AM reconciliation | FAIL |
| 6459 source adjudication + narrow unit regression | PASS |
| Shadow physical reliability (three new exact-path runs) | PASS in shadow; parent/child connection lifetime caused deterministic corruption in uncorrected path |
| Real 61-doc ingest | FAIL: 2 explicit failed filings |
| Real snapshot, atomic publish, idempotency, price-only, override, real-document backfill/resume | NOT RUN: prerequisites failed |
| New ranking mismatch/joint count | NOT RUN: no certified new snapshot |
| Production DB writes / scheduler / deploy | 0 / DISABLED / NO |

Trusted baseline counts before and after this work: 170 filings, 318 positions,
170 source documents; baseline snapshot
`c87f5e4ea278a47d41a652e6d52674ccdee73515fb008fe40fc30cd8c16cb86a`
has 223 current positions, 164 investors, 178 valuation-ready positions, and
19 activities (10 NEW, 5 INCREASE, 4 DECREASE). The partial shadow ingestion
has 234 ready and 2 failed filings, 234 source documents, 457 raw positions
and 211 investor entities; these figures are *not* a validated before/after
ranking. New valuation-ready, activity, snapshot ID, mismatch count, atomic
failpoints, price-only refresh, classification override, and real-document
backfill/resume are **not measured**. EDINET request totals, SQL query totals,
peak RSS, and detailed per-stage runtime were not instrumented in this stop-
gate investigation and must not be inferred. Production health was HTTP 200
and storage available; no production scheduler/deploy or Gmail delivery ran.
P0=0; P1=2 unresolved source-count blockers. No new P2 claim is made for the
shadow path after its isolated fix; it still requires production canary review
once all Phase 16D-2 gates pass.

The previous source counts and immutable baseline snapshot remain the only
trusted production ranking baseline. Do not resume Phase 16D rollout or Phase
16E until both count mismatches have source-backed dispositions and the
remaining real-data gate is executed. The shadow repetitions are QA
fixtures, **not** an independent production backup.
