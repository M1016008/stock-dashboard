# SITE-AUDIT-1: CLOSED

# SITE-AUDIT Remediation: COMPLETE

## Final certification

| Area | Final result |
| --- | --- |
| Routes | **40 / 40 PASS** |
| API endpoints | **159 / 159 PASS** |
| Feature units | **1,188 / 1,188 PASS** |
| Production smoke | **161 / 161 PASS** |
| P0 / P1 / P2 / P3 | **0 / 0 / 0 / 0** |
| Production | **HEALTHY** |
| Storage | **HEALTHY** |
| JP freshness | **PASS** |
| US freshness | **PASS** |
| Phase16D | **COMPLETE** |
| Large Holder | **CURRENT / VALIDATED_WITH_QUARANTINE** |
| Large Holder scheduler | **OFF** |

SITE-AUDIT-1 and its remediation program are formally complete. Existing route, API, feature, responsive, data, performance, storage, and Production evidence was reused; the closeout did not invent a new inventory or silently promote unsupported evidence.

## Final integrated baseline

| Item | Final value |
| --- | --- |
| Branch | `codex/site-audit-closeout` |
| Final source HEAD | `a69f9d581047d2a1519311afd8a81624ced356e6` |
| Production Build ID | `N7XZCGEspFRzNuA9zpN0f` |
| Production build directory | `.next-live` |
| Managed LaunchAgents | 16 / 16 loaded from the integrated worktree and source HEAD |
| Split deployment | 0 |
| Health | `/api/health`: healthy; storage available |
| JP expected / price / derived | `2026-09-25 / 2026-09-25 / 2026-09-25` |
| US expected / price / analytics / derived | `2026-09-25 / 2026-09-25 / 2026-09-25 / 2026-09-25` |
| Running jobs at final preflight | 0 |
| Active `FAILED_SAFE` | 0 |
| Unresolved `PROBE_UNCERTAIN` | 0 |

The runtime audit independently matched configured and actual working directories, source HEAD, build identity, and required storage identity environment for all 16 managed LaunchAgents. Disabled legacy weekly labels are not part of the managed runtime; the unified weekly optimizer is the enabled schedule.

## Audit inventory and evidence depth

The audit reused the machine-readable inventory produced from the Next app tree, TypeScript AST and local import graph, API methods, package scripts, LaunchAgent sources, and Production schema.

| Inventory | Count | Final status | Depth |
| --- | ---: | --- | --- |
| UI routes | 40 | 40 PASS | EXHAUSTIVE reachability; HIGH/SAMPLED interaction |
| API method endpoints | 159 | 159 PASS | EXHAUSTIVE method disposition; HIGH isolated mutation coverage |
| UI feature units | 1,188 | 1,188 PASS | HIGH domain coverage; SAMPLED long-tail controls |
| Unique API paths | 139 | PASS | HIGH |
| Production DB tables audited | 152 | PASS | HIGH schema/logical-integrity coverage |

The original four failed feature units were the responsive controls represented by `AUDIT-P2-004`. Their six-width regressions passed after the layout fix, so the final feature count is 1,188 PASS, 0 FAIL, 0 BLOCKED, 0 NOT TESTED. Destructive Production actions remained isolated or write-disabled; they were not inferred from route-level HTTP checks.

Git-external historical evidence remains under:

- `~/Library/Application Support/StockBoard/site-audit-1/site-audit-route-matrix.json`
- `~/Library/Application Support/StockBoard/site-audit-1/site-audit-api-matrix.json`
- `~/Library/Application Support/StockBoard/site-audit-1/site-audit-feature-matrix.json`
- `~/Library/Application Support/StockBoard/site-audit-1/site-audit-background-inventory.json`

## Remediation map

| Issue | Root cause | Resolution evidence |
| --- | --- | --- |
| AUDIT-P1-001 | Optional MA artifact used required/fatal storage semantics | `fe06c865b8feb6ad6f5c697b871137ce3197c4d0`; missing optional artifact remains feature-local |
| AUDIT-P1-002 | Transient storage probe failures plus split process versions | `7ca45241bcc91123a2a46ce1fcca4ec41e87ba20`; cross-process coordination and 16-agent runtime audit |
| AUDIT-P1-003 | Missing rebuildable cache could create global latch | `c56d91691016b3787ef50bc1ebf199bf3c1976c1`; rebuildable-cache isolation |
| AUDIT-P2-001 | Derived freshness and later worktree-local credential omission | `0dda7a6126802029949dd00e19a16fb992c63f2f`; operational recovery run 873 and 31/31 observation |
| AUDIT-P2-002 | Duplicate/oversized cold read work | `f17cc93f38b27d03081e6449ddf90515a6a7cc4b`; cold-read and payload optimization |
| AUDIT-P2-003 | Large Holder absent from smoke | `b48ff320b795f308391ef914a71ded7324b54f05`; 4 page + 7 API checks |
| AUDIT-P2-004 | Child width constraints escaped the document | `4647c5446a55f24e661abe9c20bea4f51269a374`; responsive internal containment |
| AUDIT-P3-001 | Request errors fell through as internal errors | `c8cea45b8eccc4e993b9f611cd90efa5a0277325`; stable 400/404 semantics |

Phase16D is present through `739dec65ba85aa29c5050e80b9e4a6e2f5ce6cfd`. Audit remediation and Phase16D/P2-003/P3-001 were consolidated by `a4d4108c1e21820f6424a59102fb00869c636526`; worktree-safe build and runtime identity fixes are present through `a4e9a65291b66da31d4e1af420cf4c9305a85d0f` and `a69f9d581047d2a1519311afd8a81624ced356e6`.

