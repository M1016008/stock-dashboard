# JP OHLCV incident 1793380144053-98117 retention

Status: closed by rollback and writer restoration. This incident must not be
replayed. The incident-only Emergency Recovery and Rollback Finalization entry
points were retired after the evidence below was verified read-only on
2026-11-01.

## Terminal evidence

- Archived journal: `repair-journal.json.rolled-back-1793380144053-98117`
  - stage: `ROLLED_BACK`
  - SHA-256: `dd6f956a76a9e2ddbdf833e28cc5d0be1644388df0fcb73539dc7f7e307c4387`
- Restore state: `rollback-restore-1793380144053-98117.json`
  - phase: `COMPLETED`
  - SHA-256: `892dbe701cce43a23740b84c236b89b3cd77a5f3cb58c1f1ce2fce8189225ec3`
- Writer recovery: `rollback-writer-recovery-1793380144053-98117-026c6b65-326c-42b3-adec-9d227431ab12.json`
  - status: `COMPLETED`
  - package approval: `8e60f6733a5ddb5fbcfc69966ee41f3cfd5d4e767f4380aa39885f0621b07655`
  - SHA-256: `f8fd8c8201eb8897a5a938a4c878d21da7cf24430b1118ef5e29085fff580257`
- Active `repair-journal.json` and `repair.lock`: absent.

The terminal state evidence directory is
`/Users/yoshio/Library/Application Support/StockBoard/jp-ohlcv-repair-state`.
The 551 GB backup remains immutable at
`/Volumes/OWC Express 1M2 80G/stock-dashboard/jp-ohlcv-repair-backups/1793380144053-98117.sqlite`.
Its metadata SHA-256
is `f5ed1a1ea785d385e5f53ce3cc667d066957e4bbead3669e7c8c7fdeecfe1c2c`;
the recorded database SHA-256 is
`ae7c6c1785c63834818036d9b24b8cd35443c30966ca21437f5a9cc4d8744eb2`.
The failed database copy is also retained. Neither artifact is authorized for
deletion, restoration, or reuse by this retirement change.

## Immutable command evidence

The four command snapshots remain under the transaction evidence directory.
Each filename prefix was recomputed from the file bytes and matched:

- `038830...-execution-configuration.json`
- `d9829a...-recovery-execution-configuration.json`
- `3fec14...-run-jp-ohlcv-production-stage.ts`
- `e7d823...-run-jp-ohlcv-production-stage.ts`

The final incident implementation is retained in Git commit
`4a6562a9f7713681b26039acbb8977feb53b4d64`. Git history is the forensic source
for the retired builders and orchestrators; checking out that commit does not
authorize execution. Recreating, rerunning, or adapting an incident package
requires a new review and explicit approval.

The original finalization package JSON was not present in the live state or
repository audit directories at retirement time. It was not reconstructed.
Its approval identity remains in the completed Writer recovery receipt, while
the commands actually executed remain in the hash-named snapshots above.

## Retained safety contracts

The active repair path continues to own the generic Backup/Restore, Journal,
Storage Guard, Generation, process supervision, command identity, and
executable-plan E2E contracts. The retirement removes only the completed
incident's package builders, orchestrators, monitoring helper, and dedicated
finalization transition. The finalization-only Cloudflare/Freshness assertions
are retired with that transition; active Gateway policy and immutable-runtime
tests remain. Existing package evidence and Production artifacts are unchanged.

The generic v2 rollback consumer and its inherited-evidence checks remain in
the active repair core because a future approved repair can still require a
hash-bound rollback. They cannot replay this closed incident without a new
active Journal, Lock, and exact approval. The incident package builders and
their standalone operation lease were removed; no Production entry point can
recreate the retired package.
