# Phase 2 PR F: coverage-head persistence

## Scope

This adapter persists one JP adjusted-OHLCV ledger head and its ingestion
receipt in a single SQLite write transaction. The caller supplies the expected
previous Projection hash. The transaction compares that independent value with
the current row before inserting the receipt and advancing the head.

The head and append-only receipt are joined by a binding hash over scope,
Source Run, Projection hash, and Receipt hash. Reads join and revalidate both
JSON documents and the binding, rather than trusting the head's hash columns.

The store accepts `PUBLISHABLE` and valid `PARTIAL_HOLD` projections. It rejects
`EVIDENCE_HOLD` and invalid receipts. A partial projection therefore records
unresolved conflicts without falsely publishing the Source Generation.

## Failure behavior

A stale head, replayed source run, duplicate receipt, invalid JSON, or failed
head write aborts the transaction. The fixture installs an aborting SQLite
trigger after the receipt insert on both bootstrap and head-update paths and
proves that neither the new receipt nor the head update survives. An exact
replay returns the already committed binding; a replay with different evidence
fails closed.

## Boundary

This PR creates no Production table and changes no Production writer. The next
adapter PR will call the store from the normal updater transaction and bind the
result to the Source Generation status. Bootstrap remains explicit: a null head
is valid only when the repository query proves that no head exists.
