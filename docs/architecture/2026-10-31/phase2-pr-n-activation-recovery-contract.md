# Phase 2 PR N: activation recovery contract evidence

Status: isolated technical gate pending independent review and CI. Production
remains `HOLD`.

## Scope

This change completes missing contracts around the PR #46 durable activation
primitive. It does not add another Recovery state machine, execute a swap,
change Production, or clear evidence artifacts.

| Concern | Result |
| --- | --- |
| Restart approval | A typed hash contract now binds Transaction ID, current journal canonical/file hashes, old/new manifests, active integrity receipt, barrier receipt hash, exact no-swap transition, 15-minute validity, and automatic-action prohibitions. The Production authority that issues and seals that object is not wired in this PR. |
| Blocking artifacts | Pending and temporary files receive a read-only classification receipt: `CLEAN`, `WRITE_NOT_PUBLISHED`, `PUBLISHED_PENDING_CLEANUP`, or `AMBIGUOUS`. The receipt explicitly authorizes no destructive action. |
| Concurrent journal writes | Two independent Node processes start from the same `PREPARED` journal. Exactly one acquires the pending artifact and the other is rejected. |
| Second CAS | A separate adversarial process changes the journal after pending intent fsync; the writer rejects the transition at the pre-publish CAS boundary. |

## Recovery approval

`AtomicBundleRecoveryApproval` permits only
`RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP`. It cannot invoke swap or swap-back.
The approval is valid only for the byte-verified `SWAP_INTENT + NEW_ACTIVE`
observation whose journal, manifests, integrity receipt, and barrier receipt are
sealed in the object. Arbitrary 64-character strings, unrelated Transactions,
changed manifests, changed barrier evidence, expired approvals and approvals
longer than 15 minutes fail closed.

Expiry is evaluated against the adapter's wall clock after byte-identity
inspection. The transition timestamp is also generated there, so a long
Production inspection cannot be bypassed with a caller-selected historical
clock and cannot accidentally consume a proof that expired during inspection.

The approval object is intentionally separate from the existing activation
journal. The adapter proves the supplied object matches one existing transition;
it is not itself proof that an authorized operator or approved package issued
the object. Production remains blocked until the package contract seals this
approval hash and the independently produced barrier receipt. This is not a
second state machine.

## Pending and temporary artifacts

The read-only classifier preserves evidence and never deletes, renames, swaps,
or resumes a transition. It rejects symlinks, insecure files, malformed intent,
temporary phase/SHA disagreement and a journal that changes during the scan.
It remains point-in-time evidence, not continuous admission control.
Classification rules are:

| Classification | Observable condition | Allowed automatic action |
| --- | --- | --- |
| `CLEAN` | no pending or temporary artifact | none |
| `WRITE_NOT_PUBLISHED` | current journal equals pending previous SHA and exactly one valid temporary equals pending next SHA | none |
| `PUBLISHED_PENDING_CLEANUP` | current journal equals pending next SHA and no temporary remains | none |
| `AMBIGUOUS` | corrupt, symlinked, missing, multiple, or contradictory evidence | none |

Production cleanup remains P1. The `checkedAt` field is descriptive, not proof
of freshness; a future executor must run the classifier again under its
approved barrier immediately before an archive operation. The approved
procedure must bind a future
operator approval to this classification receipt, Transaction, every artifact
hash, destination archive, and expiry; archive artifacts durably before removing
their blocking names; then reclassify from a fresh process. Manual deletion and
automatic retry remain prohibited. That executor is deliberately not added in
this PR.

## Independent-process results

The fixture now exercises actual independent Node processes rather than nested
callbacks:

- two independent intent writers coordinated so the second attempts while the
  first holds the pending artifact: one success, one fail-closed rejection;
- second-CAS displacement: fail closed with the external `HOLD` journal kept;
- SIGKILL after the temporary journal write but before its fsync:
  `WRITE_NOT_PUBLISHED`;
