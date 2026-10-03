# INFRA-S1D storage incident triage

## Evidence

- At 2026-09-21 17:06:04 JST, the Historical Scan worker recorded `VOLUME_NOT_MOUNTED`. Its previous successful guard check was 17:05:45 JST. The original incident log remains unchanged on the internal volume.
- The 04:53 incident had a kernel NVMe command timeout, `IONVMeController::FatalHandling`, APFS unmount, and Disk Arbitration unmount. Those signatures were not found in the 17:00-17:12 JST window. No sleep/wake event was found in the same interval.
- The original guard converted any `diskutil info`, plist-conversion, or filesystem probe exception into `null`, then classified `null` as `VOLUME_NOT_MOUNTED`. The exact failing subprocess at 17:06 cannot be recovered from the original incident record. Physical disconnection is not established.

## Guard correction

The guard still fails closed on every storage probe error. It now distinguishes a mount absent from the OS mount table (`VOLUME_NOT_MOUNTED`) from a volume identity probe failure while the mount remains listed (`PROBE_FAILED`). This improves incident classification; it does not authorize continued writes after a failed probe.

## Manual recovery

1. Preserve the incident log and latch. Do not unplug the SSD, delete WAL/SHM, or clear the latch by hand.
2. Gracefully stop loaded DB writer LaunchAgents and confirm `lsof` finds no DB/WAL/SHM handles.
3. Confirm the current mount UUID, APFS device, DB realpath, companion-file devices, writable state, and free-space threshold.
4. Run `npm run storage:recover -- --incident-id <latest-id> --resolution UNKNOWN_BUT_CURRENTLY_STABLE`. The command performs 21 observations at 30-second intervals, repeats full preflight, checks macOS storage errors since the start, requires zero DB handles, archives the original latch, and writes an internal resolution record.
5. Start Web first, then small workers, then Historical worker. Verify `/api/health`, quote, stock page, Trigger options, and production smoke before heavy work.
6. If any identity check, OS error audit, or process check fails, leave the latch active and do not resume writes.

No independent backup medium is currently connected. INFRA-S2 remains blocked; the source OWC volume is not a disaster-recovery destination.

## 2026-09-21 recovery record

- An independent read-only observation checked mount-table presence, mount/DB realpaths and device IDs every 30 seconds for 10 minutes: 21/21 passed. The UUID matched at the start and end. New NVMe/APFS error signatures in that interval: 0.
- All 16 previously loaded StockBoard agents were stopped gracefully; `lsof` showed zero DB/WAL/SHM handles. The formal `storage:recover` gate then passed another 21/21 observations, full preflight at both ends, zero handles, and no new macOS storage errors.
- Recovery classification: `UNKNOWN_BUT_CURRENTLY_STABLE`. At 20:34:36 JST the command archived the original latch as `FAILED_SAFE.resolved-<incident-id>` and wrote `recovery-<incident-id>.json` on the internal volume. It did not delete the incident log or source DB files.
- Web, Analog, and Historical worker were started in that order. Production health and representative APIs returned HTTP 200. The new build ID is `j4ACR23c-A7p7JMmtOaQh`; production smoke passed 150/150.
- The 17:06 incident has no confirmed physical unmount or NVMe timeout signature. The previous `quick_check=ok` remains the latest full check; no new 2-hour check was run because no actual unmount or storage I/O error was found at 17:06.
- This recovery does not prove that the OWC cable, enclosure, power, thermal state, or SSD is physically reliable. A validated independent backup is still required for disaster recovery.
