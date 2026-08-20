import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/backend/agent-ai-bridge-cancellation.test.ts",
      "tests/backend/agent-ai-cloud-providers.test.ts",
      "tests/backend/agent-ai-local-providers.test.ts",
      "tests/backend/agent-cli-auth.test.ts",
      "tests/backend/agent-dependency-security.test.ts",
      "tests/backend/agent-flow-entitlement.test.ts",
      "tests/backend/agent-flow-pairing-proof.test.ts",
      "tests/backend/agent-port-policy.test.ts",
      "tests/backend/agent-product-origins.test.ts",
      "tests/backend/agent-provider-bridge.test.ts",
      "tests/backend/agent-provider-cli.test.ts",
      "tests/backend/agent-provider-config.test.ts",
      "tests/backend/agent-readiness.test.ts",
      "tests/backend/agent-security-hardening.test.ts",
      "tests/backend/agent-server.test.ts",
      "tests/backend/swarm-config-validation.test.ts",
      "tests/backend/provider-contracts-v1.test.ts",
      "tests/backend/provider-bridge-client-v1.test.ts",
    ],
  },
})
