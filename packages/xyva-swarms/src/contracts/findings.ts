export type SwarmAgentId = 'link-patrol' | 'http-guard' | 'a11y-scout' | 'smoke-flow' | 'perf-sentinel' | 'seo-recon' | 'form-fuzzer' | 'api-health'

export type FindingType =
  | 'broken-link'
  | 'redirect-chain'
  | 'http-error'
  | 'network-failure'
  | 'slow-response'
  | 'console-error'
  | 'a11y-violation'
  | 'blocked-flow'
  | 'form-error'
  | 'inconclusive-link'
  | 'perf-issue'
  | 'seo-issue'
  | 'form-validation-issue'
  | 'api-health-issue'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Evidence {
  type: 'screenshot' | 'network-log' | 'console-log' | 'dom-snapshot' | 'redirect-chain' | 'axe-result' | 'guardrail-skip' | 'perf-metric' | 'seo-meta' | 'api-response'
  label: string
  data: Record<string, unknown>
}

export interface RawFinding {
  type: FindingType
  title: string
  description: string
  url: string
  pageUrl: string
  selector?: string
  element?: string
  evidence: Evidence[]
  axeImpact?: 'critical' | 'serious' | 'moderate' | 'minor'
  axeRuleId?: string
  wcagCriteria?: string
  statusCode?: number
  responseTime?: number
  consoleType?: 'error' | 'warning'
  flowBlocked?: boolean
  flowType?: 'primary' | 'secondary'
  needsManualCheck?: boolean
}

export interface NormalizedFinding {
  id: string
  type: FindingType
  category: string
  fingerprint: string
  party: 'first-party' | 'third-party'
  hostname: string
  groupedCount: number
  protectedResource?: boolean
  actionCategory: 'fix-now' | 'review' | 'monitor' | 'ignore-expected'
  severity: Severity
  confidence: number
  needsReview: boolean
  title: string
  description: string
  url: string
  pageUrl: string
  selector?: string
  element?: string
  foundByAgents: SwarmAgentId[]
  timestamp: string
  reproducible: boolean
  evidence: Evidence[]
  sourceEvidenceSummary: string
  plainLanguageSummary?: string
  technicalRootCauseHypothesis?: string
  businessImpact?: string
  suggestedNextAction?: string
  aiAssessment?: string
  wcagCriteria?: string
  axeRuleId?: string
}
