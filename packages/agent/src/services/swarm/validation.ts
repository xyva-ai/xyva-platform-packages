import type { SwarmAgentId, SwarmConfig } from "@xyva/bridge-types"

const MAX_TOTAL_TIME_MS = 15 * 60_000
const MAX_PAGES_PER_AGENT = 100
const MAX_SCREENSHOTS = 200
const MAX_AI_TOKENS = 50_000
const MAX_CRAWL_DEPTH = 5
const MAX_AGENT_COUNT = 8

const ALLOWED_AGENTS = new Set<SwarmAgentId>([
  "link-patrol",
  "http-guard",
  "a11y-scout",
  "smoke-flow",
  "perf-sentinel",
  "seo-recon",
  "form-fuzzer",
  "api-health",
])

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0
}

export function validateSwarmConfig(config: SwarmConfig) {
  if (!config || typeof config !== "object") {
    return "Invalid swarm configuration."
  }

  try {
    const targetUrl = new URL(config.targetUrl)
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return "Swarm target URL must use http or https."
    }
  } catch {
    return "Swarm target URL is invalid."
  }

  if (!Array.isArray(config.agents) || config.agents.length === 0 || config.agents.length > MAX_AGENT_COUNT) {
    return "Select between 1 and 8 swarm agents."
  }

  if (config.agents.some((agentId) => !ALLOWED_AGENTS.has(agentId))) {
    return "Swarm configuration contains an unknown agent."
  }

  if (!isPositiveInteger(config.crawlDepth) || config.crawlDepth > MAX_CRAWL_DEPTH) {
    return `Swarm crawl depth must be between 1 and ${MAX_CRAWL_DEPTH}.`
  }

  if (
    !config.budgets ||
    !isPositiveInteger(config.budgets.maxTotalTimeMs) ||
    config.budgets.maxTotalTimeMs > MAX_TOTAL_TIME_MS
  ) {
    return `Swarm max runtime must stay between 1 and ${MAX_TOTAL_TIME_MS} ms.`
  }

  if (
    !isPositiveInteger(config.budgets.maxPagesPerAgent) ||
    config.budgets.maxPagesPerAgent > MAX_PAGES_PER_AGENT
  ) {
    return `Swarm page budget per agent must stay between 1 and ${MAX_PAGES_PER_AGENT}.`
  }

  if (
    !isPositiveInteger(config.budgets.maxScreenshots) ||
    config.budgets.maxScreenshots > MAX_SCREENSHOTS
  ) {
    return `Swarm screenshot budget must stay between 1 and ${MAX_SCREENSHOTS}.`
  }

  if (
    !isPositiveInteger(config.budgets.maxAiTokens) ||
    config.budgets.maxAiTokens > MAX_AI_TOKENS
  ) {
    return `Swarm AI token budget must stay between 1 and ${MAX_AI_TOKENS}.`
  }

  return null
}
