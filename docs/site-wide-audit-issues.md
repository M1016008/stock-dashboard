# SITE-AUDIT-1 Issue Ledger

## Final state

- SITE-AUDIT-1: **CLOSED**
- SITE-AUDIT remediation: **COMPLETE**
- Finalized: 2026-09-28 JST
- Open P0 / P1 / P2 / P3: **0 / 0 / 0 / 0**

| Issue | Severity | Final status | Resolution checkpoint |
| --- | --- | --- | --- |
| AUDIT-P1-001 | P1 | RESOLVED | `fe06c865b8feb6ad6f5c697b871137ce3197c4d0` |
| AUDIT-P1-002 | P1 | RESOLVED | `7ca45241bcc91123a2a46ce1fcca4ec41e87ba20` |
| AUDIT-P1-003 | P1 | RESOLVED | `c56d91691016b3787ef50bc1ebf199bf3c1976c1` |
| AUDIT-P2-001 | P2 | RESOLVED | `0dda7a6126802029949dd00e19a16fb992c63f2f`; final operational recovery |
| AUDIT-P2-002 | P2 | RESOLVED | `f17cc93f38b27d03081e6449ddf90515a6a7cc4b` |
| AUDIT-P2-003 | P2 | RESOLVED | `b48ff320b795f308391ef914a71ded7324b54f05` |
| AUDIT-P2-004 | P2 | RESOLVED | `4647c5446a55f24e661abe9c20bea4f51269a374` |
| AUDIT-P3-001 | P3 | RESOLVED | `c8cea45b8eccc4e993b9f611cd90efa5a0277325` |

The sections below retain the original incidents and reopen history. They are historical evidence, not open issues.

## AUDIT-P1-001 - Optional artifact poisoned the global storage latch

- First observed: 2026-09-24 02:02:44 JST
- Incident: `1fb091b6-c1af-455f-8fe5-241da062ef25`
- Historical failure: a missing optional MA trajectory shadow DB was guarded as a required writable database. `DB_NOT_FOUND` created the shared `FAILED_SAFE` latch, returned HTTP 503 from unrelated database features, and stopped the Historical worker even though the external APFS volume remained mounted, UUID-matched, writable, and intact.
- Resolution: optional read artifacts now return feature-local unavailable responses. A missing optional artifact cannot poison the primary database latch. Confirmed mount, device, UUID, and I/O failures remain fail-closed.
- Verification: isolated missing-artifact regressions, Production health, Historical worker, and post-deploy observation passed. No data corruption was observed.

## AUDIT-P1-002 - Storage identity probe coordination and split runtime

- Original incident: `9f280c56-2a78-44f2-a7c4-fa6fd091eb3d`
- Recurrence: `fe0fb180-d811-4f0d-831d-20c343d63e69`
- Historical failure: transient `diskutil` subprocess failures, including SIGPIPE, exhausted confirmation and created `FAILED_SAFE` while the physical volume identity remained stable.
- The first hotfix serialized probes within the then-observed runtime but a later recurrence exposed split deployment: Web-family callers and scheduled operations were running different worktrees and storage-guard implementations.
- Resolution: volume-scoped cross-process coordination now uses a canonical volume key, atomic owner identity and lease, a versioned certified result, bounded confirmation, and fail-closed behavior. Deployment force-reinstalls and audits all 16 managed Production LaunchAgents from one worktree.
- Verification: isolated concurrency and persistent-failure fixtures, a 30-minute soak, formal recovery observations, Production smoke, and a 60-minute Production observation passed. Real mount/UUID/device/I/O failures remain fatal.

## AUDIT-P1-003 - Missing rebuildable cache poisoned the global latch

- Historical failure: a missing serving-cache database was classified like a required primary database and could create the shared latch.
- Resolution: serving caches use an explicit rebuildable-cache contract. Missing or locally invalid cache state is feature-local; writes may recreate a cache only after storage verification. Confirmed external-volume failures remain fail-closed.
- Verification: missing/corrupt cache, required-primary-DB, optional MA trajectory, analog index, and fatal I/O fixtures passed.

## AUDIT-P2-001 - JP/US derived freshness

### Initial defect and resolution

- Initial status: US price, analytics, PMS, features, candidates, predictions, and similars advanced on different dates; JP derived serving also lagged its expected market date.
- Initial resolution: updater state classification, eligibility-denominator handling, dependency ordering, and status health regressions were corrected in `0dda7a6126802029949dd00e19a16fb992c63f2f`.
- Result: JP and US expected dates, source prices, and daily derived datasets aligned without changing freshness thresholds or treating stale data as fresh.

### Closeout recurrence and final recovery

