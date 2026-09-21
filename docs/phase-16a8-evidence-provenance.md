# Phase 16A-8: Evidence Provenance & Investor Classification Closure

Research-only **Phase 16B Data Gate: GO** for the 2026-09-18 current valuation snapshot. This is not a production release authorization. No ranking API/UI, DB migration/write, deploy, commit, or push was performed. The Phase 16A-7 regulatory certification function and its 179-position result are unchanged. Historical PIT remains separately NO-GO.

## Evidence contract

- Original public EDINET ZIP bytes, full-date J-Quants JSON response bytes, and FSA/JPX HTML/PDF bytes are stored by SHA-256 in a create-only local archive outside Git and the production DB. Repeated runs verify existing bytes instead of overwriting them. The archive is **not** an independent backup; INFRA-S2 remains blocked by lack of a destination.
- Every positive position records `Position -> Decision SHA -> Fact SHA -> Raw Source SHA`. EDINET XBRL is extracted from the archived ZIP and compared byte-for-byte with the stored source XML. The issuer, holder, direct-security components, market master row, and raw unadjusted close are independently compared with the earlier derived facts. Raw-source SHA never substitutes for the derived-fact SHA.
- The FSA scope page is pinned with the non-voting-share exclusion and investment-security text anchors. The JPX REIT page is pinned with both code/ISIN pairs. The two JPX class-specific PDFs and the FSA exception PDF are also preserved as raw bytes; their interpretation remains limited to the existing 16A-7 negative-control rules. No general exclusion is inferred from an unknown class.
- The manifest is itself content-addressed. `scripts/verify-large-holder-evidence-manifest.ts` verifies its filename SHA, all 121 raw files, 179 valuation chains, 224 classification chains, and unique position keys without DB or network access. Personal addresses are not copied into the manifest; only their SHA is retained.

## Real-data audit

Run date: 2026-09-21 JST. Valuation and latest market date: **2026-09-18**. Read-only live SQLite connection with `PRAGMA query_only=ON`; DB writes **0**.

| Check | Result |
| --- | ---: |
| Research / latest direct positions | 233 / 179 |
| Superseded positions | 54 |
| Ordinary / REIT positive decisions | 174 / 5 |
| Archived EDINET ZIPs / J-Quants pages / FSA-JPX references | 114 / 2 / 5 |
| Positive independent valuations | 179 |
| Raw XML, price, quantity, or amount mismatches | 0 |
| Complete / partial / no eligible portfolio | 131 / 7 / 27 |
| Unresolved corrections / transition conflicts | 0 / 0 |
| Joint-holder entity+ticker duplicate latest positions | 0 |
| Verified positive position lineages | 179 |
| Verified current classification lineages | 224 positions / 165 entities |
| Archive verification | PASS |

Across **all 165 current entities**, filing-field-only reclassification found **56 individual, 25 institutional, 7 operating company, 77 unclassified**. The pre-existing DB counts were **56 individual / 16 institutional / 93 unclassified**; 9 institutional and 7 operating-company cases gained explicit filing-business evidence, with **0 contradictions** against existing classified labels. Among the **138 entities represented by the 179 positive valuation positions**, the comparable subset is 47 / 19 / 5 / 67. Names alone never cause classification. Investment/asset-holding language does not trigger operating-company classification. Unclassified remains unclassified. These recalculated categories are preserved in the research manifest, not written to the production investor table.

`PUBLIC_CURRENT_VALUATION_READY`: **179** for the audited snapshot. No inferred amount is served publicly. This is a current-only certification, never a historical backtest/PIT approval.

## Gate

| Requirement | Status |
| --- | --- |
| Official raw evidence and separate hashes | PASS |
| Position-to-raw lineage | PASS |
| Public current valuation evidence (179, mismatch 0) | PASS |
| Individual / institutional / operating-company evidence | PASS for all 165 current entities |
| Unclassified safety | PASS |
| Correction semantics | PASS; unresolved 0 and regression tests pass |
| Joint-holder double count | PASS; 0 |
| P0 / P1 in this data gate | 0 / 0 |

**Data Gate: GO.** This permits a separate Phase 16B design decision; it does not initiate Phase 16B implementation or production deploy. Production Build ID remains `j4ACR23c-A7p7JMmtOaQh`. INFRA-S2 remains `BLOCKED_BY_NO_DESTINATION`; destructive production DB work stays prohibited.

## Reproduction

Audit (fresh sources, rate-limited): `STOCKBOARD_DB_PATH=<existing DB> ./node_modules/.bin/tsx --env-file=.env.local scripts/audit-large-holder-regulatory-current.ts --as-of=2026-09-18 --phase-16a8`.

After the first capture, pass `--reuse-edinet-manifest=<earlier manifest>` to verify stored EDINET/FSA/JPX raw files without redownloading them. The manifest produced in this run is content-addressed as `97d5544b066a2938c974f8a8c42da0a8960e329582c617b6157f40111c73581f.json` under `LARGE_HOLDER_EVIDENCE_DIR/manifests/`.

Independent manifest verification: `./node_modules/.bin/tsx scripts/verify-large-holder-evidence-manifest.ts <manifest.json>` returned `rawSources=121`, `positions=179`, `classificationPositions=224`, `verified=true`. Initial positive-position capture took ~163 s; the all-current-entity extension took ~69 s with cached positive documents and rate-limited additional EDINET reads. The source archive occupies ~9.8 MB. Production APIs and Gmail delivery were not invoked.

Remaining limitations: the archive is local, not a separate disaster-recovery backup; current-only classification is recomputed in the audit and not written to the production investor table; a future public interface must consume the certified provenance rather than treating legacy DB labels or curated JSON hashes as sufficient. These are not Phase 16A-8 data-gate blockers, but they remain release/integration constraints.
