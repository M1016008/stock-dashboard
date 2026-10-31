# JP Price Basis and Lineage

## Current path

```text
J-Quants API v2 /equities/bars/daily
  Raw fields: O/H/L/C/Vo
  Adjusted fields: AdjO/AdjH/AdjL/AdjC/AdjVo + AdjFactor
    -> lib/jquants.ts normalizes adjusted fields
    -> scripts/batch-ohlcv.ts writes adjusted OHLCV to ohlcv_daily
    -> corporate-action refresh can rebase earlier stored OHLCV in place
    -> app/api/history/[ticker]/route.ts reads ohlcv_daily
    -> adjustLikelySplitOhlcv applies heuristic normalization
    -> API/UI labels result as jp-split-normalized-v1
```

The repair approval uses `jquants-adjusted-ohlcv-v1`; the updater can later
rewrite historical rows during corporate-action refresh, and the history route
serves a further named basis after heuristic split normalization. The same
heuristic also feeds continuous-MA, trigger timeframes, and stock-preview read
models. This is not a single lineage contract. Corporate-action golden cases are
required to prove adjusted provider rows are neither adjusted twice nor mixed
with locally rebased neighbours.

## 2026-07-17 evidence

- The latest provider envelope contains 4,442 rows.
- 4,218 contain valid adjusted OHLCV.
- 224 are all-null no-trade records and are excluded by contract.
- No partial or otherwise invalid provider row was observed.
- Accepted content SHA-256 is
  `cfbf6d48f9b0f2438484f04154a800a55bd41d03a2d5622f9be44e4c7ac2bb20`.
- Existing `1447` and `2164` values differ slightly from the current adjusted
  provider values while volume matches. They remain preserved until a separate
  corporate-action/lineage adjudication proves which historical revision should
  be authoritative.
- All 4,061 missing tickers must be classified for corporate actions after the
  target date before assuming current provider-adjusted rows share the exact
  basis of adjacent Production rows.

## Required permanent contract

Define a `PriceBasis` value object with:

- provider and endpoint;
- raw versus adjusted field set;
- provider revision/content hash;
- adjustment policy/version;
- observation time and source generation;
- any application transform, with its input and output basis.

No module may label data merely as "adjusted" without the complete basis. A
transform must reject an incompatible input basis, and the history API must
return the basis identity with its rows.

## Required tests

- no corporate action;
- split and reverse split before/after the requested window;
- later provider revision of historical adjusted values;
- raw and adjusted inputs must not be interchangeable;
- 1447 and 2164 preserved values remain unchanged;
- 1306 and 7003 match the captured official adjusted rows;
- main chart and SMA Lab consume the same basis and calendar;
- PIT `asOfDate` cannot observe a later basis revision unless that revision is
  explicitly part of the historical contract.

The current `ohlcv_daily` schema has no revision-observed-at or knowledge-time
column, and ingestion overwrites rows. Therefore the final PIT requirement is a
target contract, not a property the current schema can prove.

## Decision

The immediate repair continues to use the sealed J-Quants adjusted rows and does
not adjudicate existing conflicts. Before architecture migration marks the price
basis complete, the history transform must be converted from an implicit
heuristic to an explicit, golden-tested basis transition or removed when proven
redundant.
