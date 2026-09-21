# INFRA-S1E: storage probe classification

## 20:57 incident

- Incident `83c04590-e1ce-4939-b7df-f50e7cbe2670` occurred at 2026-09-21 20:57:32 JST in the Historical Scan worker (PID 25230). The prior successful check was 20:57:10 JST.
- The recorded code is `PROBE_FAILED`. The old incident format did not retain which subprocess or filesystem probe failed, so the exact failing stage cannot be reconstructed.
- In the 20:52-21:05 JST OS-log window, no external-volume unmount, NVMe command timeout, `IONVMeController::FatalHandling`, APFS I/O error, or system sleep/wake was found. StorageKit referenced `disk5s1` immediately before the incident, and the expected APFS volume is mounted now; continuous mount presence throughout the interval is not proven. This differs from the 04:53 confirmed controller/APFS failure signature.
- Classification is **UNKNOWN**, not a confirmed physical disconnect. Formal recovery must still use `UNKNOWN_BUT_CURRENTLY_STABLE` after current identity, handle, and stability checks pass. No `quick_check` is repeated without evidence of an actual unmount or storage I/O error.
- Independent read-only observation completed 21/21 checks at 30-second intervals over 10 minutes on 2026-09-21 23:39-23:49 JST. Mount, configured UUID, DB/WAL/SHM device identity, capacity, and new NVMe/APFS errors remained stable.
- With production writers stopped and DB/WAL/SHM handles at zero, the existing `storage:recover` procedure independently completed 21/21 checks and archived the latch at 2026-09-22 00:00:50 JST with resolution `UNKNOWN_BUT_CURRENTLY_STABLE`. The original incident record was retained. The pre-existing production build was restarted and passed health and smoke checks; this did not deploy INFRA-S1E.

## Runtime contract

- Startup and major job boundaries certify the full volume UUID, APFS filesystem, capacity, DB realpath, and DB/WAL/SHM device identity.
- Normal runtime checks remain in-process and are throttled to once per second on guarded accesses (the Historical worker also invokes the guard every 30 seconds); full UUID certification changes from every 60 seconds to every 300 seconds. The latter still runs on `assertWritable(true)`.
- A single external probe command timeout, nonzero exit, or plist parse failure enters `PROBE_UNCERTAIN`. An internal-disk marker blocks new transactions across Node and Python processes. The guard performs at most two more full certifications, after 1 and 2 seconds, while independently checking mount/DB identity. Recovery requires the configured UUID and device to match. A recovered transient removes its marker and is logged without a permanent latch. A probe owner that exits before confirmation is promoted to `FAILED_SAFE` by the next guard check.
- Missing mount/DB, device or UUID mismatch, read-only or low-space state, and actual SQLite/OS I/O errors remain immediate `FAILED_SAFE`. Three unresolved probe attempts also promote to `FAILED_SAFE`. A permanent latch requires manual `storage:recover`; no automatic fatal recovery is introduced.
- Probe events and fatal incidents record the stage (`MOUNT_TABLE`, `DISKUTIL_INFO`, `PLUTIL_PARSE`, `STATFS`, `REALPATH`, `STAT_DEVICE`, `UUID_COMPARE`) and safe command diagnostics. Public health returns only `available`, `verifying`, or `unavailable`, never device identity or UUID.
- The same uncertain/confirmed-fatal distinction applies to the Python writer guard.
- Two isolated 20-minute fixture observations completed `HEALTHY` with zero failures: 4 full / 1,074 lightweight checks and 4 full / 1,084 lightweight checks. The final fixture run measured full-probe average 0.5 ms / p95 1 ms and lightweight average 0.023 ms / p95 below 1 ms. These fixture timings do not represent `diskutil` on the physical volume.
- Five read-only physical full probes measured 193.71, 156.00, 164.34, 148.23, and 166.18 ms (average 165.69 ms). A 10,000-call in-process guard benchmark averaged 0.063 ms per call (p95 0.078 ms, p99 0.183 ms); it did not write to the production DB.

## Deployment safety

- This is a code-only change. `STOCKBOARD_DEPLOY_SKIP_SCHEMA=1 npm run web:deploy` skips the otherwise unconditional `db:ensure-schema` step. The normal deploy default remains unchanged.
- The source DB, WAL, SHM, historical result artifacts, and Phase 16C worktree are not modified by this patch. An independent backup is still unavailable. Phase 16C release remains gated on sustained production storage health after INFRA-S1E.
