import type { EventEmitter } from 'node:events'
import type { BrowserContext, Page } from 'playwright'
import { FindingsNormalizer } from '../../core'
import { BaseSwarmAgent } from '../../agents/base-agent'
import type { AgentResult, NormalizedFinding, SwarmConfig, SwarmRunStatus } from '../../contracts'
import type { SwarmExecutionResult, SwarmExecutionRuntimePort } from '../../ports'
import { PlaywrightSwarmAgentFactory } from './playwright-swarm-agent-factory'

export class PlaywrightSwarmExecutionAdapter implements SwarmExecutionRuntimePort {
  private activeAgents: BaseSwarmAgent[] = []
  private agentFactory = new PlaywrightSwarmAgentFactory()

  async execute(
    config: SwarmConfig,
    screenshotDir: string,
    emitter: EventEmitter,
    prepareStorageState?: (browser: unknown) => Promise<unknown>,
  ): Promise<SwarmExecutionResult> {
    let chromium: any
    try {
      const pw = await import('playwright')
      chromium = pw.chromium
    } catch {
      throw new Error('PLAYWRIGHT_NOT_INSTALLED')
    }

    const browser = await chromium.launch({ headless: config.headless })
    const normalizer = new FindingsNormalizer(config.targetUrl)
    const agentResults: AgentResult[] = []
    const allNormalized: NormalizedFinding[] = []
    let finalStatus: SwarmRunStatus = 'completed'

    try {
      this.activeAgents = []
      const authStorageState = prepareStorageState ? await prepareStorageState(browser) : undefined

      const agentPromises = config.agents.map(async (agentId) => {
        const context: BrowserContext = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          ignoreHTTPSErrors: true,
          storageState: authStorageState,
        })
        const page: Page = await context.newPage()
        const agent = this.agentFactory.create({ agentId, page, config, emitter, screenshotDir })
        this.activeAgents.push(agent)

        const startTime = Date.now()
        let result: AgentResult

        try {
          const rawFindings = await agent.run(config.targetUrl)
          result = {
            agentId,
            status: agent.status,
            pagesVisited: agent.pagesVisited,
            duration: Date.now() - startTime,
            rawFindings,
            skippedActions: agent.skippedActions,
          }
        } catch (err: any) {
          result = {
            agentId,
            status: 'error',
            pagesVisited: agent.pagesVisited,
            duration: Date.now() - startTime,
            rawFindings: agent.findings,
            skippedActions: agent.skippedActions,
            error: err?.message ?? 'Unknown agent error',
          }
        } finally {
          await context.close()
        }

        const normalized = normalizer.normalize(result.rawFindings, [agentId])
        return { result, normalized }
      })

      const settled = await Promise.allSettled(agentPromises)

      let hasErrors = false
      let hasStopped = false

      for (const s of settled) {
        if (s.status === 'fulfilled') {
          agentResults.push(s.value.result)
          allNormalized.push(...s.value.normalized)
          if (s.value.result.status === 'error') hasErrors = true
          if (s.value.result.status === 'stopped') hasStopped = true
        } else {
          hasErrors = true
          console.error('[SWARM] Agent crashed:', s.reason)
        }
      }

      if (hasStopped) finalStatus = 'stopped'
      else if (hasErrors && agentResults.length === 0) finalStatus = 'error'
      else finalStatus = 'completed'

      return {
        agentResults,
        findings: normalizer.dedupe(allNormalized),
        finalStatus,
      }
    } finally {
      await browser.close()
      this.activeAgents = []
    }
  }

  requestStop(): void {
    for (const agent of this.activeAgents) {
      agent.requestStop()
    }
  }
}
