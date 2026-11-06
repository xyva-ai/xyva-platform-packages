# Provider CLI Bridge V1 — Implementation Report

Date: 31 October 2026 (Europe/Lisbon)
Implementation branch: `codex/provider-cli-bridge-v1`
Base commit: `29cfb7d6c2d5de2b9a3f3d128dfcbcb9bb2564fe`
Implementation revision: the commit containing this report; resolve the exact
review revision with `git rev-parse codex/provider-cli-bridge-v1`.
Base relationship: isolated from PR #21 (`codex/ai-cli-secure-store-ci-stack-v2`);
it is not merged and must be independently rebased/reviewed against the
current Foundation security branch before any integration decision.

## Scope and boundary

This change creates a separate, versioned `ProviderCliBridgeV1` for a
**Codex-only, read-only, local test pilot**. It does not modify
`ProviderBridgeV1` semantics: that existing API/local bridge continues to use
its five provider identities and never treats `codex` as a local CLI.

The bridge accepts no caller-provided executable, arguments, environment,
working directory, API key, token, session, endpoint or model value. It sends
the validated prompt and request ID only to the existing trusted Codex adapter,
which retains its shell-free process invocation, fixed read-only sandbox,
bounded stdout/stderr, timeout, cancellation and temporary-directory cleanup.

## Product authorization model

`providerCliCapabilitiesV1`, `providerCliInferV1` and
`providerCliCancelV1` are unavailable without an origin-bound bridge context.
Flow's `provider-bridge.v1` context is restricted to its existing methods and
cannot invoke any CLI method. A QA Studio request then requires both:

1. `XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE=1` in the local Agent
   process environment; and
2. an explicit local, non-secret `qaCliProviderGrants=["codex"]` consent set
   with `provider cli grant codex --product qa-studio --yes`.

Both are default-deny. Revocation is `provider cli grant codex --product
qa-studio --revoke --yes`. The environment switch is intentionally not
persisted. The consent is not an API key, does not log in, and does not read
provider session files.

## Interface and failure behavior

New contracts are `packages/contracts/src/providers/cli-v1.ts`; the typed
consumer is `packages/bridge-types/src/provider-cli-bridge-v1.ts`. The only
provider identity is `codex`, and the only execution mode is `read_only`.
Exact-object validation rejects unknown fields, including secret-shaped process
controls. Completion, cancellation and stable secret-free failure outcomes are
validated at both bridge edges.

Cancellation is request-ID scoped to the owning WebSocket. A second socket
cannot cancel the request, closed sockets abort their own work, and completed
requests fail closed for later cancellation. Adapter exceptions are mapped to
stable codes and are not reflected verbatim.

## Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Contract validation | PASS | new `provider-cli-contracts-v1.test.ts` rejects other CLI IDs, write modes, unknown/secret fields and malformed outcomes |
| Typed consumer | PASS | new `provider-cli-bridge-client-v1.test.ts` validates every request and response identity |
| Default-deny/local consent | PASS | fake bridge test covers disabled environment and absent QA consent |
| Product isolation | PASS | unpaired and Flow contexts receive unavailable methods; QA is separately gated |
| Fake process E2E | PASS | fake adapter verifies capability, request payload, success and error mapping |
| Cancellation/session isolation | PASS | fake adapter verifies own-socket cancel, cross-socket denial and completed-request fail-closed behavior |
| Adapter/security regression | PASS | existing CLI, provider bridge, cancellation and hardening tests passed |
| Full public verification | PASS | `npm run verify:public`: 186 pass, 5 pre-existing documented skips |
| QA Studio browser/product E2E | NOT_EXECUTED | typed client is prepared; no browser product change was authorized in this slice |
| Native Windows CLI E2E | NOT_EXECUTED | VM 100 has no CLI executable and no install/login was authorized |
| Commercial/provider terms | NOT_EXECUTED | no commercial approval requested or implied |
| Release/merge/deployment/publish | NOT_EXECUTED | explicitly out of scope |

Executed commands:

```text
npx vitest run tests/backend/agent-provider-cli.test.ts \
  tests/backend/agent-cli-auth.test.ts \
  tests/backend/agent-provider-bridge.test.ts \
  tests/backend/agent-ai-bridge-cancellation.test.ts \
  tests/backend/agent-security-hardening.test.ts \
  tests/backend/provider-contracts-v1.test.ts \
  tests/backend/provider-bridge-client-v1.test.ts \
  tests/backend/provider-cli-contracts-v1.test.ts \
  tests/backend/provider-cli-bridge-client-v1.test.ts \
  tests/backend/agent-provider-cli-bridge.test.ts
# 94 passed

npm run verify:public
# 186 passed, 5 documented skips
```

## Deliberately excluded

No Claude Code or Gemini CLI inference is exposed. No provider CLI was
installed, updated, logged into, or invoked by this implementation test. No
new subscription, quota, API key, OAuth/session state, deployment, release,
publication or merge was used. The prior macOS Codex smoke remains separate
adapter evidence and was not repeated here.

## Remaining gates

The development slice is reviewable but not release-ready. Before integration,
perform an independent security review, rebase against the current secure-store
Foundation line, run a real QA Studio browser E2E with an explicitly authorized
local test activation, and separately obtain native Windows 11 Codex CLI
evidence. The existing Foundation P0, Windows 11 device, ARM64 and evidence
retention gates remain unchanged.
