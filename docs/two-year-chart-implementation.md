# 24か月足と上昇終値ライン

Status: `LOCAL IMPLEMENTATION / FIXTURE QA ONLY / PRODUCTION NOT TOUCHED`

## Step 0 audit

- StockBoard already exposed `2Y` in `lib/timeframes.ts`, but it used the generic year/multiplier aggregator.
- The generic result did not carry complete/forming/incomplete status and did not implement the requested three- or four-candle lines.
- JP and US Stock Detail both render the shared `CandlestickChart`, so the integration is shared rather than duplicated.
- Existing JP and US history routes already return the chart's established adjusted OHLC basis. This change does not introduce another price transform.
- No prior 24-month Step 0 report was present in the inspected repository/worktrees.

## Implemented contract

- Buckets start on an even year and cover two calendar years.
- Open is the first valid source open; high/low are extrema; close is the last confirmed source close; volume is summed.
- Calendar coverage is checked against a market-session list beginning at the first bucket boundary, not the ticker's first row. A post-listing partial first bucket or missing coverage therefore produces `incomplete`, which is excluded from line detection.
- The latest covered bucket is `forming`; it can participate as the endpoint only on/after January 1 of its second year.
- Three-candle detection requires consecutive A/B/C buckets and the strict condition `A.close < A.open`, `B.close > B.open`, `C.close > C.open`, and `C.close > B.close`. Its line anchors are the B/C closes.
- Four-candle detection requires consecutive A/B/C/D buckets and the strict condition `A.close < A.open`, `B.close > B.open`, `C.close > C.open`, `D.close > D.open`, and `D.close > C.close`. Its line anchors are the C/D closes.
- Confirmed lines are solid; provisional lines are dashed. The registry retains only the latest confirmed line ending at the immediately previous 24-month bucket and the latest eligible provisional line ending at the current forming bucket. Older candidates are not recursively substituted.
- Anchor points use absolute period-midpoint timestamps and are included in every chart projection even when they are outside the current display range.
- Standardized angle is `atan(((P2 / P1 - 1) / deltaYears) / 0.20) * 180 / pi`, with `deltaYears` derived from absolute timestamps using 365.2425 days per year. It is independent of viewport, zoom, timeframe, and price-scale mode.
- Last-candle rise is `(endpointClose / endpointOpen - 1) * 100`. A confirmed line's current distance is `(currentConfirmedClose - L(asOf)) / L(asOf) * 100`; it is omitted when the ticker close is stale relative to the market as-of date.

## Report A: timeframe and search-surface inventory

### Timeframes

The shared Stock Detail chart exposes `D`, `2D`, `3D`, `W`, `2W`, `3W`, `M`, `2M`, `3M`, `6M`, `Y`, `2Y`, `3Y`, and `5Y`. There is no separate `5D` interval in the current `ChartIntervalCode`; no new interval was invented. The same registry is projected onto all fourteen supported intervals. JP and US Stock Detail opt in explicitly; unrelated commodity, ETF, earnings, and compact preview charts do not start a full-history registry request.

### Search surfaces

| Surface | Classification | Integration |
| --- | --- | --- |
| `/screener?mode=legacy` | General JP stock filtering | Direct four-state filter; applied before sorting/pagination |
| `/us/screener` | General US stock filtering | Direct four-state filter; applied before sorting/pagination |
| `/screener` integrated view | General JP fundamentals/structure filtering | Explicit links to the common technical screener filter; no duplicate line formula |
| Header / command search, `/api/search`, `/api/us/search` | Symbol/name lookup | Advanced filter is not embedded; command terms route `24か月足`, `2年足`, and `上昇終値ライン` to the relevant screener |
| JP/US stage screeners | Six-stage matrix search | Domain-specific and not modified; their existing analysis navigation exposes the general screener |
| JP/US trigger discovery | Trigger authoring/evaluation | Domain-specific and not modified; no duplicate 24-month condition engine |
| Watchlist | User-owned subset, not a market screener | Not applicable; existing stock links open the shared Stock Detail chart |
| Period explorer / chart drill / AI research | Specialized period or research workflow | Not modified; general market-wide filtering remains in JP/US screener |
| Commodity screener | Non-equity instruments | Not applicable to the JP/US equity registry |

## Report B: cross-timeframe line contract

- Source of truth: `TwoYearLineRegistry`, keyed by market, security identity, as-of date, and price-basis version.
- Coordinates: B/C midpoint dates for three-candle lines and C/D midpoint dates for four-candle lines. Display intervals never recompute anchors or slope.
- Projection: both absolute anchors plus `L(t)` for real displayed bar dates at or after the first anchor are emitted. No synthetic OHLC bars are created and the line is never extended backwards.
- Visible right-edge extension is a rendering-only overlay derived from the final rendered segment. It creates no synthetic OHLC or future market date, and repaints against the current plot width after zoom, pan, resize, timeframe changes, and normal/log price-scale changes.
- Confirmed lines use a subdued teal solid stroke at width 3; provisional lines use a subdued amber dashed stroke at width 2. A narrow neutral halo is painted underneath both so they remain legible over candles without changing their data-space anchors or arithmetic slope.
- When line display is enabled, the time scale reserves a small six-bar right offset for forward visual inspection. The overlay fills all currently visible future whitespace up to the plot edge.
- Lifecycle: only the immediately preceding confirmed endpoint and the current eligible provisional endpoint are considered. A provisional line disappears as soon as the current endpoint loses the strict rule.
- Viewport: anchors can be outside the visible range. The projected points that intersect the chart's real time domain remain available during zoom, pan, and resize.
- Price scale: normal/log modes transform rendering only. The underlying arithmetic-price equation is unchanged, and trendline series are excluded from autoscale so they do not distort the price range.
- PIT: when Stock Detail has an analysis date and future reveal is off, both security history and benchmark sessions are cut at that date before split normalization and registry construction.
- Async isolation: registry requests are abortable and use a cancellation guard, preventing an older ticker response from replacing the current registry.

