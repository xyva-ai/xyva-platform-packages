import type { EventEmitter } from 'node:events'
import type { AgentResult, NormalizedFinding, SwarmConfig, SwarmRunStatus } from '../contracts'

export interface SwarmExecutionResult {
  agentResults: AgentResult[]
  findings: NormalizedFinding[]
  finalStatus: SwarmRunStatus
}

export interface SwarmExecutionRuntimePort {
  execute(
    config: SwarmConfig,
    screenshotDir: string,
    emitter: EventEmitter,
    prepareStorageState?: (browser: unknown) => Promise<unknown>,
  ): Promise<SwarmExecutionResult>
  requestStop(): void
}
