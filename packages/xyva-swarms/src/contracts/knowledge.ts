import type { FindingType, NormalizedFinding, Severity, SwarmAgentId } from './findings'
import type { SwarmRun } from './run-events'

export interface KnownRoute {
  url: string
  path: string
  origin: string
  firstSeenRunId: string
  lastSeenRunId: string
  firstSeenAt: string
  lastSeenAt: string
  visitCount: number
  lastStatus: 'ok' | 'error' | 'unreachable'
  findingCount: number
  highestSeverity: Severity | null
  hasForm: boolean
  hasCta: boolean
  isAuthGated: boolean
  stabilityScore: number
  tags: string[]
}

export interface KnownFormField {
  selector: string
  type: string
  name: string | null
  label: string | null
  required: boolean
}

export interface KnownForm {
  id: string
  pageUrl: string
  pagePath: string
  action: string
  method: string
  fields: KnownFormField[]
  hasSubmitButton: boolean
  submitSelector: string | null
  lastTestedRunId: string
  lastTestedAt: string
  lastResult: 'success' | 'error' | 'not-tested'
  errorCount: number
  firstSeenRunId: string
}

export interface KnownCta {
  id: string
  pageUrl: string
  pagePath: string
  selector: string
  text: string
  tagName: string
  href: string | null
  lastTestedRunId: string
  lastTestedAt: string
  lastResult: 'ok' | 'error' | 'blocked'
  errorCount: number
  firstSeenRunId: string
}

export interface KnownFlow {
  id: string
  fromPath: string
  toPath: string
  fromUrl: string
  toUrl: string
  discoveredByAgent: SwarmAgentId
  firstSeenRunId: string
  lastSeenRunId: string
  traversalCount: number
  hasErrors: boolean
}

export interface RiskArea {
  id: string
  path: string
  url: string
  riskLevel: 'critical' | 'high' | 'medium'
  reason: string
  findingFingerprints: string[]
  affectedRuns: string[]
  firstDetectedAt: string
  lastDetectedAt: string
  isRegression: boolean
}

export type GapType =
  | 'untested-route'
  | 'untested-form'
  | 'untested-flow'
  | 'missing-negative-test'
  | 'missing-regression-test'
  | 'missing-a11y-test'

export type SuggestedTestType = 'smoke' | 'e2e' | 'regression' | 'negative' | 'accessibility'

export interface CoverageGap {
  id: string
  type: GapType
  title: string
  description: string
  severity: Severity
  confidence: number
  relatedRoute: string | null
  relatedFindings: string[]
  matchedTestFiles: string[]
  suggestedTestType: SuggestedTestType
  detectedAt: string
  acknowledged: boolean
}

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'generated'

export interface PlaywrightHint {
  action: 'goto' | 'click' | 'fill' | 'expect-visible' | 'expect-url' | 'expect-no-errors' | 'axe-check'
  selector?: string
  value?: string
  url?: string
  comment: string
}

export interface SuggestedTest {
  id: string
  type: SuggestedTestType
  title: string
  description: string
  rationale: string
  confidence: number
  priority: 'high' | 'medium' | 'low'
  status: SuggestionStatus
  sourceGapId: string | null
  sourceFindings: string[]
  targetRoute: string | null
  targetSelector: string | null
  suggestedAt: string
  dismissedAt: string | null
  dismissReason: string | null
  generatedFilePath: string | null
  testSteps: string[]
  playwrightHints: PlaywrightHint[]
}

export interface RegressionCandidate {
  id: string
  findingFingerprint: string
  title: string
  type: FindingType
  severity: Severity
  url: string
  path: string
  appearedInRuns: string[]
  disappearedInRuns: string[]
  isFlaky: boolean
  lastSeen: string
  suggestedTestId: string | null
}

export interface RunKnowledge {
  runId: string
  extractedAt: string
  routes: KnownRoute[]
  forms: KnownForm[]
  ctas: KnownCta[]
  flows: KnownFlow[]
  hotspots: string[]
}

export interface SwarmKnowledgeSnapshot {
  version: 1
  projectPath: string
  generatedAt: string
  lastRunId: string
  totalRunsAnalyzed: number
  routes: KnownRoute[]
  forms: KnownForm[]
  ctas: KnownCta[]
  flows: KnownFlow[]
  riskAreas: RiskArea[]
  coverageGaps: CoverageGap[]
  suggestedTests: SuggestedTest[]
  stats: {
    totalRoutes: number
    totalForms: number
    totalCtas: number
    totalFlows: number
    totalRiskAreas: number
    totalGaps: number
    totalSuggestions: number
    overallCoverageEstimate: number
  }
}

export interface SwarmKnowledgeBundle {
  snapshot: SwarmKnowledgeSnapshot
  gaps: CoverageGap[]
  suggestions: SuggestedTest[]
  regressions: RegressionCandidate[]
}

export interface CoverageAnalyzerInput {
  snapshot: SwarmKnowledgeSnapshot
  tests: Array<{ file: string; tests: string[]; content?: string }>
}

export interface KnowledgeExtractorInput {
  run: SwarmRun
}

export interface RouteFindingRef {
  path: string
  findings: NormalizedFinding[]
}
