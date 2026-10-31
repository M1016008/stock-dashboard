# Phase 2 PR J Claude Code independent review

Scope: bounded Historical Repair read hold and evidence receipts. Production was
not accessed or changed.

## Final result

- P0: 0
- P1: 0
- P2: 0
- Draft technical gate: PASS, subject to GitHub CI
- Strategy A Production: HOLD

## Revisions triggered by review

The first review found that the read-service-resume recovery could call the
normal final isolation probe after services had already loaded. The runner now
uses explicit `FORWARD` and `READ_SERVICE_RECOVERY` verification modes. Recovery
still proves Source/Serving and health, while the forward path retains the
unloaded-service and zero-handle boundary.

The follow-up review also drove these evidence improvements:

- every receipt is bound to the actual Transaction ID and stage;
- the Production runner independently rejects a missing, wrong-transaction or
  wrong-stage receipt;
- the final pre-insert probe runs after the last snapshot and immediately before
  opening the write transaction;
- the real macOS `lsof` regression covers DB, WAL and SHM;
- the new regression is part of Storage Guard CI;
- documentation distinguishes adapter preconditions, runner evidence checks,
  deterministic E2E probes and same-user visibility limits.

## Non-blocking observations

Probe time remains part of the existing maintenance reserve rather than a
separate budget line. Production-scale time evidence is still an open Phase 2
P0, so this PR makes no 12-hour readiness claim. The deterministic executable
E2E and the real `lsof` integration test are separate by design.