## Report C: unified search contract

- Status filters are `none`, `confirmed`, `provisional`, and `either`; pattern filters are `either`, `three`, and `four`.
- Angle lower/upper bounds are validated in the inclusive 0–90 degree range and fail closed on invalid or reversed bounds.
- The search and chart both call the same strict `detectRisingCloseLines` implementation.
- JP uses `jp-split-normalized-v1`; US declares the existing Tiingo adjusted OHLC ratio basis as `tiingo_adj_ohlc_ratio_v1`. The older misleading `split-only` label is not used.
- Search loads compact two-year block boundaries/counts and likely JP split events instead of materializing every daily row in Node. Its versioned cache is bounded to four market/as-of keys and expires after five minutes.
- Completeness compares the exact benchmark-session intersection, so a ticker-only extra row cannot conceal a missing 1306/SPY session. The reported as-of date is the actual benchmark calendar endpoint.
- Candidate filtering is performed on the full post-filter universe before line sorting and pagination. The US path removes its ordinary candidate cap whenever the two-year-line filter/sort is active. Existing conditions combine with the line filter by AND.
- The representative row is selected for the requested status. A confirmed search never displays a newer provisional line as its evidence.
- Results expose status, pattern, source periods, anchor closes, standardized angle, endpoint-candle rise, confirmed-line distance, as-of date, and price-basis version. Sorts are available for angle, endpoint-candle rise, and confirmed-line approach from below. Calendar/history unavailable entries fail closed.
- Real-universe latency and numerical parity remain a Production-read validation item; this local phase uses only synthetic SQLite and browser fixtures.

## Time and price basis

Input dates are exchange-local ISO session dates. Grouping uses their calendar year directly, avoiding host timezone conversion. JP is tagged `Asia/Tokyo`; US is tagged `America/New_York`.

The implementation consumes the same OHLC stream already rendered by each Stock Detail chart. It does not mix raw and adjusted fields inside the new aggregator. Calendar completeness uses 1306 for JP and SPY for US as local exchange-session proxies, and keeps the market's latest date separate from the ticker's latest row so stale or delisted histories cannot be labelled as forming. Exact parity against a TradingView export remains unverified because this phase did not access real market data or an authenticated TradingView dataset.

## Local QA

The development-only fixture at `/dev/two-year-chart` uses synthetic OHLC and a synthetic market calendar only. It contains a latest confirmed three-candle line and a current provisional four-candle line. Production builds return 404 for this route. Production DB/API communication is not required by the fixture.

## Report D: implementation and QA

- Pure tests cover even-year aggregation, completeness, both strict pattern rules, equality exclusion, 2026/2027 provisional boundary, cancellation, latest-only lifecycle, standardized angle, endpoint rise, confirmed-line distance, distance priority, registry projection, and all supported chart intervals.
- A temporary SQLite test under `/tmp` validates JP/US compact search, full-universe evidence selection, three/four pattern selection, confirmed/provisional coexistence, status-specific representative rows, unavailable/stale history, exact benchmark-session coverage, calendar-end clipping, and analysis-date split parity between candles and the registry. It never opens the configured StockBoard database.
- Browser fixture QA covers all fourteen interval round trips, right-edge extension coordinates, zoom/pan/resize repainting, normal/log scales, visible status/pattern/angle filtering, line status/metrics, and 1440/1024/768/390 px layouts without horizontal overflow.
- Existing SMA and stage calculations are consumed but not changed.

## Report E: independent review

- Claude review identified three P1 issues: analysis-date look-ahead, full-history screener materialization/unbounded cache, and provenance/status mismatch in search evidence.
- Revisions added as-of clipping before adjustment, compact SQL block loading with bounded caching, and status-specific evidence plus visible provenance.
- Final review then found a display-basis mismatch when a JP split occurred after a historical analysis date. The normal chart history API now accepts the same as-of boundary as the registry, applies split inference only to that bounded history, and clips benchmark metadata to the same date. Registry loading/errors fail closed instead of drawing a locally recomputed line on a potentially different basis.
- Search and chart coverage semantics now both require every benchmark session while allowing harmless ticker-only rows; provenance is available to assistive technology and registry state changes are announced.
- The final first-party Claude review of the three/four-pattern, latest-only revision reported zero P0/P1 findings. It independently traced provisional timing, standardized angle, fresh-close distance, full-universe filtering, JP/US parity, and absolute-anchor projection across all fourteen intervals.
- Production data, Storage Guard, Phase 3C, V5/V6 artifacts, Validation, and Holdout were not accessed.
- Real-market TradingView parity remains deliberately `NOT_PERFORMED`.
