# Multi-timeframe analog state encoder

The state encoder is an isolated shadow experiment for the historical analog
search. It does not replace or modify the production ranking.

## Input and objective

- Daily branch: current MA structure plus 10/20/40-session trajectory changes.
- Weekly branch: 13/26/52-week MA structure.
- Monthly branch: 9/24/60-month MA structure.
- Yearly branch: 3/5/10-year MA structure.
- Supervision: confirmed 5/10/20/40/60/90/200-session forward-return profile.
- Loss: multi-horizon prediction, pairwise metric learning, and state
  reconstruction.
- JP and US are trained and evaluated separately.

The compact state rows come from the existing `analog_sequence_index`. The
encoder has independent branches for each timeframe and produces a normalized
32-dimensional shadow embedding.

## Leakage controls

- Chronological train, validation, and test splits.
- A 300-calendar-day purge gap around split boundaries.
- Test outcomes are used only for final evaluation.
- The baseline and encoder use the same reference pool and the same test
  queries.

## Accuracy gate

Shadow results qualify for review only when all checks pass:

1. At least 500 test queries.
2. At least 3% relative improvement in top-10 outcome-profile MAE.
3. At least one percentage point improvement in direction agreement.
4. The upper bound of the paired bootstrap 95% interval is below zero.
5. No individual horizon deteriorates by more than 3%.

Even when all checks pass, the result remains shadow-only. Production ranking
requires a separate explicit decision after reviewing JP and US reports.

## Commands

```bash
npm run setup:analog-encoder
npm run test:analog-encoder
npm run batch:analog-encoder-shadow:jp
npm run batch:analog-encoder-shadow:us
```

US execution exits with status 75 until adjusted prices, derived data, and the
analog index are promoted to the same generation. Model artifacts, reports,
sample query metrics, and shadow rankings are stored beside the source DB under
`analog-encoder-shadow/<market>/`.
