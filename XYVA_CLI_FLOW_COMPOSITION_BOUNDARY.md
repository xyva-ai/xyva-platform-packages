# XYVA CLI Flow composition boundary

Status: `EXTERNAL / FLOW-RUNTIME-SCOPE`

The local XYVA agent is the only approved transport for `ProviderCliBridgeV1`.
The `xyva-flow` branch now contains a typed `ProviderCliModelProvider` adapter
which maps Flow's existing model-provider boundary to that local-agent contract.
The adapter is dependency-injected and the default runtime composition does not
create an authenticated client yet; production execution therefore remains
fail-closed until pairing, entitlement and cancellation wiring are reviewed.

Consequences:

- No provider credential, CLI process, or provider session is created by Flow.
- Tenant and Foundation-entitlement checks must happen before a task is created.
- The Flow runtime extension must call the local agent contract, preserve
  request IDs and cancellation, and be reviewed independently before enabling
  the product path.
- UI-only mocks and hosted synthetic browser results do not close this gate.

This document is an explicit release boundary, not a claim of completed Flow
runtime execution.
