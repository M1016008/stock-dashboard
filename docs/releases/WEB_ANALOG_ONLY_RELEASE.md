# Web/Analog-only release procedure

This procedure promotes a prebuilt Next.js artifact and restarts only the two already-loaded
services `com.stockboard.web` and `com.stockboard.analog-search`. It never installs or registers
LaunchAgents and never changes database, schema, indexes, Storage Guard or FAILED_SAFE state.

## Isolated preparation

1. Build the approved candidate without `.env.local`, using an isolated DB path and a dedicated
   `NEXT_DIST_DIR` on the OWC development volume.
2. Verify the artifact `BUILD_ID`, `app-paths-manifest.json`, candidate commit and file hashes.
3. Run all Candidate acceptance checks and `npm run release:web-analog-only -- --plan`.

## Separately approved Production preflight

1. Confirm the actual running source/Build ID instead of trusting the recorded baseline candidate.
2. Confirm Web and Analog are loaded, enabled and healthy; confirm Storage Guard and Storage health.
3. Record all 16 known agents' loaded/disabled/runtime states and reject any unexpected handle or job.
4. Record the Web/Analog plist SHA-256 values. The runner requires both exact hashes and checks
   `WorkingDirectory`, `.next-live`, Next executable, process role and Storage Identity variables.
5. Resolve and record the release root realpath; the runner rejects any other destination.
6. Confirm the artifact plus 50 GiB safety margin fits on the release volume.
7. Require `STOCKBOARD_DEPLOY_SKIP_SCHEMA=1` and the exact expected live/candidate Build IDs.

## Promotion

The approved runner copies the artifact to `.next-live-next`, verifies its Build ID, renames the
current `.next-live` to `.next-live-prev`, promotes the staged artifact, and executes only:

- `launchctl kickstart -k gui/$UID/com.stockboard.web`
- `launchctl kickstart -k gui/$UID/com.stockboard.analog-search`

It then checks both loopback health endpoints and re-observes every known Agent. Any loaded,
disabled or non-target runtime-state difference fails closed.

## Rollback

Any promotion, restart, health or state-preservation failure restores `.next-live-prev`, restarts
only Web and Analog, rechecks health and verifies the complete Agent snapshot. The candidate
artifact remains outside the live tree for diagnosis. The runner never removes a FAILED_SAFE latch
or invokes Storage Recovery.

## Prohibited operations

`bootstrap`, `bootout`, `enable`, `disable`, `web:install`, daily/ML installers, schema/index tools,
Writer operations, Storage Guard mutation and automated retry are outside this procedure.
