# Storage Guard development-isolation release

## Release gate

Merge is allowed only when all of the following are true:

- PR head and `main` are mergeable without conflict.
- `Storage Guard / Build` passes for the current PR head.
- The focused regression proves both sides of the contract: an unconfigured
  development process fails locally without probing storage or creating the
  shared `FAILED_SAFE` latch, while a configured volume UUID mismatch still
  creates the latch and remains fail-closed.
- The US analytics path stays local unless `US_ANALYTICS_DB_PATH` is explicitly
  configured.
- Independent review has no P0/P1 finding.

## Separately approved deployment

This PR does not authorize deployment or machine configuration changes. A later
deployment approval must use a clean release checkout containing the merge
commit and the existing `npm run web:deploy` procedure with
`STOCKBOARD_DEPLOY_SKIP_SCHEMA=1` because this is a code-only change.

Before promotion, record the current `.next-live/BUILD_ID`, confirm sufficient
internal-disk space, no active `FAILED_SAFE`, exact Production mount/UUID/DB
identity, machine-local credential availability, and the intended enabled and
disabled LaunchAgent set. The deploy script's LaunchAgent reinstall behavior is
part of the approval boundary and must not silently enable intentionally
disabled jobs.

After promotion, require runtime topology audit, Web and Analog health, storage
available, JP/US read-only API smoke, site smoke, and a 15-minute stability
observation. No database migration, recovery, or backup action belongs to this
release.

## Rollback conditions

Rollback immediately to the recorded previous build if any of these occurs:

- Web or Analog health does not recover, HTTP 503 appears, or storage is not
  available.
- A new `FAILED_SAFE` incident appears, Production identity validation weakens,
  or the runtime audit finds a split worktree/configuration.
- JP/US read-only smoke or the site smoke suite fails.
- An intentionally disabled LaunchAgent is enabled or an expected service set
  differs from the recorded pre-deploy inventory.

Use the existing `.next-live-prev` rollback path and restore the recorded
LaunchAgent inventory. Never delete a latch or alter expected storage identity
to make rollback pass; any real incident follows the official recovery runbook.
