import type { AgentResult, NormalizedFinding, SwarmSummary } from '../contracts'

export interface SwarmAiReviewResult {
  findings: NormalizedFinding[]
  aiEnriched: boolean
}

export interface SwarmAiEnrichmentPort {
  review(findings: NormalizedFinding[]): Promise<SwarmAiReviewResult>
}
