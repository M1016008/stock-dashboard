# Claude Code Independent Review

Review date: 2026-10-31

Audited baseline: `4a6562a9f7713681b26039acbb8977feb53b4d64`

Scope: read-only review of the Phase 0/1 documents and repository code. Claude
Code did not edit files, run Production queries, or claim Production readiness.
Codex independently rechecked the cited code paths and incorporated the accepted
findings into the ADRs and debt register.

## Findings

### P0

1. **Forward verification is deterministically over budget after mutation.**
   `build-jp-ohlcv-production-configuration.ts` gives
   `verify-rebuilt-derived-state` 10 minutes, while
   `verify-jp-ohlcv-repair-derived-state.ts` runs full `PRAGMA quick_check` on
   the 551 GB live DB. The measured full check is about 3h30m. This is the only
   post-write whole-DB integrity check, so it needs a correctly budgeted
   replacement rather than deletion.
2. **Rollback capacity is not proven.** With about 915 GiB free before creating
   another approximately 551 GB backup, the current same-filesystem restore
   path uses an additional `copyFileSync` temporary file of similar size. The
   backup preflight does not prove the complete restore layout fits.

### P1

1. Head already contains a 260-session gap gate, but Production predates it;
   `partial` is still publishable to at least one cache watermark and unresolved
   gaps age out of the rolling window.
2. Synthetic generation JSON is circular evidence. The repair does not write a
   real source run/receipt, while the two-year line-search cache is keyed by the
   unchanged latest publishable `batch_runs` ID.
3. The duplicate-validation map must distinguish backup integrity, mutated-live
   integrity, and restore identity. A receipt cannot prove unchanged bytes
   without a fresh byte identity at the later trust boundary.
4. The first target state diagram omitted reader-hold and in-flight states and
   did not define which emergency/finalization layers would be deleted after the
   incident. The revised diagram now includes recoverability-changing states and
   a retirement boundary.
5. Production runtime coupling is broader than installer paths: daily jobs use
   `npx tsx` from captured working directories, the runtime manifest producer is
   not repository-owned, and ignored dependency files are not proven by Git
   cleanliness.
6. Price Basis has at least three transformations: provider adjustment,
   corporate-action in-place rebase, and heuristic split normalization used by
   several readers. The current schema cannot prove historical knowledge time.
7. `1447` and `2164` are protected by the one-time insert-only repair, but the
   ordinary updater can later overwrite them. Preservation requires an ongoing
   conflict contract.
8. Strategy A remains preferable to B for the immediate incident, but a
   filesystem-clone/reflink variant must be evaluated before inventing another
   backup receipt or assuming the copy-based rollback fits.

### P2

- The 39-file/+17,399-line metric was a narrow filename-family metric. The full
  branch delta is 365 files, +76,595/-1,634 lines.
- The isolated fixture apply path still differs from the Production insert path,
  and ordinary ingestion reports planned rather than affected insert rows.
- Time-budget caps have effectively no slack.
- Raw live evidence is intentionally outside Git and must retain a reproducible
  query/fetch manifest.
- Backup retention and immutable research-evidence obligations need an owner.

## Unknowns to close before Phase 2 sign-off

1. Exact commit/runtime identity for each live Production LaunchAgent.
2. Actual Production filesystem clone/reflink semantics and allocation behavior.
3. Content coverage of `runtimeIdentitySha256`, especially dependency bytes.
4. Corporate-action/basis compatibility for all 4,061 residual missing keys.
5. Full derived rebuild duration and completeness for the historical repair,
   rather than a daily rebuild measurement.
6. Complete list of source-run-ID cache consumers and current invalidation paths.
7. Backup retention requirement after incident closure.

## Recommendation

| Gate | Result |
| --- | --- |
| Phase 0 evidence | Conditional GO after the document corrections in this change |
| Modular-monolith direction | GO |
| Strategy A design sign-off | HOLD until both P0 and all Production-blocking P1 findings close |
| Strategy B immediate use | HOLD; current readers lack one atomic generation boundary |
| Production repair | HOLD; not authorized by this audit |