- directory-fsync failure after publication: `PUBLISHED_PENDING_CLEANUP`;
- corrupt, unrelated, overlong and expired approval objects: rejected;
- normal approval-bound restart observation: records `SWAPPED` without calling
  the swap helper.

These results are fixture-scale software-crash evidence. Physical power loss,
OWC controller behavior, and Production admission remain unverified.

## Production integration evidence

Read-only observation at 2026-11-01 15:37 JST confirms:

- direct database path:
  `/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`;
- 19 LaunchAgent plists contain that path; 16 are loaded and 3 unloaded;
- Trigger PID `88798` runs `node --import tsx` from the mutable
  `/Users/yoshio/dev/stock-dashboard-release-7df6c23` checkout and holds the
  DB/WAL/SHM;
- a callback and finite `lsof` scans do not prevent a later same-user handle;
- active Reader/Cache processes do not yet publish a sealed generation
  observation consumed by this adapter.

Therefore cross-process admission and actual Reader/Cache generation
convergence are Production P1 blockers. The existing caller-supplied generation
arguments are not promoted to trusted Production evidence.

## OWC read-only retention and capacity evidence

At 2026-11-01 15:37 JST, OWC is APFS UUID
`11FDA3F5-D89E-414D-9B95-C2069FF0B204`, total
`4,000,577,273,856` bytes, and free `979,990,446,080` bytes. Four retained files
each report logical size `551,171,977,216` bytes:

1. active `stockboard.db`, inode `1961766`;
2. failed Transaction `1793380144053-98117`, inode `5648`;
3. Backup `1793380144053-98117.sqlite`, inode `1956847`;
4. Backup `1793348893462-59084.sqlite`, inode `1934886`.

No file was created, cloned, changed, or removed. Per-file block counts are close
to logical size but do not prove unique physical allocation on APFS. The
conservative 1.10 TB admission threshold is short by `120,009,553,920` bytes.
Retention-approved cleanup could release enough capacity, but no artifact may
be selected from metadata alone. Additional same-container capacity or an
approved retention decision is required before OWC-scale CoW/ENOSPC testing.

The options are not equivalent:

1. Retention-approved removal could close the 120 GB threshold gap, but only
   after every Backup/Restore/Audit dependency and rollback obligation is
   resolved by exact identity. No current artifact meets that deletion gate.
2. A separate test volume can host scale and fault-injection evidence, but it
   cannot prove same-container `RENAME_SWAP`, OWC controller latency, or OWC CoW
   allocation.
3. Additional capacity in the Production APFS container best matches the final
   swap boundary, but provisioning and every test write require a separate
   Production/OWC approval.

## P2 reclassification

| PR #46 review item | Current status | Production impact |
| --- | --- | --- |
| Opaque approval hash | `PARTIAL`: typed object and strict hash/time/operation checks replace the bare SHA | Issuing authority and Package/barrier-receipt wiring remain P1. |
| Restart negative coverage | `VERIFIED` for unrelated/expired/overlong approvals | Physical restart remains `UNKNOWN`. |
| Coordinated two-process lock contention | `VERIFIED` in fixture | Production filesystem behavior remains scale-dependent. |
| Second CAS boundary | `VERIFIED` in fixture | none beyond scale evidence. |
| Caller-supplied generations | `HOLD` | P1: observe actual Reader/Cache generations. |
| Blocking artifact recovery | `PARTIAL` | P1: read-only classification exists; approved archival executor does not. |
| Cross-process barrier | `HOLD` | P1: the current barrier receipt is opaque to this adapter and there is no continuously enforced admission across all 19 consumers. |

## Code quality

The change adds one approval contract, extends the existing durable adapter,
and expands its existing fixture. It adds no state-machine phase and no
orchestrator. The read-only artifact classifier is permanent only if Candidate
activation is approved; the fixture remains test-only. Production-specific
inventory and retained-artifact evidence stay documentation, not runtime code.
