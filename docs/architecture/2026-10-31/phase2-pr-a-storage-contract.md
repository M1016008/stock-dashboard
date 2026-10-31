# Phase 2 PR A: SQLite integrity and APFS candidate contract

## Scope

This change is the first stacked Phase 2 change. It does not activate a candidate database,
change a generation, or implement rollback. It establishes two reusable storage contracts:

1. Evidence receipts distinguish a fully checked backup, a fully checked post-write candidate,
   and a byte-identical restore.
2. APFS candidate creation uses `clonefile(2)` directly. It cannot fall back to a physical copy.

## Verification contracts

| Receipt | Required proof | Reused proof | Not proved |
| --- | --- | --- | --- |
| `BACKUP_COMPLETE` | Whole-file `PRAGMA quick_check`, measured SHA-256, immutable file identity | None | Business lineage, reader readiness |
| `CANDIDATE_POST_WRITE` | Whole-file `PRAGMA quick_check`, measured SHA-256, sealed parent receipt | Parent backup identity | Source/Serving publication, reader readiness |
| `RESTORE_IDENTITY` | Measured SHA-256 and size equal the sealed `BACKUP_COMPLETE` artifact | The backup's whole-file quick check | Service readiness, semantic lineage |

`quick_check` is deliberately named `WHOLE_FILE_QUICK_CHECK`; it is not presented as a substitute
for semantic checks or SQLite `integrity_check`.

## APFS candidate safety

- The clone helper is a small sealed executable that calls `clonefile(2)` with no copy fallback.
- Source receipt, source stat identity, sidecar absence, helper identity and Writer Barrier are checked
  before and after cloning.
- Source and candidate are hashed and compared.
- Capacity includes initial allocation, bounded copy-on-write growth, failed-state retention and the
  minimum storage reserve. Zero-value budgets cannot silently disable the gate.
- Files ending in SQLite sidecar names are rejected as candidate paths.
- This layer does not switch the live database. Atomic activation and crash recovery remain a
  separate stacked PR and remain a Phase 2 blocker.

## Evidence

- `npm run test:sqlite-apfs-candidate`: PASS
- `npm run storage:guard-test`: PASS
- `tsc --noEmit`: PASS
- Claude Code independent review after revision: P0=0, P1=0, P2=6; four operational P2s were
  corrected before final verification. Remaining evidence-authority limitations must be resolved
  when the receipt producer is integrated into the repair orchestrator.

No Production database, service, generation or runtime was changed.
