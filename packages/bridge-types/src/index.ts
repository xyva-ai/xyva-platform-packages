import type { ProviderIdV1 } from '@xyva/contracts'

export const BRIDGE_PROTOCOL_VERSION = 1 as const

export interface BridgeRequest {
  type: 'call'
  id: string
  method: string
  args: unknown[]
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
}

export interface BridgeResponse {
  type: 'result'
  id: string
  ok: boolean
  data?: unknown
  error?: string
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
}

export interface BridgeEvent {
  type: 'event'
  channel: string
  data: unknown
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
}

export interface BridgeAuth {
  type: 'auth'
  token: string
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
}

export interface BridgeAuthResult {
  type: 'auth-result'
  ok: boolean
  agent?: {
    version: string
    platform: string
    node: string
  }
  error?: string
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
}

export type BridgeMessageFromClient = BridgeAuth | BridgeRequest
export type BridgeMessageFromAgent = BridgeAuthResult | BridgeResponse | BridgeEvent

export type ProjectType = 'playwright' | 'cypress' | 'unknown'
export type ReconProfile = 'express' | 'deep'

export interface ReconMemorySummary {
  pageObjects: number
  tests: number
  gitHistoryAnalyzed: boolean
  knowledgeBaseInitialized: boolean
}

export interface RepoMap {
  type: ProjectType
  testFiles: string[]
  pageObjects: string[]
  fixtures: string[]
  actions: string[]
  asserts: string[]
  totalFiles: number
  totalTestCases: number
  memorySummary?: ReconMemorySummary
  scanMessage?: string
}

export interface ReconScanUpdate {
  status: string
  currentFile: string
}

export interface ReconCallbacks {
  onUpdate?(update: ReconScanUpdate): void
}

export type RunnerRunMode = 'all' | 'file' | 'name'
export type RunnerProjectType = 'playwright' | 'cypress'
export type RunnerTraceMode = 'on' | 'off' | 'retain-on-failure' | 'retain-on-first-failure'

export interface RunnerRunRequest {
  projectPath: string
  workspacePath?: string | null
  projectType: RunnerProjectType
  runMode: RunnerRunMode
  testFile?: string | null
  testFiles?: string[]
  testName?: string | null
  headless: boolean
  debug: boolean
  parallel: number
  browser?: string | null
  trace?: RunnerTraceMode | null
  resolvedData?: Record<string, unknown> | null
  requiredEnvVars?: string[]
  envOverrides?: Record<string, string>
  environment?: string | null
  runtimeEnvironment?: string | null
}

export interface RunnerStartResult {
  ok: boolean
  pid?: number
  blocked?: boolean
  classification?: 'invalid-configuration'
  reason?: string
  error?: string
}

export interface RunnerLogEvent {
  message: string
}

export interface RunnerFinishedEvent {
  exitCode: number
}

export type RunnerEvent =
  | { type: 'log'; message: string }
  | { type: 'finished'; exitCode: number }

export interface RunnerCallbacks {
  onLog?(message: string): void
  onFinished?(exitCode: number): void
}

export type SwarmAgentId =
  | 'link-patrol'
  | 'http-guard'
  | 'a11y-scout'
  | 'smoke-flow'
  | 'perf-sentinel'
  | 'seo-recon'
  | 'form-fuzzer'
  | 'api-health'

export type SwarmRunMode = 'preset' | 'expert'
export type ScanPresetId = 'quick-smoke' | 'standard' | 'deep-audit'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
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

export interface SwarmBudgets {
  maxTotalTimeMs: number
  maxPagesPerAgent: number
  maxScreenshots: number
  maxAiTokens: number
}

export interface AgentConfigSummary {
  aiProvider: ProviderIdV1 | null
  aiConfigured: boolean
  integrations: {
    gitlab: boolean
    github: boolean
    youtrack: boolean
  }
  port: number
}

export interface AgentConfigUpdate {
  aiProvider?: ProviderIdV1 | null
  port?: number
}

/** Secret-free bridge status. Raw keys never appear in a response type. */
export interface AgentProviderConfigurationStatus {
  providerId: ProviderIdV1
  selected: boolean
  defaultModel: string | null
  keyConfigured: boolean
  transport: 'local-loopback' | 'cloud'
}

/** Secret-bearing input, intentionally kept out of @xyva/contracts. */
export interface AgentProviderConfigurationSaveRequest {
  providerId: ProviderIdV1
  defaultModel?: string | null
  apiKey?: string | null
}

export type AgentProviderConfigurationSaveResponse =
  | { ok: true; status: AgentProviderConfigurationStatus }
  | { ok: false; error: string }

export interface AgentProviderConfigurationDeleteRequest {
  providerId: ProviderIdV1
}

export type AgentProviderConfigurationDeleteResponse = AgentProviderConfigurationSaveResponse

export interface AgentProviderModelsRequest {
  providerId: ProviderIdV1
}

export interface AgentProviderVerifyRequest {
  providerId: ProviderIdV1
}

export type AgentProviderVerifyResponse =
  | { ok: true; models: string[] }
  | { ok: false; error: string }

export type AgentAiCancellationResponse =
  | { ok: true; cancellationRequested: true }
  | { ok: false; error: string }

