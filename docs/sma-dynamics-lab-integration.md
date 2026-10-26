# SMA Dynamics Lab — development integration

Development-only integration of the SMA Dynamics Lab (Phase 1–3B) into the stock detail pages.
Nothing here reads Production data, adds a server route, or changes stage / trigger logic.

## Where it lives

| Surface | Path |
| --- | --- |
| JP stock detail → チャート tab | `app/stock/[ticker]/StockDetailClient.tsx` (`SmaDynamicsSection`, `market="JP"`) |
| US stock detail → チャート tab | `components/us/stock-detail/UsChartWorkspace.tsx` (`market="US"`) |
| Fixture-only preview | `/dev/sma-dynamics` (404 in production and share mode) |
| Six-stage current candidates | link column in `components/research/SixStageEventPathLab.tsx` |

History comes from the existing `/api/history/[ticker]` and `/api/us/history/[ticker]` routes
(same rows and price basis as the main chart). The preview injects fixtures instead.

## What the lab computes

* **Forward simulation** of every SMA over an arbitrary assumed close path.
  Price freeze, user-typed closes per bar, constant-rate (rise / fall), linear, **shock**
  (one-off jump at T+k, held or walking back) and solver example paths all feed the same rolling-window math.
* **SMA periods 3–300**: 11 presets plus any integer typed in the period box (max 12 lines at once).
* **Inverse solving**
  * slope direction / within N / throughout N / reversal / level versus the anchor SMA (Phase 2)
  * **touch / cross / relative position** (`lib/sma-dynamics-crossing.ts`): the close or an SMA against another SMA.
    With the earlier closes fixed the gap at bar k is affine in the one unknown close, so the boundary is exact;
    tick / min / max reuse the Phase 2 price domain. Earlier bars are an explicit assumption (price freeze or the
    user's complete scenario). Touch uses closes only (future highs / lows are unknown).
* **Shape** (`lib/sma-dynamics-geometry.ts`, `SmaShapePanel`): slope (%/bar), curvature (change of slope),
  crossings (SMA–SMA and close–SMA, past and assumed), convergence / divergence of adjacent pairs and of the whole band,
  close position per SMA and the SMA ordering, over the last 30 confirmed bars plus the assumed bars.

## Timeframes (all linked to the SMA unit: SMA N = N bars of the selected timeframe)

| Id | Bar | Boundary vs main chart |
| --- | --- | --- |
| 1D 2D 3D 5D | 1/2/3/5 market sessions | 1D same; 2D/3D/5D numbered continuously from the first 2000 session (the chart restarts each exchange year; 5D is not a chart interval) |
| 1W 2W 3W | calendar weeks (Mon–Sun) | 1W same; 2W/3W continuous from 1970-01-05 (chart restarts each year) |
| 1M 2M 3M 6M | calendar months / quarters / halves | same as chart (verified in `test-sma-dynamics-timeframes.ts`) |
| 1Y 2Y 3Y 5Y | calendar years, multi-year blocks counted from 1970 | same as chart |

Bars hold only sessions of the market calendar (JP: TSE incl. documented extra closures; US: NYSE).
The deterministic calendar range is 1990–2099; the lab fails closed outside it because pre-1990 TSE
Saturday sessions are not represented by the app's calendar artifact. Holiday rule-transition years are
covered by independent fixtures (including JP Happy Monday / Emperor birthday and the NYSE Saturday-New-Year rule).
A bar is *confirmed* only after its last session; the open bar is *forming*, never feeds an SMA, and the first
projected bar completes it. Rows after the analysis date are excluded (PIT). Horizon is 1–20 bars (1D also 60);
3Y/5Y stop at 13/8 bars so the projection stays inside the supported calendar (≤ 2099).

## Link contract (`lib/sma-dynamics-link.ts`)

```
/stock/7203?smalab=1&smatf=1D&smap=5,25,75,150,200,300&smamode=freeze&smapair=25-75
    &smasrc=six-stage-current&smaasof=2026-10-23&smagen=<generation>#chart
/us/stock/AAPL?smalab=1&...#chart
/dev/sma-dynamics?fixture=jp-rising&smalab=1&...        (synthetic projections only)
```

`smalab=1` is required; every other field is optional and validated one by one (bad values are dropped, never
guessed). The six-stage candidate list builds links with `sixStageCandidateLinkRequest(row)` — daily bars, the six
current-serving SMAs, price-freeze view, and the adjacent long-term pair with the smallest `|pairDistance|`
preselected. A **synthetic** projection (`fixture: true`) only ever links to the fixture preview, never to a
stock page. On arrival the lab names the origin and warns if the candidate's `asOf` differs from the loaded
history's latest bar; all numbers still come from the page's own price history.

## Tests

`npm run test:sma-dynamics:all` (13 scripts). `test-sma-dynamics-crossing.ts` checks the solver against an
independent forward recomputation on 24 deterministic histories (400+ feasible bars, both sides of each boundary).

## Known gaps

* Browser QA covers the fixture chart, mode/scenario controls, desktop and 390px layout. Hover and pinch gestures remain manual-device checks.
* Touch / cross answers are conditional on the stated earlier path; they are not "minimum over all paths".
* Shock is one jump; compound events (gap then drift) are built by typing or by combining with the bulk tools.
* The lab loads full daily history (`period=all`) on first open; very long histories on 1D are the heaviest case (~0.1 s compute).
* `SixStageRealEventPathLab` (real event paths) has no candidate rows, so no link there.
