import { describe, expect, it } from "vitest"

import type { SwarmConfig } from "@xyva/bridge-types"

import { validateSwarmConfig } from "../../packages/agent/src/services/swarm/validation"

function createConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    targetUrl: "https://example.com",
    agents: ["link-patrol", "http-guard"],
    budgets: {
      maxTotalTimeMs: 120_000,
      maxPagesPerAgent: 20,
      maxScreenshots: 20,
      maxAiTokens: 10_000,
    },
    headless: true,
    crawlDepth: 2,
    mode: "preset",
    presetId: "standard",
    ...overrides,
  }
}

describe("validateSwarmConfig", () => {
  it("accepts a bounded valid config", () => {
    expect(validateSwarmConfig(createConfig())).toBeNull()
  })

  it("rejects non-http targets", () => {
    expect(validateSwarmConfig(createConfig({ targetUrl: "file:///etc/passwd" }))).toMatch(/http or https/i)
  })

  it("rejects oversized page budgets", () => {
    expect(
      validateSwarmConfig(
        createConfig({
          budgets: {
            maxTotalTimeMs: 120_000,
            maxPagesPerAgent: 10_000,
            maxScreenshots: 20,
            maxAiTokens: 10_000,
          },
        }),
      ),
    ).toMatch(/page budget/i)
  })

  it("rejects invalid crawl depth", () => {
    expect(validateSwarmConfig(createConfig({ crawlDepth: 99 }))).toMatch(/crawl depth/i)
  })
})
