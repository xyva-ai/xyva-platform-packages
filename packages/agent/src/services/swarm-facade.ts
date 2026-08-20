import type {
  CoverageGap,
  SuggestedTest,
  SwarmCallbacks,
  SwarmCompletePayload,
  SwarmConfig,
  SwarmKnowledgeSnapshot,
} from '@xyva/bridge-types'

export interface SwarmRuntimeAdapter {
  start(projectPath: string, config: SwarmConfig, callbacks: SwarmCallbacks): Promise<{ ok: boolean; runId?: string; error?: string }>
  stop(): Promise<{ ok: boolean }>
  getKnowledge?(projectPath: string): Promise<{ ok: boolean; snapshot?: SwarmKnowledgeSnapshot; error?: string }>
  getGaps?(projectPath: string): Promise<{ ok: boolean; gaps?: CoverageGap[]; error?: string }>
  getSuggestions?(projectPath: string): Promise<{ ok: boolean; suggestions?: SuggestedTest[]; error?: string }>
  dismissGap?(projectPath: string, gapId: string): Promise<{ ok: boolean; error?: string }>
  dismissSuggestion?(projectPath: string, testId: string, reason?: string): Promise<{ ok: boolean; error?: string }>
  generateSkeleton?(projectPath: string, testId: string): Promise<{ ok: boolean; code?: string; filePath?: string; error?: string }>
  saveSkeleton?(projectPath: string, testId: string, filePath: string, code: string): Promise<{ ok: boolean; error?: string }>
}

export class AgentSwarmFacade {
  constructor(private readonly runtime?: SwarmRuntimeAdapter) {}

  async start(projectPath: string, config: SwarmConfig, callbacks: SwarmCallbacks = {}) {
    if (!this.runtime) {
      callbacks.onComplete?.(this.createNotReadyPayload('Swarm runtime wiring is deferred beyond the foundation step.'))
      return { ok: false, error: 'Swarm runtime wiring is deferred beyond the foundation step.' }
    }

    return this.runtime.start(projectPath, config, callbacks)
  }

  async stop(): Promise<{ ok: boolean }> {
    if (!this.runtime) {
      return { ok: true }
    }

    return this.runtime.stop()
  }

  async getKnowledge(projectPath: string): Promise<{ ok: boolean; snapshot?: SwarmKnowledgeSnapshot; error?: string }> {
    if (!this.runtime?.getKnowledge) {
      return { ok: false, error: `Swarm knowledge lookup is not wired yet for ${projectPath}.` }
    }

    return this.runtime.getKnowledge(projectPath)
  }

  async getGaps(projectPath: string): Promise<{ ok: boolean; gaps?: CoverageGap[]; error?: string }> {
    if (!this.runtime?.getGaps) {
      return { ok: false, error: `Swarm gap lookup is not wired yet for ${projectPath}.` }
    }

    return this.runtime.getGaps(projectPath)
  }

  async getSuggestions(projectPath: string): Promise<{ ok: boolean; suggestions?: SuggestedTest[]; error?: string }> {
    if (!this.runtime?.getSuggestions) {
      return { ok: false, error: `Swarm suggestion lookup is not wired yet for ${projectPath}.` }
    }

    return this.runtime.getSuggestions(projectPath)
  }

  async dismissGap(projectPath: string, gapId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime?.dismissGap) {
      return { ok: false, error: `Swarm gap dismissal is not wired yet for ${projectPath}:${gapId}.` }
    }

    return this.runtime.dismissGap(projectPath, gapId)
  }

  async dismissSuggestion(projectPath: string, testId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime?.dismissSuggestion) {
      return { ok: false, error: `Swarm suggestion dismissal is not wired yet for ${projectPath}:${testId}.` }
    }

    return this.runtime.dismissSuggestion(projectPath, testId, reason)
  }

  async generateSkeleton(projectPath: string, testId: string): Promise<{ ok: boolean; code?: string; filePath?: string; error?: string }> {
    if (!this.runtime?.generateSkeleton) {
      return { ok: false, error: `Swarm skeleton generation is not wired yet for ${projectPath}:${testId}.` }
    }

    return this.runtime.generateSkeleton(projectPath, testId)
  }

  async saveSkeleton(projectPath: string, testId: string, filePath: string, code: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime?.saveSkeleton) {
      return { ok: false, error: `Swarm skeleton persistence is not wired yet for ${projectPath}:${testId}.` }
    }

    return this.runtime.saveSkeleton(projectPath, testId, filePath, code)
  }

  private createNotReadyPayload(error: string): SwarmCompletePayload {
    return { ok: false, error }
  }
}
