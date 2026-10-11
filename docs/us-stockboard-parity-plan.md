# US StockBoard JP Parity Program

Updated: 2026-10-12

The machine-readable source of truth is `docs/us-stockboard-parity-board.json`. Run
`npm run audit:us-jp-parity` after every wave. The data contract is maintained in
`docs/us-stockboard-data-source-matrix.md`.

## Dependency waves

| Wave | Scope | Gate |
|---|---|---|
| W0 | Inventory, persistent board, data contracts, PIT and future-leakage guards | Board validation, PIT tests, typecheck, build |
| W1 | Stock Detail technical workspace: overview, chart, 6 Stage, Stage History, momentum, scenario, similars | Claude browser review, multi-ticker, four viewports, semantic regression |
| W2 | Dashboard, Screener, Preview, Search, Historical date | Data parity, request/performance budget, historical cross-page parity |
| W3 | Earnings, transitions, backtest, AI, market momentum, sectors, triggers, MTF calendar | Source coverage, PIT, market-calendar and global milestone QA |
| W4 | Fundamentals, valuation and shareholder return | SEC fact contract and forecast-source stop condition |
| W5 | Institutional ownership and US-specific substitutes | Source/licensing approval, final closure loop |

## Current blockers

- Forecast consensus requires an approved source.
- Short-interest serving requires an approved/licensed source.
- Institutional ownership scope requires a product choice between 13F, 13D/G, and insider Form 4 views.
- Historical market cap requires point-in-time shares outstanding.
- Historical classification filters require effective-dated classification history.

These blockers do not stop technical, discovery, chart, Stage, scenario, ML, responsive,
performance, or historical-price parity work.
