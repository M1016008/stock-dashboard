# ADR: known historical conflicts and future JP Source publication

Status: Proposed. No publication policy change is implemented by this ADR.

## Options

### A. Stop every JP publication until 1447 and 2164 are adjudicated

- Strongest and simplest fail-closed behavior.
- Prevents all normal future sessions from becoming publishable.
- Appropriate while readers cannot interpret issue scope.

### B. Quarantine the two historical keys and publish later clean sessions

- Preserves the existing values and never converts their conflict to success.
- A future session may publish only when Missing Coverage is complete, it has no
  new conflict, and the only open issues are explicitly sealed quarantine keys.
- Every Reader, cache, health check, and Serving manifest must surface the
  quarantine scope. A request whose calculation window includes a quarantined
  key must return conflict evidence or a bounded unavailable result; it may not
  silently treat the value as verified.

### C. Adjudicate the two values under a separate approval

- Compare original provider payload, Price Basis, Corporate Action lineage, and
  stored bytes under a dedicated immutable plan.
- Resolves the issue only after an independently approved insert/update policy.
- No automatic overwrite is permitted.

## Recommendation

Use B as the target policy and C as the eventual data-quality resolution path.
Production must behave as A before another source mutation, but the current
updater does not itself enforce the required read-service hold. B must not be enabled until the Source/Reader lineage
inventory is migrated to a versioned Serving manifest and all affected Readers
interpret quarantine scope. `PARTIAL_HOLD` must not be renamed to `success`.

## Required transition test

The enabling PR must prove clean future publication, a quarantined-window read,
a non-quarantined read, cache rebuild, health reporting, and rollback without
changing 1447 or 2164. This ADR alone grants no Production permission.