export type AgentReadinessStatus = 'ready' | 'degraded' | 'blocked'
export type AgentReadinessCheckId = 'node' | 'npm' | 'git' | 'playwright' | 'browsers' | 'project'
export type AgentReadinessSource = 'bundled' | 'portable' | 'system' | 'project' | 'missing' | 'unknown'

export interface AgentReadinessAction {
  label: string
  command?: string
  href?: string
  kind: 'run-command' | 'download' | 'open-docs' | 'retry'
}

export interface AgentReadinessCheck {
  id: AgentReadinessCheckId
  label: string
  ready: boolean
  required: boolean
  source: AgentReadinessSource
  version?: string | null
  path?: string | null
  message: string
  remediation?: AgentReadinessAction
}

export interface AgentReadinessReport {
  status: AgentReadinessStatus
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
  checkedAt: string
  portableMode: boolean
  canRunTests: boolean
  canUseGit: boolean
  agent: {
    version: string
    platform: string
    node: string
  }
  checks: AgentReadinessCheck[]
  nextAction: string
}

export interface AgentLicenseGuardStatus {
  allowed: boolean
  reason?: string
  tier: string | null
  source: 'missing' | 'legacy' | 'jwt'
  expiresAt: number
  warning?: string | null
}

export interface SwarmAuthConfig {
  enabled: boolean
  loginUrl: string
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  username: string
  password?: string
  successIndicator?: string
  waitAfterLoginMs: number
}

export interface SwarmConfig {
  targetUrl: string
  agents: SwarmAgentId[]
  budgets: SwarmBudgets
  headless: boolean
  crawlDepth: number
  mode: SwarmRunMode
  presetId?: ScanPresetId
  auth?: SwarmAuthConfig
}

export type SwarmAgentStatus = 'pending' | 'running' | 'completed' | 'timeout' | 'error' | 'stopped'
export type SwarmRunStatus = 'running' | 'completed' | 'stopped' | 'error'
export type RiskLevel = 0 | 1 | 2 | 3 | 4
export type GapType =
  | 'untested-route'
  | 'untested-form'
  | 'untested-flow'
  | 'missing-negative-test'
  | 'missing-regression-test'
  | 'missing-a11y-test'
export type SuggestedTestType = 'smoke' | 'e2e' | 'regression' | 'negative' | 'accessibility'
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'generated'

export interface SwarmAgentUpdate {
  agentId: SwarmAgentId
  status: SwarmAgentStatus
  pagesVisited: number
  findingsCount: number
  elapsed: number
}

export interface SwarmFindingSummary {
  title: string
  type: FindingType
  severity: Severity
}

export interface SwarmFindingEvent {
  agentId: SwarmAgentId
  finding: SwarmFindingSummary
}

export interface GuardrailSkipEvent {
  agentId: SwarmAgentId
  selector: string
  elementText: string
  reason: string
  riskLevel: RiskLevel
  timestamp: string
}

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

export interface SwarmKnowledgeSnapshot {
  version: 1
  projectPath: string
  generatedAt: string
  lastRunId: string
  totalRunsAnalyzed: number
  routes: Array<{ path: string; url: string }>
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

export interface SwarmRunSummaryLite {
  id: string
  targetUrl: string
  startedAt: string
  completedAt?: string
  duration?: number
  status: SwarmRunStatus
  guardrailSkips: number
}

export interface SwarmAgentResult {
  agentId: SwarmAgentId
  status: SwarmAgentStatus
  pagesVisited: number
  duration: number
  findingsCount?: number
  error?: string
}

export interface SwarmFindingRecord {
  id?: string
  title: string
  type: FindingType
  severity: Severity
  url?: string
  pageUrl?: string
  foundByAgents?: SwarmAgentId[]
  plainLanguageSummary?: string
  suggestedNextAction?: string
}

export interface SwarmSummaryRecord {
  totalFindings: number
  bySeverity: Record<string, number>
  byAction: Record<string, number>
  score: number
  aiEnriched: boolean
  topIssues: string[]
  plainSummary?: string
}

export interface SwarmRunRecord {
  id: string
  targetUrl: string
  startedAt: string
  completedAt?: string
  duration?: number
  status: SwarmRunStatus
  config: SwarmConfig
  agents: SwarmAgentResult[]
  findings: SwarmFindingRecord[]
  summary?: SwarmSummaryRecord
  guardrailSkips: number
}

export interface SwarmRunHistoryEntry {
  id: string
  targetUrl: string
  startedAt: string
  completedAt?: string
  duration?: number
  status: SwarmRunStatus
  totalFindings: number
  criticalFindings: number
  score: number | null
  presetId?: ScanPresetId | null
}

export interface SwarmCredentialPayload {
  projectPath: string
  username: string
  password: string
}

export interface SwarmCompletePayload {
  ok: boolean
  run?: SwarmRunRecord
  runDir?: string
  error?: string
}

export interface SwarmCallbacks {
  onAgentUpdate?(update: SwarmAgentUpdate): void
  onFinding?(event: SwarmFindingEvent): void
  onGuardrailSkip?(event: GuardrailSkipEvent): void
  onError?(message: string): void
  onComplete?(payload: SwarmCompletePayload): void
}

export type { Transport } from './transport.js'
export * from './provider-bridge-v1.js'
