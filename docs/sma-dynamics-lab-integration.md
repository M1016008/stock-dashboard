# SMA Dynamics Lab — application integration

Phase 1–3B is integrated in the repository's JP/US stock-detail chart tabs. Those pages reuse their
existing history APIs; the Lab adds no database connection, schema, scheduler, stage or trigger logic.
Merging this code does not itself deploy it. As of 2026-10-26, the integrated Lab has not been released
to Production.

`/dev/sma-dynamics` is different: it is a development-only, synthetic-Fixture preview. It performs no
API or database read and returns HTTP 404 in Production and Share Mode.

## Where it lives

| Surface | Path |
| --- | --- |
| JP stock detail → チャート tab | `app/stock/[ticker]/StockDetailClient.tsx` (`SmaDynamicsSection`, `market="JP"`) |
| US stock detail → チャート tab | `components/us/stock-detail/UsChartWorkspace.tsx` (`market="US"`) |
| Fixture-only preview | `/dev/sma-dynamics` (404 in production and share mode) |
| Six-stage current candidates | mainでは`components/research/SixStageEventPathLab.tsx`。SMA限定Candidateは送信側研究UIを含めず、銘柄詳細側の受信契約だけを含む |

History comes from the existing `/api/history/[ticker]` and `/api/us/history/[ticker]` routes
(same rows and price basis as the main chart). The preview injects fixtures instead.

## What the lab computes

* **Forward simulation** of every SMA over an arbitrary assumed close path.
  Price freeze, user-typed closes per bar, constant-rate (rise / fall), linear, **shock**
  (one-off jump at T+k, held or walking back) and solver example paths all feed the same rolling-window math.
* **SMA periods 3–300**: 11 presets plus any integer typed in the period box (max 12 lines at once).
* **Shared daily scenario** (`lib/sma-dynamics-daily-scenario.ts`, `SmaDailyScenarioPanel`): one path of future **daily
  session closes** per market + ticker + analysis date (default 3 sessions, up to 60) drives **all 15 timeframes** at once.
  Per bar of each timeframe:
  * **confirmed by input** — every session through the bar's last session is explicitly entered; its close is the last session's
    assumed close and it enters the SMA window (same `projectSmaPath` engine as everything else). The UI labels it
    `仮定・入力完了`, never as market-observed data;
  * **provisional** — the entries (contiguous from T+1) reach into the bar but not to its end; a provisional SMA uses the
    latest entered close, is labelled `仮定・暫定` and never feeds a later bar;
  * **unentered** — nothing contiguous reaches it. A missing / invalid session is never filled and blocks confirmation of every
    later bar (entries behind a gap are counted but unused).
  Presets: a target move over the entered sessions (e.g. −10%) as **even** (straight line, ends on target), **all on the first
  session** (held) or **all on the final session**; plus flat, ±0.5%/session, ±10% shock. The all-timeframe table
  (SMA picker, one row per timeframe, tap a row to select that timeframe) shows confirmed bars, provisional entries and the
  SMA change versus the as-of SMA. The daily scenario lives next to the per-timeframe drafts in the simulation state, so
  switching timeframes keeps it; another security or analysis date starts empty.
  **Daily → selected timeframe** is an explicit button: only bars labelled `仮定・入力完了` get their exact close (price unit), provisional or
  unreached bars stay empty, and the panel states `仮定・入力完了 n/m本`. The existing selected-timeframe editor, price scenario and
  inverse solver then work on that draft unchanged (verified: forward SMAs and solver direction checks agree with the
  daily projection).
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
| 1D 2D 3D | 1/2/3 market sessions | **Identical to the chart.** Bucket membership comes from `lib/timeframes` `getTimeframeBucketKey`: sessions are numbered per exchange year from that year's first market session, bar `b` holds indices `[b·n, b·n+n−1]`. No bar spans New Year; a year's last bar may be short. |
| 5D | 5 market sessions | **Lab-only** (no 5D chart interval). Same engine and rule as 2D/3D with n = 5: five consecutive sessions counted from the year's first session, the last bar of the year may be short. |
| 1W 2W 3W | calendar weeks (Mon–Sun) | **Identical to the chart.** 1W is the calendar week. 2W/3W follow the TradingView reset: a week belongs to the year of its Monday, week 0 is the week containing Jan 4 (Jan 4 on a weekend → the next Monday), bar `b` holds weeks `[b·n, b·n+n−1]` of that year. A week spanning New Year stays in the year of its Monday (US 01-02 stays in the December bar; a JP year-end is closed by the next Monday). |
| 1M 2M 3M 6M | calendar months / quarters / halves | same as chart |
| 1Y 2Y 3Y 5Y | calendar years, multi-year blocks counted from 1970 | same as chart (2Y = 2026–2027, 3Y = 2024–2026, 5Y = 2025–2029) |

There is **no fixed-epoch mode** any more (continuous session / week numbering independent of the year). It disagreed
with the chart for 2D/3D/2W/3W, so the Lab path always uses the chart's boundaries; `test-sma-dynamics-timeframes.ts` checks
that every Lab bar holds exactly the sessions the chart's resampler groups (JP and US, 1996–2033) and
`test-sma-dynamics-daily-scenario.ts` checks that Lab and chart SMA values match for identical history.

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
guessed). On main, the six-stage candidate list builds links with `sixStageCandidateLinkRequest(row)` — daily bars,
the six current-serving SMAs, price-freeze view, and the adjacent long-term pair with the smallest `|pairDistance|`
preselected. The SMA限定Candidate intentionally omits that research UI and current-serving store while retaining
the validated receiver/parser contract on JP/US stock pages. A **synthetic** projection (`fixture: true`) only ever
links to the fixture preview, never to a stock page. On arrival the lab names the origin and warns if the candidate's
`asOf` differs from the loaded history's latest bar; all numbers still come from the page's own price history.

The collapsed/open preference is separate for JP and US stock-detail surfaces. The synthetic Fixture preview never reads or
writes either preference, and the former shared key is intentionally ignored to prevent cross-surface state leakage. Within
each market, the user's choice is intentionally reused across ticker navigation; it does not cross from JP to US.

The SMA限定Candidate ships only the receiver side of `smasrc=six-stage-current`. Until the separately managed six-stage
sender UI is released, that origin notice can appear only from an explicitly constructed or previously saved URL; it does not
fetch a research store or reconnect stopped research work.

## Tests

`npm run test:sma-dynamics:all` (15 scripts; CI runs the whole chain. `test-sma-dynamics-daily-scenario.ts` covers one 3-session path across all 15
timeframes at JP / US year ends, Thanksgiving week and mid-period, even / first / final-day / flat / rise / fall / shock paths,
gaps and invalid input, chart-resampler parity, timeframe switching and Forward / Inverse consistency). `test-sma-dynamics-crossing.ts` checks the solver against an
independent forward recomputation on 24 deterministic histories (400+ feasible bars, both sides of each boundary).

## Known gaps

* Browser QA covers the fixture chart, mode/scenario controls, desktop and 390px layout. Physical-device hover, pinch and the iOS keyboard remain NOT_TESTED manual-device checks.
* 2D/3D require the existing `1306`/`SPY` market-session rows. Missing calendar rows fail closed; the Production Preflight smoke must exercise both markets before release.
* Touch / cross answers are conditional on the stated earlier path; they are not "minimum over all paths".
* Shock is one jump; compound events (gap then drift) are built by typing or by combining with the bulk tools.
* The lab loads full daily history (`period=all`) on first open; very long histories on 1D are the heaviest case (~0.1 s compute).
* `SixStageRealEventPathLab` (real event paths) has no candidate rows, so no link there.