- History: **RESOLVED -> REOPENED -> RESOLVED AGAIN**.
- Recurrence root cause: **PROCESS_ENVIRONMENT / AUTHENTICATION**. The integrated worktree did not inherit the machine-local Tiingo credential. The LaunchAgent correctly ran the integrated source but its `tsx --env-file=.env.local` environment could not authenticate.
- Problem run: ID `871`; target 12,375; succeeded/no-op 411; failed 11,964; inserted rows 0. Every fetch-required failure had the normalized signature `TIINGO_API_KEY is not set` before HTTP dispatch. No provider outage, rate limit, network, parse, database, or storage failure was present.
- Recovery run: ID `873`; target 12,375; succeeded 12,373; failed 0; unavailable 2 (`STRV`, `SLAI`); inserted rows 12,274.
- Coverage: 11,953 / 12,375 = **96.59%**. The existing threshold remained **95%**.
- Final dates: expected, price, analytics, PMS, features, candidates, physics candidates, predictions, similars, and dashboard cache all equal `2026-09-25`.
- Observation: 31/31 read-only samples over 30 minutes passed. New partial runs, updater restarts, `FAILED_SAFE`, unresolved `PROBE_UNCERTAIN`, and freshness drift were all zero.
- Final regressions: data freshness, status health, US automation foundation, and Production smoke 161/161 passed.

### Credential deployment prerequisite

Every deploy or worktree switch must verify, without exposing secret material:

1. every credential required by an enabled Production process exists in its machine-local configuration;
2. the expected process can load the configuration, not merely that a file contains a key name;
3. local credential files have appropriate owner-only permissions;
4. secret values, authorization headers, and fingerprints are never logged or added to Git.

This prerequisite was verified for the final runtime. No secret value or fingerprint is recorded here. It is an operating requirement, not an open issue.

## AUDIT-P2-002 - Cold read performance

- Historical profile: Trigger cold reads were database-query dominated; US Hex combined database time with an approximately 11.87 MB response; Home had a multi-request cold waterfall.
- Resolution: `f17cc93f38b27d03081e6449ddf90515a6a7cc4b` removed duplicate cold work, narrowed US Hex payload/data access, and improved Home cold loading without changing Trigger semantics, PIT, Stage, or Biweekly anchors.
- Production regression passed. Trigger cold read around 4.7-5.1 seconds remains a known performance characteristic, not an open audit issue.

## AUDIT-P2-003 - Large Holder missing from Production smoke

- Historical gap: four Large Holder pages and seven GET APIs existed but were absent from the 150-check smoke suite.
- Resolution: `b48ff320b795f308391ef914a71ded7324b54f05` added all four pages and seven APIs, dynamic read-only fixtures, certified-snapshot metadata checks, and stale-snapshot fail-closed regression.
- Final smoke: **161/161 PASS**, including Large Holder pages 4/4 and APIs 7/7. The checks perform zero Production database writes.

## AUDIT-P2-004 - Responsive document overflow

- Historical failure: `/admin/db` overflowed at 390px; `/custom-charts` overflowed at 390px and 768px.
- Resolution: `4647c5446a55f24e661abe9c20bea4f51269a374` applied `min-width: 0`, responsive grid/flex sizing, intentional table-local scrolling, and responsive chart sizing. It did not hide overflow at document level or remove information.
- Verification: both routes passed 390 / 768 / 1024 / 1280 / 1440 / 1920 with zero document overflow, console errors, uncaught exceptions, or unexpected HTTP failures.

## AUDIT-P3-001 - Chart Drill invalid problem ID returned HTTP 500

- Historical failure: malformed, missing, or nonexistent problem IDs escaped as server failures.
- Resolution: `c8cea45b8eccc4e993b9f611cd90efa5a0277325` introduced stable request-error classification. Malformed/missing input returns 400, unknown IDs return 404, and unexpected internal exceptions remain 500.
- Verification: valid chart/data behavior and interaction were unchanged; valid, malformed, missing, nonexistent, and internal-error fixtures passed.

## Historical non-issues

- A nonexistent integrated-screener saved-reason request followed its documented invalid-request branch; the older fixture was stale.
- Long-lived headless Chrome processes were observed during the audit, but ownership and product impact were not established.
- Known Large Holder quarantines, explicitly unvalued positions without an official close, disabled Large Holder scheduling, and US weekly RL policy outside the daily freshness contract are intentional states, not open SITE-AUDIT issues.

## Closeout

- Open issues: **0**
- P0 / P1 / P2 / P3: **0 / 0 / 0 / 0**
- Historical incidents remain documented above.
- Future regressions are tracked as ordinary issues; SITE-AUDIT-1 is not reopened.
