# TradingView MTF Close Oracle

1. Open `TSE:7203` on a standard `1D` chart.
2. Select the regular exchange session and keep the chart timezone on the exchange timezone.
3. Add `mtf-close-oracle.pine` in Pine Editor and run it.
4. Use **Export chart data** and include indicator values.
5. Import and validate the CSV:

```bash
npm run mtf:tradingview:import -- \
  --csv /absolute/path/to/tradingview-export.csv \
  --symbol TSE:7203 \
  --from 2025-01-01 \
  --to 2026-10-02
```

The command converts the CSV into
`fixtures/mtf-close-calendar/tradingview-close-dates.json` and prints every
timeframe/date mismatch. The fixture remains `NOT_VALIDATED` until a non-empty
TradingView export has been imported and all 12 timeframe comparisons pass.

Re-run the committed fixture check with:

```bash
npm run test:mtf-close-calendar:tradingview
```

## Validated scope

- Symbol: `TSE:7203`
- Chart/session: `1D`, regular exchange session, exchange timezone (`Asia/Tokyo`)
- Period: `2025-01-01` through `2026-10-02`
- Coverage: 425 trading dates x 12 timeframes = 5,100 timeframe/date comparisons
- Result: 0 mismatches

Calendar dates after `2026-10-02` are projections produced by the validated
bucket rules. They are not represented as directly observed TradingView oracle
results until a later CSV export extends the committed fixture coverage.
