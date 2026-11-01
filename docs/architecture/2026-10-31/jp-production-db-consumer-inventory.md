# JP Production DB consumer inventory

Observation: 2026-11-01 15:37 JST, read-only. The database path is
`/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`.

This inventory records the Production path migration surface. A plist reference
does not prove an open handle, and a point-in-time handle scan does not provide
admission control.

| LaunchAgent | Loaded | Role | Runtime boundary | Reconnect / generation proof |
| --- | --- | --- | --- | --- |
| `analog-search` | yes | Reader | mutable release, Next | restart required; no sealed generation response |
| `classification-sync` | yes | Writer | mutable release, npm/tsx | hold job; verify DB and source receipt |
| `data-freshness-guard` | yes | Reader/monitor | mutable release, npm/tsx | natural rerun; report is not DB-generation admission |
| `db-maintenance` | yes | Writer/maintenance | mutable release, npm/tsx | hold; explicit post-action DB receipt |
| `earnings-refresh` | yes | Writer | mutable release, npm/tsx | hold; existing deferred path must stay sealed |
| `kabutan-material-news` | yes | Writer | mutable release, npm/tsx | hold; verify no active process group |
| `kabutan-themes` | yes | Writer | mutable release, npm/tsx | hold; verify no active process group |
| `large-holder-update` | no | Writer | mutable worktree, `node --import tsx` | preserve unloaded state |
| `ml-freshness-guard` | yes | Reader/monitor | mutable release, npm/tsx | hold if it opens DB; generation receipt absent |
| `ml-learning` | yes | Writer | mutable release, npm/tsx | hold; preserve scheduler state |
| `ml-weekly-governance` | no | Writer/research | mutable Claude worktree | preserve unloaded state |
| `trigger-historical-scan` | yes | Reader/Writer | mutable release, `node --import tsx` | PID `88798` held DB/WAL/SHM; immutable runtime required |
| `trigger-ml-frozen-monitor` | yes | Reader/monitor | mutable release, npm/tsx | hold if DB handle appears; no generation receipt |
| `update-latest` | yes | Writer | mutable release, `node --import tsx` | primary daily hold/reconnect contract required |
| `us-ml-weekly` | no | Writer/research | mutable Claude worktree | preserve unloaded state |
| `us-update-latest` | yes | Writer | mutable release, `node --import tsx` | hold because common JP path is present |
| `web-health` | yes | HTTP monitor | mutable release script | no direct reconnect proof; validates Web only |
| `web` | yes | Reader | mutable release, Next | stable stop/reconnect and generation endpoint required |
| `weekly-optimization` | yes | Writer/research | mutable release, npm/tsx | loaded definition remains; no manual start |

## Immutable Trigger target

The minimum isolated design is one sealed runtime directory containing the exact
Node executable, compiled Trigger entrypoint, required runtime dependencies and
a manifest that binds every file, lockfile, DB bundle member path, configuration
identity and expected generation-observation contract. The plist must point only
to that directory and must not use `tsx`, a worktree, mutable `node_modules`, or
relative `.env.local` resolution.

Before Production migration, the isolated artifact must prove restart,
read/write policy, lock behavior, Source/Serving/Cache generation observation,
and rollback to another sealed runtime. No plist or Production runtime was
changed during this audit.

## Admission conclusion

The existing 19 consumers share one user account and direct file path. Holding
known launchd jobs plus six `lsof` probes can detect known handles, but cannot
prevent an ad-hoc process from opening the path between probes. Strategy A needs
an OS-enforced admission boundary or a migration to a versioned/bundle path that
is not reachable by unapproved runtimes. This remains Production `HOLD`.
