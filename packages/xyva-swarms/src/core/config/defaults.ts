import type { SwarmConfig } from '../../contracts'

export function createDefaultSwarmConfig(targetUrl: string): SwarmConfig {
  return {
    targetUrl,
    agents: ['link-patrol', 'http-guard', 'a11y-scout', 'smoke-flow'],
    budgets: {
      maxTotalTimeMs: 120_000,
      maxPagesPerAgent: 20,
      maxScreenshots: 50,
      maxAiTokens: 10_000,
    },
    headless: true,
    crawlDepth: 2,
    mode: 'preset',
    presetId: 'standard',
  }
}
