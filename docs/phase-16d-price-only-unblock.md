# Phase 16D Price-only Freshness Gate

Date: 2026-09-25 JST

## Scope

This gate refreshed only certified JP closing-price evidence in an isolated Phase 16D shadow. The holder-state source was the completed D5 shadow, while the production database was opened read-only and used only for the completed market-date proof and official 2026-09-25 OHLCV rows. No production Large Holder database, snapshot, or pointer was written.

The shadow seed supports a separate `--price-source`. It verifies the price source with the existing `priceUpdateCompleted` contract, copies the completion signals and latest official daily rows into the shadow, and proves row equality before the gate can run. Storage UUID protection remained enabled.

## Preflight

- Production health: healthy
- Storage Guard: pass
- Completed JP market date: 2026-09-25
- Coverage proof: 4,226 expected and 4,226 stored rows
- Latest daily sync: success for 2026-09-25
- Latest required update: completed successfully
- D5 source filing watermark: 254 / 1790052302 / 2026-09-18 17:13
- D5 source population: 359 positions, 233 investors, 190 public-ready positions
- D5 source quarantine: `S100Z2WE`, `S100Z34W`, `S100Z3AM`

The initial shadow status was stale for exactly `NEW_PRICE` and `PRICE_EVIDENCE_STALE`. Position fingerprint, filing watermark, and review state matched D5.

## Price-only Result

- Target price date: 2026-09-25
- Published shadow snapshot: `0e8a32b0a42d9bab1426c62ff10ca86ad478f651987ff3ddc99e1be327014e52`
- Snapshot status: `VALIDATED_WITH_QUARANTINE`
- Public-ready valuation check: 190 / 190 exact
- Raw official close versus local completed close: 190 / 190 exact
- Valuation mismatch: 0
- Positions: 359 -> 359
- Investors: 233 -> 233
- Activities: 21 -> 21
- Filing watermark: unchanged
- Position identity hash: unchanged
- Investor identity/classification hash: unchanged
- Activity semantic hash: unchanged
- Filing hash: unchanged
- Unexpected identity difference: 0

Eight tickers had no 2026-09-25 official close in the completed source: `1892`, `353A`, `4530`, `5530`, `555A`, `7051`, `7691`, and `8594`. Every affected position remained `UNVALUED` with a null value and null price date. No old close, zero value, adjusted close, intraday price, US price, or manual price was substituted.

Ticker 6459 retained six positions for six distinct investors, with zero duplicate pair and zero generated activity. The three known quarantines remained excluded from published positions, filings, and activities.

All, Individual, and Institutional rankings were exercised across total value, recent increase, new 5%, and decrease. All twelve combinations returned the new snapshot and price date with HTTP 200. Ownership and investment-authority meanings were unchanged.

## Idempotency And Final Daily

A fresh-process rerun on the identical price state returned `UNCHANGED` in 226 ms. The current pointer digest did not change, no immutable snapshot was added, and duplicate activity remained zero.

The fresh-process Final Daily regression used 2026-09-19, the established no-document D5 regression date. The EDINET index returned zero target documents; missing, changed, and withdrawal sets were empty; and the snapshot again returned `UNCHANGED`. SQLite `quick_check` was `ok`, unresolved source count was zero, and only the three known quarantines remained.

## Gate

- Shadow Price-only Refresh: PASS
- Valuation cross-check: PASS
- Identity invariance: PASS
- Idempotency: PASS
- Final Daily regression: PASS
- P0/P1: 0/0
- Phase 16D Complete: YES
- Production Canary Gate: GO

This result does not enable the production scheduler, execute a production backfill, or modify production Large Holder state. A production dry run and one-business-day canary remain separate post-checkpoint operations.
