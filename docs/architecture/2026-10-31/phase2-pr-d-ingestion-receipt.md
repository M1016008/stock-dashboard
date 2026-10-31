# Phase 2 PR D: JP OHLCV ingestion receipt

## Responsibility

`buildJpOhlcvIngestionReceipt` is a pure transition classifier. Given a sealed
runtime repair scope, official rows, and atomically captured before/after
database rows, it records exact inserted, already-satisfied, remaining-missing,
and preserved-conflict keys.

The caller must also supply the independently stored approval-plan and approved
repair-key hashes. A consistently re-sealed but unapproved runtime scope is not
accepted as authority.

The before/after inputs must be atomic, target-date-scoped reads. The receipt
projects only the OHLCV value contract, so unrelated storage metadata cannot
silently redefine its identity.

It fails closed when the sealed scope or official hash differs, an existing row
changes, an inserted value differs from the official value, a duplicate or
unknown key appears, or a preserved conflict is modified. It does not write a
database or publish a Generation.

## Production-scale fixture

The isolated test uses 4,218 official rows, the original 151-row approval
baseline, six later exact rows, a 157-row runtime baseline, two preserved
conflicts (`1447`, `2164`), and 4,061 residual missing rows. It verifies exact
counts, order-independent hashing, residual missing, conflict mutation,
inserted-value mismatch, deletion, unknown rows, duplicates, empty source, and
tamper rejection.

`APPROVED_KEYS_SATISFIED` means only that every approved missing key is present.
It is paired with `UNRESOLVED_CONFLICTS_HOLD` while `1447` and `2164` remain; it
must not be interpreted as complete JP data quality.

## Follow-up boundary

The normal updater and repair adapter must persist this receipt atomically with
their Source Generation. That storage adapter and the persistent coverage issue
ledger are intentionally separate Draft PRs. Production integration remains
HOLD.
