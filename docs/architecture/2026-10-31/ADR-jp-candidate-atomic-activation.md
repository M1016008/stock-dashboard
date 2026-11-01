# ADR: JP candidate atomic activation

Status: isolated fixture `PARTIAL`; Production `HOLD`

## Decision

Build and fully verify an immutable SQLite candidate before publication. Publish
the complete bundle by swapping two sibling directory entries with
`renameatx_np(..., RENAME_SWAP)` on one APFS filesystem. Do not use two
sequential renames, and do not retry a failed or ambiguous swap automatically.

This is a publication primitive, not a complete Production repair. The
Source/Serving generations in the active bundle manifest, external generation
records, every Reader/cache, and the activation journal must agree before read
services resume. A stale Reader on an old inode is a HOLD, not a successful
publication.

## Bundle contract

Each bundle contains:

- `stockboard.db`;
- optional `stockboard.db-wal` and `stockboard.db-shm`, present as a pair;
- a canonical manifest with member hashes, Source/Serving generations,
  observed SQLite journal mode, and the full-integrity receipt hash.

The candidate is verified in `DELETE` mode with no sidecars. A later transition
to `WAL` changes the database header and therefore requires a fresh manifest
and integrity boundary before publication. The transition cannot be hidden
inside service startup.

The activation journal is stored outside both swapped directories and seals the
old and new manifest hashes. At `SWAP_INTENT`, the manifests uniquely classify
the filesystem as `OLD_ACTIVE`, `NEW_ACTIVE`, or `AMBIGUOUS`. `AMBIGUOUS` always
fails closed and requires an independently approved recovery.

This PR defines and validates the journal transitions in memory. Durable
journal write/fsync/readback remains unimplemented and is a Production blocker;
the ADR describes the required location, not a completed persistence adapter.

## Isolated evidence

The committed fixture compiles the native helper from source, verifies APFS
advertises `VOL_CAP_INT_RENAME_SWAP`, and checks the post-swap directory inodes.
It exercises:

- successful directory-entry swap;
- SIGKILL at the orchestrator barrier immediately before invoking the helper and
  immediately after the helper returns;
- helper timeout before a swap;
- unknown/tampered manifests;
- Source/Serving mismatch;
- explicit `DELETE` to `WAL` resealing;
- an open SQLite Reader across the swap.

The open Reader continued to read the old value while a new connection to the
same active path read the new value. This is expected inode behavior and proves
that atomic rename does not replace Reader admission, reconnect, or cache
generation checks.

The auditable run receipt records the implementation commit, Node/helper/harness
hashes, input DB and manifest hashes, and whether tracked files were clean. Its
timestamps and durations intentionally make each run unique. The final receipt
remains outside Git under `.audit/phase2-atomic-candidate`.

For implementation commit `8b1d837b81531e1d593cd70a65a46c413a54a02a`,
the receipt file SHA-256 is
`c36676b4850d0098edfb6c70c64269037b1d4e47fb5d6ae291ab637ab2e44ee3`
and its canonical receipt SHA-256 is
`9ea8914e25121d993a065b8d7c80513053662a9643a71e07a0350ea69dace204`.

## Guarantees and limits

| Condition | Status | Evidence / limit |
| --- | --- | --- |
| macOS API and SDK support | `VERIFIED` | macOS 26.3.1 SDK exposes `renameatx_np` and `RENAME_SWAP` |
| APFS swap on isolated host filesystem | `VERIFIED` | native helper checks volume capability and exchanged inodes |
| Process SIGKILL around helper invocation | `VERIFIED` | library path and sealed journal classify old before invocation and new after helper completion |
| Interruption inside syscall / physical power loss | `UNKNOWN` | parent `fsync` is implemented; `F_FULLFSYNC` and hardware loss are not proven |
| Bundle member and journal-mode identity | `VERIFIED` | manifest seals DB/WAL/SHM metadata and hashes; SQLite header bytes prove DELETE/WAL without opening the DB; unlisted sidecars are rejected |
| Old-inode Reader behavior | `VERIFIED` | stale connection retained old data after swap |
| Generation reconciliation contract | `PARTIAL` | pure gate rejects mismatch; current Production Readers do not all consume it |
| Durable activation journal | `UNKNOWN` | phase ordering is validated; persistence and crash readback are not implemented |
| OWC filesystem support, CoW, ENOSPC | `UNKNOWN` | no file or clone was created on OWC; separate approval required |
| 551 GB bundle swap and rollback | `UNKNOWN` | fixture scale only |
| Full Reader/cache reconnection | `HOLD` | direct Readers and mutable Trigger runtime remain open P1 items |

## Recovery rule

The swap helper has no copy fallback. If the syscall, inode verification, or
parent-directory fsync reports failure, the orchestrator preserves both bundle
paths and the journal. It must inspect the sealed manifests and request a new
hash-bound approval; it must not invoke swap again automatically.

## Maintenance impact

Replacing the existing 30-minute post-activation rollback reserve with a
future proven five-minute swap-back stage would change the PR #44 arithmetic projection
from about 650.36 minutes to 625.36 minutes, leaving about 94.64 minutes in the
12-hour window. That is only a model. It is not a GO because the five-minute
OWC/551 GB bound, full derived workload, service restoration, ENOSPC, and power
loss recovery are not yet measured.
