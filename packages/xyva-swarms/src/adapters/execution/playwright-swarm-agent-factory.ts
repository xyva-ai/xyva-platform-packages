import { A11yScoutAgent } from '../../agents/a11y-scout.agent'
import { ApiHealthAgent } from '../../agents/api-health.agent'
import { BaseSwarmAgent } from '../../agents/base-agent'
import { FormFuzzerAgent } from '../../agents/form-fuzzer.agent'
import { HttpGuardAgent } from '../../agents/http-guard.agent'
import { LinkPatrolAgent } from '../../agents/link-patrol.agent'
import { PerfSentinelAgent } from '../../agents/perf-sentinel.agent'
import { SeoReconAgent } from '../../agents/seo-recon.agent'
import { SmokeFlowAgent } from '../../agents/smoke-flow.agent'
import type { SwarmAgentFactoryInput } from '../../ports'

export class PlaywrightSwarmAgentFactory {
  create({ agentId, page, config, emitter, screenshotDir }: SwarmAgentFactoryInput): BaseSwarmAgent {
    const activeAgentCount = Math.max(1, config.agents.length)
    const crawlDepth = Math.max(1, Math.min(5, config.crawlDepth || 2))

    switch (agentId) {
      case 'link-patrol':
        return new LinkPatrolAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'http-guard':
        return new HttpGuardAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'a11y-scout':
        return new A11yScoutAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'smoke-flow':
        return new SmokeFlowAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'perf-sentinel':
        return new PerfSentinelAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'seo-recon':
        return new SeoReconAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'form-fuzzer':
        return new FormFuzzerAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      case 'api-health':
        return new ApiHealthAgent(agentId, page, config.budgets, emitter, screenshotDir, activeAgentCount, crawlDepth)
      default:
        throw new Error(`Unknown agent: ${agentId}`)
    }
  }
}
