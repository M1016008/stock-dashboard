# Phase 2 PR M: durable activation evidence

Status: Draft technical gate pending independent review and CI. Production
remains `HOLD`.

## Scope and responsibility

This change adds one filesystem adapter around the PR #45 activation state
machine. It does not add a Recovery orchestrator, Production package, DB path
migration or service operation.

| Module | Responsibility |
| --- | --- |
| `apfs-atomic-sqlite-bundle.ts` | pure bundle identity, position and transition rules |
| `durable-atomic-bundle-activation.ts` | fsync persistence, readback, receipt binding and restart observation |
| `test-durable-atomic-bundle-activation.ts` | APFS fixture crash/failure injection |

Temporary fixture directories are deleted after each run. Audit receipts stay
outside Git under `.audit/`; no Production or OWC file is created.

## Verified fixture outcomes

- durable `SWAP_INTENT` before helper invocation;
- normal swap and journal transition to `SWAPPED`;
- fresh-process restart classification;
- SIGKILL before helper: `OLD_ACTIVE`;
- SIGKILL after helper and before `SWAPPED`: `NEW_ACTIVE`;
- approval-hash-bound recording of observed post-swap state without re-swapping;
- helper timeout: `OLD_ACTIVE`;
- fsync failure: pending evidence retained and execution rejected;
- concurrent transition blocked by pending precondition; initial writer lock
  rejects `EEXIST`; stale transition is rejected by CAS;
- initial no-replace collision and stale transition CAS rejected;
- corrupt journal, manifest and integrity receipt rejected;
- corrupt full-`quick_check` receipt rejected;
- missing receipt rejected;
- post-verification candidate mutation rejected;
- WAL transition without reseal rejected;
- unrelated valid bundle produces `AMBIGUOUS` and no automatic swap.

The activation receipt binds DB/WAL/SHM hashes, the existing
`sqlite-integrity-contract` whole-file receipt, and Source/Serving/Cache
generations. The fixture actually executes `PRAGMA quick_check`; Production
must supply separately sealed executable/measurement evidence. A caller-provided
generation observation with a stale Cache generation is rejected, but Reader
and Cache observation is not implemented here and remains P1. Physical
power-loss durability remains `UNKNOWN`.

## Production path evidence

The active DB remains a direct file path consumed by 19 LaunchAgents. Plist
SHA-256 at the observation boundary:

- Web: `1b257585ecf164a5e7d5f760ba334d7c97ac3ddb6080a6a2a10a0f15370faf99`
- Analog: `adcb8f72e53d7b33ead2a9df045454d2fa177370e4d526bafc01409f162b9a79`
- Friend Gateway: `bb4489ae89bcb8bf67ce533cabcf80f5242cc11932fb3157c7857e1e763e8b24`
- Trigger: `b04c3af58d828196c389276022da1aa5fa3f78271810b00ea1e0e3079a95cada`

Web and Analog still use the mutable release checkout. Friend Gateway uses its
sealed standalone runtime. Trigger still uses `node --import tsx` from the
mutable release checkout and held DB/WAL/SHM. Path migration, immutable Trigger
runtime and Reader/cache generation convergence remain P1.

## Evidence status

| Gate | Result |
| --- | --- |
| Durable journal software-crash contract | `VERIFIED` at isolated fixture scale |
| Restart old/new/ambiguous classification | `VERIFIED` detection at fixture scale |
| Post-swap restart transition | `VERIFIED` only with explicit approval hash; no automatic swap |
| Integrity receipt and byte-identity boundary | `VERIFIED` at fixture scale |
| Concurrent journal mutation | `VERIFIED` fail-closed at fixture scale |
| Production path compatibility | `HOLD`; requires approved path migration |
| Old-inode Reader convergence | `HOLD` |
| OWC 551 GB / CoW / ENOSPC | `UNKNOWN` and `HOLD` |
| Physical power loss | `UNKNOWN` |
| Full 12-hour normal/abnormal contract | `HOLD` |
| Price Basis, Coverage bootstrap, running Run recovery | unchanged P1 |

## Independent review and code quality

Claude Code's final read-only review found `P0=0`, `P1=0` and seven tracked
P2 gaps. The Draft technical gate is `GO`; Production remains `HOLD`. The P2s
cover approval-object semantics, broader restart negatives, a true two-process
transition race, the second CAS boundary, broader generation negatives,
identity-bound pending-artifact recovery and cross-process barrier enforcement.

This PR adds one permanent adapter and one fixture harness; it does not add a
second activation state machine or Recovery orchestrator. The adapter reuses
the PR #45 state machine and the existing `sqlite-integrity-contract`. The
temporary fixture is removed after each run. Exact added/deleted lines and
dependency changes are reported from the final Git diff in the PR description.

Restart support classifies `OLD_ACTIVE`, `NEW_ACTIVE`, or `AMBIGUOUS`; it does
not choose an automatic swap or swap-back. `SWAP_INTENT + NEW_ACTIVE` can be
recorded as `SWAPPED` only after full byte verification and with an explicit
approval hash sealed into the journal. Normal durable transitions reach
`GENERATION_RECONCILED` and `COMMITTED` only after caller-supplied generation
observations match the active receipt. The Production approval object and
operator procedure remain P1 before Production use.

The software fault-injection test runs immediately before a directory `fsync`;
actual syscall/media failure and physical power loss are not reproduced.

## Removal and evolution

The durable adapter is a permanent activation component if Candidate strategy
is approved. Historical one-off JP repair packages remain separate temporary
evidence and are not imported. When all Readers use Versioned Serving, the
operational full read hold can be retired only through an independently tested
migration.
