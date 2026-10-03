# External SQLite storage safety

The external-storage guard is active in the production build. Do not unplug or remount the SSD to test it.

## Deployment status

The machine-local mount and UUID settings are installed outside Git. The historical worker uses `KeepAlive=false`, `StartInterval=300`, and `ThrottleInterval=30`. A read-only `quick_check` completed successfully during the INFRA-S1C maintenance window. Production incidents still require manual recovery; the mounted volume alone does not clear the fail-safe latch.

## Local configuration

Set these in the machine-local environment (never in Git):

```text
STOCKBOARD_DB_PATH=/Volumes/<volume>/stock-dashboard/stockboard.db
STOCK_DATA_MOUNT_PATH=/Volumes/<volume>
STOCK_DATA_VOLUME_UUID=<diskutil VolumeUUID>
```

Optional thresholds: `STOCK_DATA_MIN_FREE_BYTES` defaults to 50 GiB and `STOCK_DATA_MIN_FREE_PERCENT` defaults to 5. Both must pass before a writer starts. On the audited 4 TB SSD, the percent threshold is effectively about 200 GB. The incident log defaults to `~/Library/Application Support/StockBoard/storage-incidents/incidents.ndjson` on the internal Mac volume. Never point `STOCK_DATA_INCIDENT_DIR` under `/Volumes/`.

The guard checks the exact mount point, UUID, resolved DB path, device ID, writable state, available capacity, and existing WAL/SHM locations. The first check and a periodic UUID refresh use `diskutil`; requests between refreshes use cheap filesystem identity checks. Once a process records a fatal storage incident, it never reopens or retries that DB. A new process must pass preflight after the physical issue is resolved.

A fatal incident also creates an internal-volume `FAILED_SAFE` latch. A launchd restart cannot reopen SQLite while that latch exists. `npm run storage:recover` requires an explicit incident ID and classification, zero DB handles, 21 identity observations over 10 minutes, matching UUID and volume identity, sufficient space, and no new storage errors in macOS logs. It archives the latch and records the resolution on the internal volume; there is no automatic or `--force` bypass.

## Optional read artifacts

An optional read artifact must certify the configured mount, volume UUID, and device identity before checking the artifact itself. Once that volume identity is healthy, a missing optional file is a feature-local unavailable state and must not create the shared `FAILED_SAFE` latch. Mount loss, UUID or device mismatch, and confirmed `EIO`/`SQLITE_IOERR` remain volume-fatal. Required primary databases continue to require the database file, writable volume, and free-space threshold.

## Production writer inventory

All production-reachable local SQLite writers are covered. `npm run storage:guard-test` enforces that no direct local libSQL/Python SQLite writer bypasses the guarded factories.

| writerId | language / client | entrypoint | long running | LaunchAgent | guard |
| --- | --- | --- | --- | --- | --- |
| web-and-api | Node / libSQL | Next routes via `lib/db/client.ts` | yes | web | sticky Node guard |
| historical-scan | Node / libSQL | historical work queue | yes | historical | sticky + 30s heartbeat |
| outcome-analysis | Node / libSQL | historical work queue | yes | historical | sticky + 30s heartbeat |
| path-research | Node / libSQL | historical work queue | yes | historical | sticky + 30s heartbeat |
| ml-dataset | Node / libSQL | historical work queue | yes | historical | sticky + 30s heartbeat |
| daily-saved-trigger-notification | Node / libSQL | scheduled Trigger families | bounded | scheduler/CLI | central sticky guard |
| JP-ingest-backfill-EDINET | Node / libSQL | batch/update/backfill families | varies | scheduler/CLI | central sticky guard |
| ML-feature-label-serving | Node / libSQL | batch ML families | yes | scheduler/CLI | central sticky guard |
| US-analytics-build | Node / libSQL + sqlite3 CLI | analytics builder | yes | CLI | guarded target + native boundary |
| US-adjusted-foundation | Node / libSQL | adjusted foundation | yes | CLI | guarded clients |
| analog-index-build | Node / libSQL | analog index builder | yes | CLI | guarded source and target |
| MA-trajectory-shadow | Node + Python sqlite3 | runner and trainer | yes | scheduler/CLI | Node preflight + Python sticky guard |
| analog-encoder-shadow | Node + Python sqlite3 | runner and trainer | yes | scheduler/CLI | Node preflight + Python sticky guard |
| serving-shadow-caches | Node / libSQL | serving cache/shadow stores | process lifetime | web/CLI | guarded factory |
| migration-maintenance-sync | Node / libSQL | migration/Turso/maintenance | bounded | manual | guarded client/target |

