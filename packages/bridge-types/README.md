# @xyva/bridge-types

Shared bridge protocol types for the xyva SaaS portal and the local `@xyva/agent`.

## Install

```bash
npm install @xyva/bridge-types
```

## Purpose

- request and response contracts for the local agent bridge
- shared protocol constants such as `BRIDGE_PROTOCOL_VERSION`
- runner, swarm, recon, config, and license payload types
- `ProviderBridgeClientV1`, the product-neutral runtime client used by QA Studio
  and Flow for Ollama, LM Studio, OpenAI, Claude and Gemini

## Provider bridge V1

Inject an authenticated, origin-bound bridge transport; the client owns no
session, key, endpoint or browser storage:

```ts
import { ProviderBridgeClientV1 } from "@xyva/bridge-types"

const providers = new ProviderBridgeClientV1(transport)
const outcome = await providers.infer({
  schemaVersion: 1,
  requestId: "run-42",
  idempotencyKey: "effect-7",
  providerId: "ollama",
  modelId: "qwen2.5-coder:7b-instruct",
  messages: [{ role: "user", content: "Analyze the failing test." }],
  maxOutputTokens: 256,
  requiredCapabilities: ["text.generate"],
})
```

The client validates both outbound requests and inbound outcomes through
`@xyva/contracts`. Secret-bearing or provider-specific connection fields are
not accepted.
