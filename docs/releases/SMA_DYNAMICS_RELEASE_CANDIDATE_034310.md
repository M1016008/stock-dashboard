# SMA Dynamics Lab release candidate

## Identity

- Candidate branch: `codex/sma-dynamics-release-candidate`
- Recorded Production baseline candidate: `034310b72f57163ee4607c05d1057310277a787d`
- Feature source merge: PR #19 / `b7a7514c2adf9cbdaa018d47cb28f5ccac90a4a0`
- Stabilization source merge: PR #20 / `e86c38ffef3039062908ad875766f7ca789c77a4`
- The real running Production SHA is intentionally not asserted by this document.

## Scope audit

- Recorded baseline to main: 203 changed paths.
- Candidate: 73 paths (64 selected main paths, the shared `package-lock.json` security update, plus
  8 Candidate-only release/QA paths).
- Main changes excluded from this Candidate: 139 paths.
- The complete Candidate path set is the committed diff from the baseline; the artifact manifest separately
  hashes every generated Build file. Research/current-serving, backup, ML and scheduler paths are absent.

## Included

1. SMA Dynamics deterministic computation, all 15 timeframes, scenarios, inverse solver and UI.
2. JP and US stock-detail integration and receiver-side six-stage deep-link contract.
3. Fixture-only development preview with an explicit Production/Share HTTP 404.
4. The 2D/3D exchange-session calendar dependency needed for chart/Lab boundary parity:
   `lib/timeframes.ts`, both history routes, `CandlestickChart.tsx`, and its regression test.
5. The 15-suite regression command and CI registration.
6. A separately approved Web/Analog-only release runner and synthetic rollback rehearsal.

## Explicitly excluded

- Six-stage research pages, current-serving projection, Discovery stores and research APIs.
- Phase 3C, outcome/rank-sign code, Validation/Holdout assets and ML changes.
- Weekly backup, scheduler, LaunchAgent installer and Storage Guard configuration changes.
- PR #12 through #18 changes other than the five-file 2D/3D calendar dependency above.
- Database schema, index, migration and data changes.

## Runtime dependencies

- Existing guarded JP `/api/history/[ticker]` and US `/api/us/history/[ticker]` read routes.
- Existing JP/US market-session reference tickers for 2D/3D chart requests (`1306` and `SPY`).
- Browser-local deterministic computation and namespaced localStorage preferences.
- No new environment variable, DB writer, scheduler, service or external API.

## Framework security baseline

- The Candidate pins `next` to `16.4.1`, the minimum 16.x patched release for the 2026-10-14
  upstream security update. React and React DOM remain pinned to `19.2.4` because they already
  satisfy the patched Next.js peer contract.
- The lockfile resolves Next.js runtime companions to `@next/env` / SWC `16.4.1` and `sharp`
  `0.35.5`. Existing compatible transitive ranges are refreshed to non-advisory releases for
  `baseline-browser-mapping`, `source-map-js`, and `brace-expansion`.
- This dependency correction is shared platform maintenance, not an SMA-only semantic change.
  Main must receive the same `package.json` / `package-lock.json` security delta in a dedicated
  security PR before later main-based releases; the Candidate must not be allowed to drift back to
  `next` `16.3.0` during conflict resolution.
- Release acceptance requires `npm audit` to report zero known advisories and a clean-lock
  `npm ci --ignore-scripts` followed by the full regression and isolated Production build.

## Release artifact contract

- A clean committed checkout produces the artifact and `SMA_RELEASE_MANIFEST.json` with candidate commit,
  baseline, Build ID, byte count and deterministic tree SHA-256.
- Promotion requires exact current/candidate Build IDs, candidate commit, artifact hash, release-root realpath,
  Web/Analog plist hashes and 50 GiB post-copy headroom.
- Web/Analog plist definitions must still point to the release root and `.next-live`, use the expected Next
  executable and carry the complete Production Storage Identity environment.
- No Candidate command registers, enables, disables, bootstraps or boots out any LaunchAgent.

## Acceptance evidence

Security refresh verification on 2026-10-26 used Node.js `24.11.1` and a clean
`npm ci --ignore-scripts` installation:

- `npm audit`: 0 known vulnerabilities (previously 1 Critical, 3 High and 1 Moderate).
- `npm run test:sma-dynamics:all`: 15/15 suites passed.
- `npm run storage:guard-test`, `npm run test:web-analog-release`,
  `npm run test:us-analytics-generation`, and the CI-equivalent
  `npx tsx scripts/test-us-automation-foundation.ts`: passed.
- `npm run test:timeframes`, `npm run test:mtf-close-calendar`,
  `npm run test:us-stock-detail-parity`, `npm run test:two-year-chart`,
  `npm run test:custom-charts`, `npm run test:historical-analogs`,
  `npm run test:us-search-api`, and `npm run test:screener-natural-language`: passed.
- `npx tsc --noEmit` and the isolated Production build with Next.js `16.4.1`: passed.
- Real loopback HTTP checks against the Production build returned `404` for the exact preview
  path and query form, and `308` then `404` for the trailing-slash form. Development returned
  `200`; JP/US Fixture views, the shared daily scenario and all-15-timeframe projection were
  visually checked at 390px and 1440px.
- The Fixture benchmark stayed within measurement noise of the 16.3.0 Candidate: JP
  p50/p95 `439.19/450.54 ms`; US p50/p95 `447.21/460.24 ms` across 12 runs.

The reproducible acceptance commands are:

- `npm run test:sma-dynamics:all`
- `npm run test:timeframes`
- `npm run storage:guard-test`
- `npm run test:web-analog-release`
- `npm run benchmark:sma-dynamics-release`
- `npx tsc --noEmit`
- isolated Fixture-backed `NEXT_DIST_DIR=.next npm run build`
- 390px and 1440px fixture-preview browser checks

Production performance, the real current Build ID, Storage identity, Cloudflare path and
LaunchAgent inventory remain Pre-Deploy gates requiring separate Production access approval.
