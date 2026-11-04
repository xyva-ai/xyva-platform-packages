# ProviderCliBridgeV1 — SEC-CLI-001 Remediation Report

Date: 31 October 2026 (Europe/Lisbon)
Implementation branch: `codex/provider-cli-bridge-v1`
Original reviewed commit: `8855fdec3e9ecefd8c3493b2dc85d2fab616c578`
SEC-CLI-001 fix commit: `5aa128c4c2ffaeedd25bc11c366fa0f9cc13dbd4`

## Scope

This is a narrowly scoped remediation for the independent review finding
`SEC-CLI-001`. No ProviderBridgeV1 behavior, product entitlement, provider
selection, CLI executable, provider login, Windows configuration, deployment,
or remote Git state was changed.

The historical independent review remains unchanged at
`PROVIDER_CLI_BRIDGE_V1_SECURITY_REVIEW.md` in the local primary worktree.

## Root cause

`providerCliCapabilitiesV1` awaited `cliRegistry.status()` without a local
exception boundary. A discovery rejection consequently reached the generic
WebSocket handler, which serializes `error.message` as a client-visible error.
This could disclose adapter diagnostic text, including local path-like or
credential-shaped content, to an authenticated QA Studio client.

## Change

Affected files:

- `packages/agent/src/bridge/register-handlers.ts`
- `tests/backend/agent-provider-cli-bridge.test.ts`

The capability handler now catches all `cliRegistry.status()` exceptions and
returns only this validated V1 outcome:

```json
{
  "schemaVersion": 1,
  "status": "failed",
  "requestId": "<validated-request-id>",
  "code": "adapter_error",
  "retryable": true
}
```

`adapter_error` was already a valid `CliFailureCodeV1`; no contract extension
was needed. A failed discovery is therefore fail-closed and cannot be reported
as a successful capability response. The generic WebSocket error handler was
not changed.

## Permanent WebSocket canary regression

The existing CLI bridge test now exercises the actual WebSocket handler and
response serialization with both:

1. a synchronous `status()` throw; and
2. a rejected `status()` promise.

Each synthetic error includes all of the following non-secret canaries:

```text
SEC_CLI_CANARY_DO_NOT_LEAK_001
path=/synthetic/private
token=synthetic
```

For each case the test proves that:

- `status()` was invoked through `providerCliCapabilitiesV1`;
- the response is `ok: true` with a contract-valid failed data outcome;
- the only failure code is `adapter_error`;
- no canary, path-like value, token-like value, stack marker, or top-level
  WebSocket `error` field is visible to the client; and
- a subsequent valid capability request on the same QA socket succeeds.

The test suite continues to cover unpaired denial, Flow denial, default-deny,
request validation, fake-adapter inference, cancellation and error mapping.

## Adjacent-handler check

The directly adjacent inference path already wraps `adapter.infer()` in a
local catch and maps failures to stable `CliFailureCodeV1` outcomes. The normal
cancellation path calls the in-memory `CliProcessManager.cancel()` through the
existing adapter, whose implementation returns a boolean and does not expose
an asynchronous discovery-style error source. No additional confirmed instance
of the exact `cliRegistry.status()` exception-leakage class was found. No
broader WebSocket error-protocol refactor was performed.

## Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| `SEC_CLI_001_FIX_IMPLEMENTED` | PASS | local catch at the capability-discovery boundary returns validated `adapter_error` |
| `SEC_CLI_001_CANARY_TEST_PASS` | PASS | synchronous throw and rejected-promise canaries pass through actual WebSocket serialization without leakage |
| `SEC_CLI_001_WS_RESPONSE_VALIDATION_PASS` | PASS | test invokes `validateProviderCliCapabilitiesOutcomeV1` on the emitted response data |
| `CLI_BRIDGE_SECURITY_REGRESSION_PASS` | PASS | 123 targeted tests passed; 2 documented Windows-only skips remain skips |
| `AGENT_TYPECHECK_PASS` | PASS | `npm run typecheck --workspace=@xyva/agent` |
| Public verification | PASS | `npm run verify:public`: 188 passed, 5 existing documented skips |
| `SECURITY_REREVIEW_PASS` | NOT_EXECUTED | requires a new independent review after this remediation |

Targeted command:

```text
npx vitest run \
  tests/backend/agent-provider-cli-bridge.test.ts \
  tests/backend/provider-cli-contracts-v1.test.ts \
  tests/backend/provider-cli-bridge-client-v1.test.ts \
  tests/backend/agent-cli-adapters.test.ts \
  tests/backend/agent-security-hardening.test.ts \
  tests/backend/agent-provider-bridge.test.ts \
  tests/backend/agent-ai-bridge-cancellation.test.ts \
  tests/backend/agent-product-origins.test.ts \
  tests/backend/agent-server.test.ts \
  tests/backend/agent-flow-entitlement.test.ts \
  tests/backend/agent-flow-pairing-proof.test.ts
# 123 passed, 2 Windows-only skips

npm run typecheck --workspace=@xyva/agent
npm run verify:public
# 188 passed, 5 existing documented skips
```

## Remaining risks and exclusions

This remediation does not close the previously documented evidence gaps:

- Codex read-only sandbox confidentiality and prompt-injection resistance;
- native Windows 11 `.cmd` launcher and process-tree cleanup evidence;
- QA Studio browser E2E;
- commercial/provider terms review; and
- release, deployment, merge and publishing authorization.

No real provider inference, new provider login, session-file access,
installation, push, PR, merge, release, deployment or Windows-system change
was performed.

## Next step

Request a fresh independent, non-destructive security re-review of commit
`5aa128c4c2ffaeedd25bc11c366fa0f9cc13dbd4`. That review may assess only the
closed SEC-CLI-001 boundary and must keep the remaining gates separate.
