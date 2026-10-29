# JP OHLCV Runtime Drift Root Cause (2026-10-29)

## Incident scope

- Target date: `2026-07-17`
- Approved snapshot: 151 existing, 149 matching, 4,067 missing, 2 preserved conflicts
- Later snapshot: 157 existing, 155 matching against a freshly fetched adjusted source, 4,061 missing, 2 preserved conflicts
- Preserved conflicts: `1447`, `2164`
- No repair transaction, writer hold, backup, database mutation, or generation publication occurred.

## Writer attribution

The six rows were written by the normal JP daily updater, not by the repair package.

- LaunchAgent: `com.stockboard.update-latest`
- Release root: `/Users/yoshio/dev/stock-dashboard-release-7df6c23`
- Batch run: `8660` (`update_latest`)
- Started: `2026-10-29 16:40:32 JST`
- Script path: `scripts/batch-ohlcv.ts`
- Historical process PID: `UNKNOWN` (the retained logs do not record it)
- Source: J-Quants API v2 daily quotes, adjusted fields (`AdjO`, `AdjH`, `AdjL`, `AdjC`, `AdjVo`)
- Write path: the legacy Production updater's full-history UPSERT path, activated by four corporate-action boundaries and two boundary candidates.

The relevant updater evidence reports corporate-action factors for `1328`, `6036`, `6574`, and `6787`, plus boundary refreshes for `3779` and `5341`. That path refetches adjusted full history and can insert an older missing session while processing the current day.

## Price-basis findings

The four apparent mismatches were caused by comparing current Production values with an older J-Quants adjusted snapshot. J-Quants adjusted history is retroactively revised after later corporate actions.

| Ticker | Later adjustment | Current Production vs current J-Quants |
| --- | ---: | --- |
| 1328 | price x0.02, volume /0.02 | exact match |
| 6036 | price x0.5, volume /0.5 | exact match |
| 6574 | price x10, volume /10 | exact match |
| 6787 | price x0.5, volume /0.5 | exact match |
| 3779 | boundary refresh | exact match |
| 5341 | boundary refresh | exact match |

The target day's `adjustmentFactor=1` does not describe corporate actions announced after that day. The current adjusted OHLCV fields are the authoritative value for the configured `jquants-adjusted-ohlcv-v1` price basis. Existing conflicts `1447` and `2164` remain preserved and are outside this repair authorization.

## Generation finding

The database changed while the old repair package's Source/Serving pointers did not. This is classification B: the package monitored the wrong generation contract.

The old pointers were synthetic repair-lineage files under `.audit`. The normal updater neither reads nor updates them. The actual JP source watermark used by current serving is the latest publishable `batch_runs` row for `job_type='ohlcv_fetch:jquants'`. Consequently, unchanged synthetic pointers did not prove an unchanged Production source.

## Permanent transaction contract

The new contract preserves fail-closed behavior without forcing package regeneration for a normal exact insert:

1. Seal the current official adjusted dataset hash and the approved repair key set.
2. Before writer hold, refetch the provider dataset and reject a changed official hash, non-publishable source runs, price conflicts, unknown keys, or incomplete serving state.
3. After writer hold, capture a 15-minute runtime snapshot containing the real source watermark, serving watermark, current target rows, and bounded repair classification.
4. An approved key may move only from missing to an exact current-official match. It then becomes `alreadySatisfied` and is excluded from the residual insert set.
5. A value mismatch, official source revision, unknown key, preserved-conflict change, source watermark change, serving watermark change, or TTL expiry is HOLD.
6. Revalidate the exact runtime snapshot after acquiring the update lock and again immediately before the write transaction.
7. Inside the write transaction, requery the target date and require the same residual scope. Inserts use plain `INSERT`; conflict suppression is not a success path.
8. Commit evidence records approved keys, exact keys already satisfied by the normal updater, runtime residual keys, and inserted rows. It requires `approved = already satisfied + residual` and `residual = inserted`.

This contract does not expand authorization: it can shrink the approved insert set when a normal updater has already stored the exact sealed value, but it cannot add keys, overwrite values, accept a revised official source, or relax PIT/price-basis checks. A later retroactive provider adjustment changes the official hash and is therefore an explicit `SOURCE_REVISED` HOLD requiring new approval.
