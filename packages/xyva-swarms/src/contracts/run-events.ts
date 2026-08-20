import type { FindingType, RawFinding, Severity, SwarmAgentId, NormalizedFinding } from './findings'
import type { SwarmConfig } from './run-config'
import type { SwarmSummary } from './summary'

export type AgentStatus = 'pending' | 'running' | 'completed' | 'timeout' | 'error' | 'stopped'

export interface SwarmAgentUpdate {
  agentId: SwarmAgentId
  status: AgentStatus
  pagesVisited: number
  findingsCount: number
  elapsed: number
}

export interface AgentResult {
  agentId: SwarmAgentId
  status: AgentStatus
  pagesVisited: number
  duration: number
  rawFindings: RawFinding[]
  skippedActions: number
  error?: string
}

export type SwarmRunStatus = 'running' | 'completed' | 'stopped' | 'error'

export interface SwarmRun {
  id: string
  targetUrl: string
  startedAt: string
  completedAt?: string
  duration?: number
  status: SwarmRunStatus
  config: SwarmConfig
  agents: AgentResult[]
  findings: NormalizedFinding[]
  summary?: SwarmSummary
  guardrailSkips: number
}

export interface SwarmFindingEvent {
  agentId: SwarmAgentId
  finding: { title: string; type: FindingType; severity: Severity }
}

export type RiskLevel = 0 | 1 | 2 | 3 | 4

export interface GuardrailSkipEvent {
  agentId: SwarmAgentId
  selector: string
  elementText: string
  reason: string
  riskLevel: RiskLevel
  timestamp: string
}

export interface ActionDecision {
  allowed: boolean
  riskLevel: RiskLevel
  reason: string
}
