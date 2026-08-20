import { EventEmitter } from 'node:events'

import type { SwarmCallbacks, SwarmConfig, SwarmCredentialPayload } from '@xyva/bridge-types'
import type { Browser } from 'playwright'

import { PlaywrightSwarmExecutionAdapter } from '../../../../xyva-swarms/src/adapters/execution/playwright-swarm-execution.js'
import type { SwarmRun } from '../../../../xyva-swarms/src/contracts/run-events.js'
import { SwarmSummaryCalculator } from '../../../../xyva-swarms/src/core/summary/swarm-summary-calculator.js'
import { SecurityGuard } from '../../utils/SecurityGuard.js'
import { CallbackSwarmHostEvents } from './callback-host-events.js'
import { AgentSwarmCredentialStore, sanitizeAuthForRun } from './credential-store.js'
import { AgentSwarmRunStore } from './run-store.js'
import { validateSwarmConfig } from './validation.js'

export class AgentSwarmService {
  private currentRun: SwarmRun | null = null
  private readonly emitter = new EventEmitter()
  private readonly credentialStore = new AgentSwarmCredentialStore()
  private readonly executionRuntime = new PlaywrightSwarmExecutionAdapter()
  private readonly runStore = new AgentSwarmRunStore()
  private readonly summaryCalculator = new SwarmSummaryCalculator()
  private guardrailSkips = 0

  isRunning(): boolean {
    return !!this.currentRun
  }

  async start(projectPath: string, config: SwarmConfig, callbacks: SwarmCallbacks = {}): Promise<{ ok: boolean; runId?: string; error?: string }> {
    if (this.currentRun) {
      return { ok: false, error: 'A swarm run is already active.' }
    }

    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return { ok: false, error: 'Unauthorized project path.' }
    }

    const configError = validateSwarmConfig(config)
    if (configError) {
      return { ok: false, error: configError }
    }

    const runId = `swarm-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const hostEvents = new CallbackSwarmHostEvents(callbacks)

    this.guardrailSkips = 0
    this.currentRun = {
      id: runId,
      targetUrl: config.targetUrl,
      startedAt: new Date().toISOString(),
      status: 'running',
      config: {
        ...config,
        auth: sanitizeAuthForRun(config.auth),
      },
      agents: [],
      findings: [],
      guardrailSkips: 0,
    }

    const onAgentUpdate = (update: Parameters<CallbackSwarmHostEvents['sendAgentUpdate']>[0]) => hostEvents.sendAgentUpdate(update)
    const onFinding = (event: Parameters<CallbackSwarmHostEvents['sendFinding']>[0]) => hostEvents.sendFinding(event)
    const onGuardrailSkip = (event: Parameters<CallbackSwarmHostEvents['sendGuardrailSkip']>[0]) => {
      this.guardrailSkips += 1
      hostEvents.sendGuardrailSkip(event)
    }

    this.emitter.on('swarm:agent-update', onAgentUpdate)
    this.emitter.on('swarm:finding', onFinding)
    this.emitter.on('swarm:guardrail-skip', onGuardrailSkip)

    void this.executeRun(hostEvents, projectPath, config, runId)
      .catch((error) => hostEvents.sendError((error as Error).message || 'Unknown swarm error'))
      .finally(() => {
        this.emitter.off('swarm:agent-update', onAgentUpdate)
        this.emitter.off('swarm:finding', onFinding)
        this.emitter.off('swarm:guardrail-skip', onGuardrailSkip)
      })

    return { ok: true, runId }
  }

  async stop(): Promise<{ ok: boolean }> {
    this.executionRuntime.requestStop()
    return { ok: true }
  }

  async saveCredentials(payload: SwarmCredentialPayload): Promise<{ ok: boolean; error?: string }> {
    return this.credentialStore.save(payload.projectPath, {
      username: payload.username,
      password: payload.password,
    })
  }

  async hasCredentials(projectPath: string): Promise<{ ok: boolean; hasCredentials: boolean; error?: string }> {
    return this.credentialStore.has(projectPath)
  }

  async clearCredentials(projectPath: string): Promise<{ ok: boolean; error?: string }> {
    return this.credentialStore.clear(projectPath)
  }

  async runHistory(projectPath: string): Promise<{ ok: boolean; runs?: Awaited<ReturnType<AgentSwarmRunStore['listRuns']>>; error?: string }> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return { ok: false, error: 'Unauthorized project path.' }
    }

    return {
      ok: true,
      runs: await this.runStore.listRuns(projectPath),
    }
  }

  async getRunDetail(projectPath: string, runId: string): Promise<{ ok: boolean; run?: Awaited<ReturnType<AgentSwarmRunStore['getRunDetail']>>; error?: string }> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return { ok: false, error: 'Unauthorized project path.' }
    }

    const run = await this.runStore.getRunDetail(projectPath, runId)
    if (!run) {
      return { ok: false, error: 'Swarm run not found.' }
    }

    return { ok: true, run }
  }

  private async executeRun(hostEvents: CallbackSwarmHostEvents, projectPath: string, config: SwarmConfig, runId: string): Promise<void> {
    const { runDir, screenshotDir } = await this.runStore.prepareRun(projectPath, runId)

    try {
      const execution = await this.executionRuntime.execute(
        config,
        screenshotDir,
        this.emitter,
        config.auth?.enabled
          ? (browser) => this.credentialStore.createStorageState(browser as Browser, config.auth!, projectPath)
          : undefined,
      )

      const completedRun: SwarmRun = {
        ...this.currentRun!,
        completedAt: new Date().toISOString(),
        duration: Date.now() - new Date(this.currentRun!.startedAt).getTime(),
        status: execution.finalStatus,
        agents: execution.agentResults,
        findings: execution.findings,
        summary: this.summaryCalculator.generateSummary(execution.findings, execution.agentResults, false),
        guardrailSkips: this.guardrailSkips,
      }

      await this.runStore.writeRunArtifacts(projectPath, runId, completedRun)
      hostEvents.sendComplete({ ok: true, run: completedRun, runDir })
    } catch (error) {
      if ((error as Error).message === 'PLAYWRIGHT_NOT_INSTALLED') {
        hostEvents.sendComplete({ ok: false, error: 'Playwright is not installed for Swarm QA.' })
        return
      }

      throw error
    } finally {
      this.currentRun = null
    }
  }
}
