# Phase 2 PR I: process entry E2E and ambiguous running-run recovery

Status: isolated implementation. Production application is not approved.

## Process contract exercised

The test starts the real `scripts/batch-ohlcv.ts` process. J-Quants HTTP is
replaced outside the application by a Node preload, and the existing derived
refresh child command is replaced by a PATH fixture. The real updater entry,
database client, daily ingestion boundary, immutable Receipt, Coverage Head,
publication transaction, child lifecycle, and top-level exit handling execute
as one process-level flow.

Covered outcomes:

| Case | Expected terminal evidence |
| --- | --- |
| Complete session, zero insert | Source Run and sync Run become `success`; Receipt remains immutable. |
| Historical known conflicts only | Source Run becomes `partial`; previous successful Source is unchanged. |
| Provider failure | Run is `failed`; no Receipt or OHLCV insert is committed. |
| Corporate Action signal | Hold occurs before the daily ingestion boundary. |
| Historical fallback requested | Process refuses before creating a Source Run. |
| Coverage Head CAS failure | OHLCV, Receipt, and Head transaction rolls back together. |
| Derived refresh failure | Source Run and sync Run become `partial`; no Source publication occurs. |
| Publication transaction failure | Publication rolls back; Run and sync evidence are held `partial`. |
| SIGTERM before Receipt commit | Recovery is allowed only when the starting Head and target bytes are unchanged. |
| SIGKILL after Receipt commit | OHLCV and Receipt are visible, Run stays `running`, and a new updater process is refused. |
| Orphaned derived child | Recovery remains held while the sealed child process identity is live. |
| Wrapper failure with live parent | The dedicated process group is terminated and proved absent before its identity is cleared. |
| Process-probe failure / changed timezone | Probe failure holds; UTC/C-normalized identity remains stable across caller timezones. |
| Explicit recovery and rerun | Hash-bound recovery changes only the ambiguous Run/sync status to `partial`; rerun uses a new Run and may publish normally. |

The SIGKILL case intentionally proves the current Strategy A risk: direct Live
DB readers can observe rows from a `running` Run. A process-level success test
does not make that exposure safe.

## Running-run recovery contract

The updater creates its Source Run and matching sync Run in one SQLite write
transaction. Both rows carry the same sealed execution identity: host, parent
PID/start identity, target session, complete starting Coverage Head hash,
target-session byte hash, and the active derived child process-group identity
when one exists. Process start evidence is collected with UTC and C locale.

The refresh command starts behind an IPC gate in its own process group. The
updater registers that group before releasing the gate and clears it only after
the entire group is proved absent. A liveness probe error is `UNKNOWN`, never
evidence that a writer is dead.

`recover-jp-ohlcv-running-source-run.ts` has separate read-only `status` and
mutating `hold` commands. Recovery is allowed only when:

1. the Run is `ohlcv_fetch:jquants/running`;
2. the sealed parent and derived child process identities are no longer live;
3. exactly one matching J-Quants sync Run has the same sealed identity;
4. before Receipt creation, the starting Coverage Head and target bytes are
   unchanged; or, after Receipt creation, the immutable Receipt, Coverage Head,
   and target bytes agree with its `afterSha256`;
5. the sealed snapshot hash of the previous successful Source row is unchanged; and
6. the operator supplies the exact `statusSha256` produced by the status step.

The recovery transaction changes the matching Source Run and sync Run to
`partial`. It never changes OHLCV, Coverage Head, Receipt, a previous successful
Source Run, or any Reader/Cache. Changed database bytes, a live writer/child,
ambiguous sync Run, changed prior success, or replay after finalization is
fail-closed. An ambiguous Run is never inferred to be successful.

## Remaining safety boundary

This contract prevents a second updater from silently advancing past an
ambiguous Run. It does not hide committed rows from live readers. Strategy A
must hold all direct read services before the first OHLCV mutation and keep them
held through publication or rollback. Normal daily availability without that
hold requires Versioned Serving or an equivalent immutable read generation.
