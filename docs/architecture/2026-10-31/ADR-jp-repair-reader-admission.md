# ADR: JP Historical Repair reader admission

Status: Strategy A in-place mutation remains HOLD

## Problem

The six PR #43 handle probes prove that the four approved read services are
unloaded and that no observable handle exists at six specific boundaries. They
do not prevent a process running as the same macOS user from opening the live
database between probes. The 2026-11-01 read-only observation confirms that the
Production Trigger worker currently opens the DB, WAL and SHM as that same
user. A later `lsof` sample can detect this class of access but cannot provide
admission control.

## Options

| Option | Guarantee | Result |
| --- | --- | --- |
| More `lsof` probes | Point-in-time detection only | Rejected as a P1 resolution |
| File mode or ACL change under the same account | The owner can reopen or restore access | Rejected without an OS-account boundary |
| Separate repair/service OS identities | Kernel-enforced admission can be proven | Viable, but an operational migration outside the one-time repair |
| Build an immutable candidate, then atomically activate it | Readers cannot observe partial candidate writes; unknown old handles remain on the old inode | Preferred immediate evolution, but stale-handle and generation publication rules still need proof |
| Versioned Serving for every Reader/cache | One immutable publication manifest controls admission and rollback | Target architecture |

## Decision

Do not claim that the PR #43 bounded Read Hold prevents new same-user handles.
The current in-place Strategy A remains Production `HOLD`.

PR #43's in-place Strategy A continues to hold every approved writer and reader
from before the first source mutation through verified publication or rollback.
It remains `HOLD` because the probes do not provide admission control.

Continue measuring the APFS candidate variant only as a possible evolution:

1. stop and attest writers;
2. take a consistent source bundle while the approved readers are briefly held;
3. keep writers held for the entire build; readers may resume against an
   immutable old bundle only after a future admission/pinning contract proves
   that they cannot reopen the mutable live path, otherwise keep them held;
4. fully verify source, derived state and capacity on the candidate;
5. hold approved readers again for atomic activation and Generation publication;
6. retain the old bundle for rename-based rollback.

This removes partial-write visibility but is not yet a Production approval. The
activation contract must still prove how direct DB readers, Source/Serving
metadata, caches, journal-mode transition and old-inode handles converge. A
two-step rename with an interval in which no active path exists is not an atomic
swap and is insufficient. Ordinary daily ingestion must
move to Versioned Serving rather than inherit a long maintenance hold.

## Safety contract

- An unknown handle before source snapshot or activation remains fail-closed.
- Existing `1447` and `2164` values remain immutable pending adjudication.
- Source `success` alone never proves Serving/cache consistency.
- A reader on an old inode is reported as stale, not silently treated as current.
- No chmod, signal, process termination or service operation is authorized by
  this ADR.
