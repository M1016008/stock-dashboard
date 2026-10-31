# Phase 2 PR E: persistent coverage-ledger domain

## Contract

Coverage issues are keyed by date, ticker, and kind. An issue remains `OPEN`
until a later run proves that the official adjusted value and stored value are
equal. A newer complete trading date does not hide an older open issue, even
after that date leaves the rolling 260-session audit window.

`MISSING` issues allow only an exact official insert. `VALUE_CONFLICT` issues
allow only a no-op that preserves the currently stored value. This is the pure
domain contract for protecting unresolved `1447` and `2164`; enforcement is not
complete until the follow-up repository adapter invokes it at the write
boundary. A conflict cannot be auto-resolved merely because an updater changed
the stored row to the current official value; that is treated as an
unauthorized protected-value change and remains HOLD.

Every continuation accepts an expected previous Projection hash that the
follow-up repository must supply from an independent head pointer. Every old
open issue also requires a fresh row observation, so a caller cannot silently
omit the ledger or avoid rechecking an issue after it leaves the rolling audit
window. Evidence errors produce `EVIDENCE_HOLD`; valid open issues produce
`PARTIAL_HOLD`; only a valid, empty open set is `PUBLISHABLE`. Evidence holds
are not continuable or automatically waived; a future explicit, hash-bound
operator transition is required if official evidence is legitimately revised.

## Verification

The isolated test creates one missing row and two conflicts on 2026-07-17,
advances to a complete later date, proves that the old issues still block
publication, and then resolves the missing issue only with its sealed official
value. It also tests omitted ledgers, missing old-date observations, official
value revisions, replayed run IDs, reopened issues, wrong-value insertion,
conflict overwrite, and tampered prior evidence.

## Follow-up boundary

This PR defines the pure state transition. The next small PR will add the
SQLite repository and bind ledger persistence atomically to the ingestion
receipt and Source Generation. No Production schema or service is changed.