## P1 storage history

The history is retained rather than rewritten:

1. A missing optional MA trajectory artifact created a global latch while the physical volume was healthy.
2. Initial probe hardening recovered the incident, but later correlated `diskutil` failures caused a recurrence.
3. Investigation found a split runtime: Web-family and scheduled callers did not all run the same guard implementation.
4. Formal recovery preserved incident evidence. Cross-process certification, bounded uncertainty, and runtime version auditing were implemented without weakening fail-closed handling.
5. Isolated concurrency/stress, 21/21 recovery observations, Production smoke, and 31/31 and 61/61 observation windows passed. No APFS/NVMe detach or database corruption was found.

The final state has no active fatal latch or unresolved uncertainty marker. Storage is mounted, UUID/device identity matches, and Production health reports storage available.

## P2-001 freshness history and recurrence

The issue history is:

- Initial freshness defect: **RESOLVED**.
- Closeout recurrence: **REOPENED**.
- Recurrence root cause: **PROCESS_ENVIRONMENT / AUTHENTICATION**.
- Final recovery: **RESOLVED AGAIN**.

Problem run ID `871` targeted 12,375 tickers. It reported 411 no-op successes and 11,964 fetch-required failures because the integrated worktree lacked the machine-local Tiingo credential. The failure happened before HTTP dispatch; provider outage, rate limit, network, parse, database, and storage causes were excluded.

Recovery run ID `873` completed with 12,373 succeeded, 0 failed, 2 provider-unavailable symbols (`STRV`, `SLAI`), and 12,274 inserted rows. Latest-date coverage is 11,953 / 12,375 = **96.59%** against the unchanged **95%** threshold. Expected date, source price, analytics, PMS, features, candidates, physics candidates, predictions, similars, and dashboard cache all equal `2026-09-25`.

A 30-minute read-only observation collected **31/31 PASS** samples with zero freshness drift, new partial run, unexpected updater restart, active `FAILED_SAFE`, or unresolved `PROBE_UNCERTAIN`. Production smoke subsequently passed 161/161.

### Machine-local credential prerequisite

Every deploy and worktree switch must confirm that each enabled process can load its required machine-local credentials, that credential files retain owner-only permissions, and that no value, authorization header, or fingerprint is logged or committed. The final preflight verified process loading, not merely key-name presence. No secret material is included in this report.

## Production and data cross-check

- `/api/health`: `ok`, overall healthy, storage available.
- `/api/status/overview`: JP fresh true; US fresh true; expected/source/derived dates all `2026-09-25`.
- `/api/us/status`: latest OHLCV and snapshot date `2026-09-25`; latest Tiingo run success with failed 0.
- Production smoke: **161/161 PASS**, including Large Holder pages 4/4 and APIs 7/7.
- Large Holder snapshot: `VALIDATED_WITH_QUARANTINE`; certification and price date `2026-09-25`; current snapshot ID `47a1913d45adbd553fc53a3463164cfec0b452d890100b5d94db5b091c9d1d19`.
- Known quarantined documents: 3. Published contamination: 0 in the Phase16D certification evidence.
- Phase16D: complete; Production Canary Gate GO; scheduler OFF.

## Responsive and API closure

The original responsive audit covered all 40 routes at 390 / 768 / 1024 / 1280 / 1440 / 1920. `/admin/db` and `/custom-charts` were the only document-overflow failures. Their post-fix matrix passed all 12 route-width samples with document overflow 0, console errors 0, uncaught exceptions 0, and unexpected 4xx/5xx 0.

All 118 GET and 41 non-GET endpoint contracts have method-specific evidence. Mutating and destructive paths were exercised through isolated fixtures, shadow databases, or write-disabled branches. Chart Drill valid flow remained HTTP 200; malformed/missing requests now return 400, unknown IDs 404, and unexpected exceptions remain 500.

## Known non-issue characteristics

These conditions are explicitly not open SITE-AUDIT issues:

- Trigger cold read remains approximately 4.7-5.1 seconds.
- Large Holder scheduler is OFF by release policy.
- Three known Large Holder source documents remain quarantined.
- Positions without an official close remain `UNVALUED`; no stale or zero-price substitution is used.
- US weekly RL policy is outside the daily freshness contract.
- Machine-local credential preflight is required on every Git worktree switch or deploy.
- Long-tail UI controls use sampled evidence when exhaustive Production interaction would require destructive actions.

## Safety summary

| Safety property | Result |
| --- | --- |
| Observed Production data corruption | 0 |
| Destructive Production DB operations during audit/remediation | 0 |
| Unintended Gmail sends | 0 |
| Known unresolved P0/P1 | 0 |
| Active storage incident | 0 |
| Split managed runtime | 0 |

No freshness threshold was relaxed, no expected date was rewritten, no stale price was forward-filled, and no failed symbol was reclassified as success.

## Final decision

- SITE-AUDIT-1: **CLOSED**
- SITE-AUDIT remediation: **COMPLETE**
- Routes: **40 / 40 PASS**
- API endpoints: **159 / 159 PASS**
- Feature units: **1,188 / 1,188 PASS**
- Production smoke: **161 / 161 PASS**
- Open P0 / P1 / P2 / P3: **0 / 0 / 0 / 0**
- Production: **HEALTHY**
- Storage: **HEALTHY**
- Phase16D: **COMPLETE**
- Large Holder: **CURRENT / VALIDATED_WITH_QUARANTINE**
- Large Holder scheduler: **OFF**

SITE-AUDIT-1 is not reopened after this checkpoint. Any future regression is tracked through the normal issue process.
