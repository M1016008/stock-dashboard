# Phase 2 PR I: Claude Code independent review

Status: Draft technical GO. Production HOLD.

Claude Code reviewed the updater process entry, Source Run recovery, registered
child wrapper, process E2E, CI wiring, and architecture evidence independently
from the Codex implementation.

Final finding counts:

- P0: 0
- P1: 0
- P2: residual operational/design items only

The review confirmed:

1. Source Run and sync Run start and terminal failure transitions are atomic.
2. Process probes normalize UTC/C locale; a probe error is `UNKNOWN` and holds.
3. Derived refresh starts only after its dedicated process group is sealed.
4. Parent death retains descendant liveness evidence; wrapper death with a live
   parent cannot clear the identity before the complete group is absent.
5. Recovery never promotes an ambiguous Run to `success` and preserves the
   prior successful Source row snapshot.
6. The E2E exercises a live owner across `Asia/Tokyo` and `UTC`, actual `ps`
   stderr failure, pre/post-Receipt crash, orphan descendants, zero insert,
   known/new conflicts, Provider failure, Corporate Action, CAS failure,
   derived/publication failure, and rerun.

Residual P2 items include conservative manual recovery for failures outside the
normal terminal path, macOS-only process semantics, and a possible false HOLD
after hostname or process-group reuse. These fail closed.

Production remains HOLD because direct readers and caches can observe live DB
rows before Source publication. This PR does not implement the Strategy A read
hold or Versioned Serving and does not claim that blocker is resolved.
