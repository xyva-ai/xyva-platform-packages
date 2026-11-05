# XYVA CLI Flow composition boundary

Status: `EXTERNAL / FLOW-RUNTIME-SCOPE`

The local XYVA agent is the only approved transport for `ProviderCliBridgeV1`.
Flow may create versioned task, result, error, and cancellation contracts, but
the current `xyva-flow` checkout does not contain a production runtime executor
for these CLI tasks. Its existing provider integration remains the authoritative
contract boundary and is not replaced by a second CLI engine.

Consequences:

- No provider credential, CLI process, or provider session is created by Flow.
- Tenant and Foundation-entitlement checks must happen before a task is created.
- A future Flow runtime extension must call the local agent contract, preserve
  request IDs and cancellation, and be reviewed independently before enabling
  the product path.
- UI-only mocks and hosted synthetic browser results do not close this gate.

This document is an explicit release boundary, not a claim of completed Flow
runtime execution.
