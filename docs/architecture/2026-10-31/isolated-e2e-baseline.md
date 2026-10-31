# Isolated E2E Baseline

Run at Git head `4a6562a9f7713681b26039acbb8977feb53b4d64` using an
immutable dependency runtime outside Production. No Production path or service
was mutated.

## Results

| Test | Result |
| --- | --- |
| `test-jp-ohlcv-gap-repair.ts` | PASS |
| `test-jp-ohlcv-runtime-snapshot.ts` | PASS |
| `test-jp-ohlcv-backup-time-budget.ts` | PASS |
| `test-jp-ohlcv-production-repair.ts` | PASS |
| `test-jp-ohlcv-executable-plan-e2e.ts` | PASS |

Executable-plan E2E evidence:

- official trading rows: 4,218
- approved keys: 4,067
- exact rows already satisfied before execution: 6
- inserted rows: 4,061
- preserved existing rows: 157
- preserved conflicts: `1447`, `2164`
- duplicate execution: rejected
- rollback crash recovery: PASS
- source/serving generation transition: PASS in the fixture contract

The expected injected `after-primary-archived` restore crash was observed and the
test continued through the approved recovery path.

## Scope limit

This is a characterization baseline, not Phase 2 completion. The fixture does
not prove 551 GB runtime behavior, actual launchd/handle ownership, or that the
synthetic generation pointers are a universal Production publication boundary.
The Strategy A changes and P1 findings must be implemented and rerun before a
new Production package can be considered.
