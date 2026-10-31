# Phase 2 PR J: bounded Historical Repair read hold

Status: isolated implementation. No Production service or database was changed.

## Scope

This PR closes one concrete gap in Strategy A. The existing transaction already
holds all 16 approved writers before backup and holds these four read services
before the first source mutation:

- `com.stockboard.web`
- `com.stockboard.analog-search`
- `com.stockboard.friend-readonly-gateway`
- `com.stockboard.web-health`

The read snapshot remains active through source publication, derived rebuild,
Serving verification and service resume. Trigger is part of the writer
inventory and is therefore held by the outer maintenance barrier.

The missing contract was repeated proof that the approved services remained
unloaded and that the Production DB, WAL and SHM had no open handle. The new
read-isolation probe runs at six mutation/publication boundaries:

1. after the four read services are held;
2. immediately before insert;
3. after data commit and before Source publication;
4. before derived rebuild;
5. after derived rebuild;
6. after Serving verification and before read-service resume.

Every receipt records the Transaction ID, stage, timestamp, exact four-service
inventory and a zero handle count in the existing transaction journal. A missing Production
probe, changed reader inventory, loaded service, surviving process identity,
unknown same-user DB/WAL/SHM handle or malformed receipt fails closed. Handles
owned by identities that the repair operator cannot observe remain UNKNOWN and
must be excluded by the Production operating boundary.

The approved read-service-resume recovery uses an explicit
`READ_SERVICE_RECOVERY` verification mode. It revalidates Source/Serving and
health but does not require the four services to still be unloaded, because the
recoverable failure can occur after launchd has already loaded them. The normal
forward path always uses `FORWARD` and retains the final isolation probe.

## Responsibility and reuse

`lib/jp-ohlcv-repair-read-isolation.ts` owns only the pure read-isolation
decision. Launchd observation and `lsof` remain in the existing
`launchd-writer-hold-driver`; transaction sequencing remains in the existing
repair runner. No second service manager, handle parser or state machine was
added.

The Production entrypoint supplies the probe from the sealed execution
configuration. The exact Node executable, physical `tsx` CLI, clean Git commit
and tree, immutable runtime manifest, physical `node_modules`, LaunchAgent
definitions and DB path remain covered by the existing package contracts. The
repair package does not invoke `npx`.

The adapter executes each precondition before opening the write transaction or
starting the external derived command. The runner then validates the returned
Transaction-bound receipt before advancing the journal. The runner validation
is defense-in-depth evidence validation; for stages whose work has completed by
the time the adapter returns, a failure transitions to HOLD rather than
retroactively preventing that work.

## Isolation evidence

The executable-plan E2E uses the normal repair runner and verifies journal
sequencing with a deterministic probe fixture. A separate macOS regression
opens real DB, WAL and SHM file descriptors and exercises the Production `lsof`
parser: the open handles are rejected, and the same paths pass after the
descriptors close.
Together these tests verify:

- 4,067 approved keys;
- six exact rows already satisfied;
- 4,061 insert-only rows;
- `1447` and `2164` preserved;
- Source and Serving publication;
- derived rebuild and service resume;
- all six read-isolation receipts in the archived journal;
- duplicate execution rejection;
- rollback crash recovery.

Negative tests reject an incomplete reader inventory, a loaded read service, an
unknown database handle and a receipt for the wrong boundary.

## Deliberate limits

This is a bounded Strategy A maintenance hold. It does not turn ordinary daily
ingestion into a long outage, and it does not claim zero-downtime publication.
An unregistered process can still attempt to open the live DB between probes;
the current application has no system-wide admission control
that can prevent that race. Production use therefore still requires an observed
process/handle inventory and an operational ban on ad-hoc access. Versioned
Serving remains the durable daily-publication boundary.

The rollback path retains its existing stricter restore barrier, which checks
all held writer/read services and all primary, WAL, SHM, temporary and failed
restore artifacts. This PR does not replace or broaden that recovery contract.

## Change accounting

- Added one small domain contract and one focused test.
- Reused the existing LaunchAgent driver, `lsof` parser, runner stages and
  journal.
- No reader, schema, cache, updater, Production package or service definition
  changed.
- Temporary code retirement: this contract can be removed from daily paths once
  all affected readers consume immutable Versioned Serving; Historical Repair
  may retain it as a maintenance guard.

