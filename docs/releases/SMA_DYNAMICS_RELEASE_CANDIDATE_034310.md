# SMA Dynamics Lab release candidate

## Identity

- Candidate branch: `codex/sma-dynamics-release-candidate`
- Recorded Production baseline candidate: `034310b72f57163ee4607c05d1057310277a787d`
- Feature source merge: PR #19 / `b7a7514c2adf9cbdaa018d47cb28f5ccac90a4a0`
- Stabilization source merge: PR #20 / `e86c38ffef3039062908ad875766f7ca789c77a4`
- The real running Production SHA is intentionally not asserted by this document.

## Scope audit

- Recorded baseline to main: 203 changed paths.
- Candidate: 72 paths (64 selected main paths plus 8 Candidate-only release/QA paths).
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

## Release artifact contract

- A clean committed checkout produces the artifact and `SMA_RELEASE_MANIFEST.json` with candidate commit,
  baseline, Build ID, byte count and deterministic tree SHA-256.
- Promotion requires exact current/candidate Build IDs, candidate commit, artifact hash, release-root realpath,
  Web/Analog plist hashes and 50 GiB post-copy headroom.
- Web/Analog plist definitions must still point to the release root and `.next-live`, use the expected Next
  executable and carry the complete Production Storage Identity environment.
- No Candidate command registers, enables, disables, bootstraps or boots out any LaunchAgent.

## Acceptance evidence

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