Python Phase 15/research scripts using `mode=ro` are read-only and excluded. Synthetic fixture writers are test-only and not production reachable.

## Diagnostics

`npm run storage:status` is read-only and does not open SQLite. `npm run storage:diagnose` opens SQLite read-only to inspect PRAGMAs and shows recent disk arbitration evidence. `npm run storage:guard-test` uses fake volume/DB probes; it does not touch the SSD. `npm run storage:db-quick-check` is manual-only, refuses to run while any DB/WAL/SHM handle is present, opens SQLite read-only, and runs `PRAGMA quick_check`. On this 547 GB DB it may take a long time. Never schedule it automatically.

Do not delete WAL/SHM, run VACUUM, repair the filesystem, or change `synchronous` while writers are active. The installed historical plist uses `KeepAlive=false`, `StartInterval=300`, and `ThrottleInterval=30`. Heavy historical/outcome/path/dataset jobs hold `caffeinate -i` only while a claimed job runs.

## Durability benchmark

An isolated WAL test DB on the same external APFS filesystem measured 150 one-row transactions: NORMAL 23.8 ms (6305 tx/s) and FULL 24.8 ms (6044 tx/s). This cache-heavy microbenchmark is insufficient to alter production durability. Keep NORMAL for this deploy and benchmark FULL with representative ingestion separately.

## Recovery after an incident

1. Do not restart writers automatically. Preserve the DB, WAL, and SHM together.
2. Inspect the internal incident log and confirm the physical connection, mount point, and UUID.
3. Gracefully stop all DB clients and disable their LaunchAgents temporarily. Confirm `lsof` reports no DB/WAL/SHM handles.
4. Review macOS logs for actual NVMe timeout, APFS I/O, and unmount evidence. If an actual I/O failure occurred, plan another maintenance `quick_check`.
5. Run `npm run storage:recover -- --incident-id <id> --resolution <classification>` only after the cause and current state are reviewed. A stable mount alone is insufficient; the command observes identity for 10 minutes and archives the latch with a resolution record.
6. Start Web, small workers, then Historical/other heavy workers in stages. Check health, quote, stock page, and Trigger options before allowing heavy workloads.

## Integrity maintenance window

1. Stop accepting new write jobs and enter write maintenance mode.
2. Let active jobs finish gracefully; never use `kill -9`.
3. Confirm `lsof` reports no DB/WAL/SHM handles; record their sizes.
4. Confirm independent backup/snapshot capacity.
5. Run `storage:db-quick-check`; it refuses active handles and opens read-only.
6. Save results internally. Do not automate full `integrity_check` on 547 GB.
7. Re-run preflight and start services in worker-last order.

## Backup recommendation

Quiesce writers, then use an APFS snapshot or SQLite backup API to create a coherent image and copy it to independent storage. An offline DB+WAL+SHM copy is acceptable only after all handles close. A live `cp` of the DB alone is not a backup. Add an off-device/NAS copy in a separate phase.

## Deployment and restart checklist

1. Configure mount, UUID, DB path, and thresholds outside Git.
2. Enter maintenance and install generated LaunchAgents.
3. Verify storage environment and bounded historical restart in generated plist.
4. Check `storage:status`, `/api/health`, static assets, and DB routes; start worker last.
5. Negative-test with fake configuration only; never disconnect the SSD.
6. Roll back plist/build together. Keep writers stopped while `FAILED_SAFE` exists.

Use both 50 GiB absolute and 5 percent free-space thresholds. On this 4 TB volume, 5 percent (about 200 GB) is effective and leaves room for WAL and large jobs.

## Physical evidence

The enclosure appears directly on the Mac USB4/Thunderbolt bus as OWC Express 1M2 80G at 40 Gb/s; no intermediate hub appears in the route. At 04:53 the kernel recorded a third-party NVMe read command timeout and `IONVMeController::FatalHandling`, immediately followed by APFS errors and unmount. The NVMe transport/controller timeout is confirmed; whether cable, enclosure, power, thermal, or media caused it remains unknown. SMART is Verified and critical warning was 0, but this does not exclude intermittent transport issues. Use a direct port, reseat or replace the certified cable, verify enclosure firmware and cooling, and monitor recurrence.

This guard limits application behavior after a disconnect but cannot guarantee that an in-flight filesystem write was durable. Cable, enclosure, power, filesystem, and media causes require independent diagnosis.
