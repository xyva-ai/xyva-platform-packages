# @xyva/agent

Local test agent for xyva.ai.

The agent keeps repository access, Playwright execution, Swarm QA, and local credentials on the machine that runs your tests while the xyva portal handles auth, billing, teams, and reporting.

## Quick start

```bash
npx @xyva/agent login
npx @xyva/agent start
```

CI and disposable test machines can provide `XYVA_AGENT_TOKEN` and
`XYVA_AGENT_EMAIL` to `npx @xyva/agent login` instead of placing the token in
the process command line.

## Commands

- `npx @xyva/agent login`
- `npx @xyva/agent start --port 7900`
- `npx @xyva/agent status`
- `npx @xyva/agent logout`

## Requirements

- Node.js 22 or newer
- an xyva portal account
- an active subscription or trial in the portal

## Authorized test use

Run the Agent only against systems you own or are explicitly authorized to test.
The `deep-audit` preset can enter synthetic security-test strings into forms and
may submit those forms. Use a disposable, non-production target with test
accounts and review the selected scan preset before execution.

## Notes

- the agent exposes a localhost-only bridge for the portal
- project files, test execution, and BYOK credentials stay local
- the terminal displays separate, single-use QA Studio and Flow pairing tokens valid for five minutes; a Flow token is rejected by the generic QA refresh endpoint
- Flow first sends the SHA-256 hash plus a token-derived, selected-port-bound client proof to the loopback Agent and verifies the returned 30-second HMAC challenge in the browser. Only then does Flow obtain its one-time entitlement grant and send the verified challenge proof plus grant to the Agent; `/auth/flow/pair` never receives the raw pairing token and Flow persists neither token nor proof
- the Agent requires its independently verified local license before it atomically consumes the Flow grant over HTTPS; the resulting origin- and capability-bound Flow session family expires after at most five minutes and cannot be redeemed by QA Studio or another pairing token
- production browser access is restricted to the exact QA Studio and Flow origins during the product migration; arbitrary `*.xyva.ai`, opaque `null`, and foreign origins are rejected
- additional browser origins must be classified explicitly with `XYVA_AGENT_QA_ORIGINS` or `XYVA_AGENT_FLOW_ORIGINS`; the legacy `XYVA_AGENT_PRODUCT_ORIGINS` allowlist alone grants no bridge capability
- the listener port is restricted to `7900`, `7901`, or `7902` by default; an operator may replace that bounded list with up to eight canonical ports through `XYVA_AGENT_ALLOWED_PORTS`
- Flow pairing uses a short-lived, origin/product/port-bound proof challenge; the raw Flow pairing token is never sent to `/auth/flow/pair`
- stored portal, integration, AI, and Swarm credentials are AES-GCM-encrypted with a per-installation random key and private user-only files under the agent state directory
- the encryption key and ciphertext are both machine-local agent state; this protects against accidental plaintext inspection, but not against an attacker or backup that can read the complete user profile or agent state directory. OS-keychain-backed sealing is not part of this Alpha contract
- offline licenses are Ed25519-signed by xyva, bound to the installation id and require a successful portal heartbeat at least every 72 hours
- portal guides live at `https://docs.xyva.ai/guide/portal-agent-setup.html`

The supported release path is npm on Windows, Linux, and macOS. Optional portable downloads are
not part of the public release contract.

## Local AI providers

The agent can use an already running local Ollama or LM Studio/Bionic server for model listing and chat.
Bionic is a separate app powered by the LM Studio runtime, not a renamed provider.
It may install the same `lms` tooling and model runtime, while XYVA deliberately
keeps the stable provider ID `lmstudio` and the same API contract.
It only calls the fixed loopback endpoints `http://127.0.0.1:11434` (Ollama) and
`http://127.0.0.1:1234` (LM Studio/Bionic). Remote URLs, URL credentials, redirects, and arbitrary
provider endpoints are deliberately not supported by this local-provider path. Provider keys are
not sent with these requests.

For hosted provider access, the agent supports OpenAI/Codex, Anthropic/Claude and Google/Gemini
through their fixed official HTTPS endpoints. A provider key is required for each request and is
sent only to that provider's documented authorization header; custom cloud endpoints, proxy URLs,
redirects and cross-provider credential forwarding are not supported.

The provider setup is product-neutral, so Flow does not depend on opening QA Studio first:

```bash
npx @xyva/agent provider status
npx @xyva/agent provider configure ollama --model gemma3:4b
npx @xyva/agent provider configure lmstudio --model local-model
npx @xyva/agent provider configure openai --model gpt-5
npx @xyva/agent provider grant ollama --product flow --yes
```

For LM Studio/Bionic, start the API explicitly on loopback without CORS, for
example `lms server start --port 1234 --bind 127.0.0.1`. Models are discovered
per operating-system account; a model directory owned by another macOS user is
not automatically part of the current agent's library.

For OpenAI, Claude and Gemini, `provider configure` asks for the API key through a hidden
interactive terminal prompt when no key exists or `--replace-key` is supplied. Keys are never
accepted through a `--key`/`--api-key` option, positional argument, pipe, or provider-specific
environment variable. A new or replaced key is checked through that provider's fixed model-list
endpoint before it is stored. Local providers never accept a key. `provider status` reports only
`keyConfigured` and the non-secret Flow grant state; it never prints credential values. Provider
configuration and Flow consent are separate: every provider starts denied to Flow and requires
`provider grant <provider> --product flow --yes`. Use `provider revoke <provider> --product flow --yes`
to withdraw that consent without deleting QA Studio configuration. Replacing or removing a cloud
key withdraws its Flow grant; deleting a provider removes model, key, and grant atomically. To
remove one model and its stored cloud key, use `provider delete <provider> --yes`.

QA Studio and Flow use this same five-provider contract. Each product still receives a separate,
origin-bound Agent session; a pairing, refresh, or socket token issued to one product cannot be
reused by the other. The versioned bridge methods `providerListModelsV1`, `providerInferV1` and
`providerCancelV1` accept only the credential-free `@xyva/contracts` shapes. Provider keys and
fixed local/cloud endpoints never cross that bridge. A Flow session is authorized for exactly
those three V1 methods; QA-only filesystem, Git, runner, provider-configuration, and administrative
methods remain unavailable to Flow. The public Flow Builder does not receive this capability until
product login, entitlement, an explicit local Flow pairing, and a separate grant for the selected
provider are all present. A configured provider is not an implicit Flow authorization.
The browser entitlement grant is automatic after the user starts pairing, remains only in memory,
expires after 60 seconds, and is challenge-bound to that exact local Flow pairing token. Agent
reconnection after the five-minute family lease requires a new browser-session check and grant;
Flow never receives the Agent license token and the Agent never receives the Flow browser cookie.
