# Web/Analog-only release procedure

This procedure promotes a prebuilt Next.js artifact and restarts only the two already-loaded
services `com.stockboard.web` and `com.stockboard.analog-search`. It never installs or registers
LaunchAgents and never changes database, schema, indexes, Storage Guard or FAILED_SAFE state.

## Isolated preparation

1. Build the approved candidate without `.env.local`, using an isolated DB path and a dedicated
   `NEXT_DIST_DIR` on the OWC development volume.
2. Verify the artifact `BUILD_ID`, `SMA_RELEASE_MANIFEST.json`, candidate commit and complete tree hash.
3. Verify the immutable Candidate runtime manifest, lockfile, dependency tree, native binaries and
   runtime identity. Both Candidate and rollback runtimes must be physical directories.
4. Run all Candidate acceptance checks and `npm run release:web-analog-only -- --plan`.

## Separately approved Production preflight

1. Confirm the actual running source/Build ID instead of trusting the recorded baseline candidate.
2. Confirm Web and Analog are loaded, enabled and healthy; confirm Storage Guard and Storage health.
3. Record all 16 known agents' loaded/disabled/runtime states and reject any unexpected handle or job.
4. Record the Web/Analog plist SHA-256 values. The runner requires both exact hashes and checks
   `WorkingDirectory`, `.next-live`, Next executable, process role and Storage Identity variables.
5. Resolve and record the release root realpath; the runner rejects any other destination.
6. Generate a hash-pinned preflight proof with a maximum 15-minute lifetime. It must bind the
   baseline, Candidate commit/Build/tree, Candidate and rollback runtimes, Price Basis, JP/US
   source and serving generations, lineage, Storage Guard, FAILED_SAFE, writer locks, promotion
   journals, Web/Analog/Freshness health, rollback artifact and OWC volume identity/capacity.
7. Confirm the artifact plus 50 GiB safety margin fits on the release volume and OWC data volume.
8. Require `STOCKBOARD_DEPLOY_SKIP_SCHEMA=1`, the exact proof SHA-256, and the exact live/candidate
   Build, artifact and runtime identities.

## Promotion

Before creating a transaction, the runner verifies the proof and every live attestation. It then
stages the artifact and Candidate runtime link and verifies the proof again. If this fails, no
Production path or service is changed.

The runner writes and fsyncs an external transaction journal and release lock. It freezes Web and
Analog, rechecks the proof immediately before mutation, then performs journaled renames of both the
artifact generation and runtime generation. It executes only:

- `launchctl kill SIGSTOP gui/$UID/com.stockboard.web`
- `launchctl kill SIGSTOP gui/$UID/com.stockboard.analog-search`
- `launchctl kickstart -k gui/$UID/com.stockboard.web`
- `launchctl kickstart -k gui/$UID/com.stockboard.analog-search`

It then checks both loopback health endpoints and re-observes every known Agent. Any loaded,
disabled or non-target runtime-state difference fails closed.

## Rollback

Any promotion, restart, health or state-preservation failure restores both `.next-live-prev` and
the rollback runtime, restarts only Web and Analog, rechecks health and verifies the complete Agent
snapshot. Rollback is not complete until the restored artifact tree hash and physical runtime
identity pass. A failed verification leaves the journal in `ROLLBACK_FAILED` and retains the lock.
The failed Candidate remains outside the live paths for diagnosis. The runner never removes a
FAILED_SAFE latch or invokes Storage Recovery.

## Interrupted transaction

SIGINT, SIGTERM, SIGKILL or power loss may leave Web/Analog stopped and a durable journal/lock
present. Automatic retry is forbidden. Preserve every path listed in `recovery.protectedPaths`,
record the journal stage and transaction ID, and treat the release as **HOLD**. Resume frozen
services only as part of an operator-approved recovery. Use the journal identities to recover the
rollback artifact and runtime together, then verify their full identities before restarting
Web/Analog. Never delete the lock or journal merely to make another run start.

An existing journal, lock or partial-journal file belongs to the transaction that created it. A new
runner refuses it without freezing services or attempting rollback.

## Prohibited operations

`bootstrap`, `bootout`, `enable`, `disable`, `web:install`, daily/ML installers, schema/index tools,
Writer operations, Storage Guard mutation, journal cleanup without recovery evidence and automated
retry are outside this procedure.
