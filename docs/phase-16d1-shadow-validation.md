# Phase 16D-1 shadow validation (2026-09-22)

Status: **NO-GO**. This is an operational test fixture, not an independent backup. The
production DB was opened only with SQLite `readOnly: true` and `PRAGMA query_only=ON`.
No production scheduler, deploy, commit, push, schema change, or production DB write
was performed. INFRA-S2 remains BLOCKED_BY_NO_DESTINATION.

## Seed and boundaries

- Production source: `/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`.
- Isolated runs: `/Volumes/OWC Express 1M2 80G/stock-dashboard/qa/phase16d-shadow/run-20260922-{1..5}/`.
- `seed-large-holder-shadow.ts` copies relevant table schemas, complete large-holder,
  investor, historical universe, price proof and batch metadata, all latest-date
  OHLCV and history for holder tickers. Source row counts and SHA-256 hashes match
  the destination; the latest OHLCV set is equal. The seed performs a post-close
  read-only integrity check. The shadow DB is approximately 51 MB at seed time.
- Source counts: filings 170, positions 318, source documents 170,
  investor entities 165, historical universe 4,535; latest price date 2026-09-18,
  latest-date OHLCV 4,201. Immutable baseline ranking snapshot:
  `c87f5e4ea278a47d41a652e6d52674ccdee73515fb008fe40fc30cd8c16cb86a`;
  223 current positions, 164 investors, 178 valuation-ready, 19 activities
  (10 NEW_5PCT, 5 INCREASE, 4 DECREASE). The independent ranking regression
  checked 137 investors with zero mismatches, joint duplicates and fake amendment
  activity. No fresh certification has passed.
- In shadow-QA mode, the operations CLI refuses a DB or artifact path outside
  the dedicated run directory. Child processes receive the same DB path, local-DB
  and no-schema-ensure settings. Storage mount/UUID/free-space preflight remains
  active; incident paths are shadow-local. Failpoints cannot run outside shadow QA.

## Actual EDINET attempt

The 2026-09-18 dry-run found 61 missing documents in one index request. The
existing daily CLI was then executed only against shadow. The initial run used
an incomplete seed and failed because `historical_universe` was omitted; that
table is now included. A second seed ingested most documents but did not pass
the ingestion gate. The independent direct ingestion on a fresh, integrity-checked
shadow examined 61, skipped 1 already imported, processed 60, failed 2, and
resolved 11 correction ancestors. There are now 236 filing rows (234 ready,
2 failed), 234 source-document rows, 457 position rows, and 211 investor entities
in that shadow. These
are unvalidated intermediate counts, **not** a publishable ranking.

The fail-closed parsing errors are:

- `S100Z34W`: cover declares 2 holders; XBRL holder axis identifies 3.
- `S100Z3AM`: cover declares 6 holders; XBRL holder axis identifies 7.

Neither mismatch was silently accepted. A new real correction, `S100Z2FD`,
explicitly corrects `S100YQZ0` for ticker 6459, same serial 17 and succession
member. Its new raw XBRL SHA-256 is
`13ffec57609b4cd4c437847df31769490be2ee9fb564e91958cdfcbfec4db831`.
The existing exact-source adjudication rejects the new document with
`reviewed_holder_succession_evidence_changed:S100Z2FD`. Consequently even
snapshot status cannot compute a trusted current-position fingerprint. Do not
weaken that adjudication without a source-backed correction review and regression.

One failed shadow file (`run-20260922-2/shadow.db`) is malformed, with a DB
header page count greater than its actual file length. Another independently
seeded and ingested shadow (`run-20260922-3`) passes `integrity_check=ok` after
ingestion. No NVMe/APFS I/O error was observed in the available local log query;
the cause of the failed file is **unresolved**. The seed now verifies integrity
after closing and reopening the DB. Preserve the failed file for diagnosis.

## Bounded operations checks, not real-data E2E

On a clean shadow with unchanged official source:

- Existing certified snapshot adoption: `PUBLISHED` (295 ms); repeated refresh:
  `UNCHANGED` (168 ms), same snapshot ID.
- 2026-09-12..13 (two one-day chunks, zero EDINET documents): a controlled
  interruption after the first `PUBLISHED` checkpoint, a fresh-process resume
  skipping that chunk, then completion and a second resume skipping both.
- The daily CLI, used as a one-shot shadow scheduler entrypoint on 2026-09-12:
  no new documents; snapshot `UNCHANGED` (2.52 s total).
- A second process was rejected with `large_holder_update_lock_busy` while the
  shadow `large_holder_daily` lock was owned by the first process.
- Existing fixture regression passes review, merge preview, price-completion
  gates and atomic pointer semantics. Mock storage guard regressions pass.

These checks do **not** demonstrate snapshot regeneration after real ingestion,
atomic failure after a new real snapshot, price-only refresh, a real correction
activity comparison, classification override publication, source-bearing
backfill or production-like scheduler timing. The 2026-09-16..17 backfill
dry-run itself finds many missing or parser-version-changed documents; no full
historical run was launched. None of these incomplete cases may be marked PASS.

## Safety, build and disposition

- Production `/api/health`: HTTP 200, `overall=healthy`, `storageStatus=available`
  throughout spot checks (approximately 4-8 ms). Post-test read-only source
  counts remain filings 170, positions 318, documents 170.
- Storage guard simulation: PASS (transient confirmation, fatal no retry, wrong
  UUID, unavailable volume). No observed shadow incident or production
  FAILED_SAFE. Gmail delivery was never invoked.
- `next typegen`, `tsc --noEmit`, `npx next build --webpack`, daily-plan,
  large-holder-operations, ranking cross-check and storage guard tests: PASS.
  The worktree's `node_modules` symlink points to the release checkout; `npm
  run build` defaults to Turbopack. `--webpack` is the repository's existing
  isolated production-equivalent build method, not proof that the symlinked
  standard Turbopack command succeeds.
- Measured shadow storage for the five retained diagnostic runs: 264 MB total.
  Daily real-ingest took approximately 80-90 s; precise EDINET request totals,
  SQL query counts and peak RSS were not instrumented and must not be inferred.
- Phase 16D data/operations gate: **NO-GO**. Production rollout: **NO-GO**.
  Blockers: two real source/parser mismatches, new 6459 correction evidence,
  unexplained malformed shadow DB, missing source-bearing E2E checks, and no
  independent production backup. Production Build ID remains
  `-l8ohPKe8JxMJ2WV2lN9x`; no deploy or Git operation was performed.
