import type { WebSocket } from 'ws'
import {
  PROVIDER_IDS_V1,
  listProviderDescriptorsV1,
  supportsProviderCapabilitiesV1,
  validateProviderInferenceOutcomeV1,
  validateProviderInferenceRequestV1,
  validateProviderModelListOutcomeV1,
  validateProviderModelListRequestV1,
  type ProviderFailureCodeV1,
  type ProviderIdV1,
} from '@xyva/contracts'
import type { AgentCredentials } from '../auth.js'
import { installPlaywrightChromium } from '../bootstrap.js'
import { getAgentModePolicy } from '../utils/agent-policy.js'
import { SecurityGuard } from '../utils/SecurityGuard.js'
import {
  deleteProviderConfiguration,
  getConfigSummary,
  getProviderConfigurationStatuses,
  isProviderGrantedToFlow,
  resolveProviderConnection,
  resolveProviderRuntime,
  saveProviderConfiguration,
  updateConfig,
} from '../config.js'
import { checkLicenseGuard, getLicenseStatus } from '../license.js'
import { getAgentReadiness } from '../readiness.js'
import { AgentAiFacade, type AgentAiConfig, type AgentAiListModelsRequest, type AgentAiMessage } from '../services/ai-facade.js'
import { AgentFsService } from '../services/fs-service.js'
import { AgentGitService } from '../services/git-service.js'
import { ProjectContextService } from '../services/project-context-service.js'
import { AgentProjectRegistryService } from '../services/project-registry-service.js'
import { AgentReconService } from '../services/recon-service.js'
import { AgentReportService } from '../services/report-service.js'
import { AgentRunHistoryService } from '../services/run-history-service.js'
import { AgentRunnerService } from '../services/runner-service.js'
import { AgentSwarmService } from '../services/swarm/service.js'
import {
  getBridgeConnectionContext,
  registerHandler,
  registerStreamingHandler,
  resetHandlers,
  sendEvent,
} from './ws-handler.js'

interface HandlerRegistrationOptions {
  projectPath?: string
  credentials?: AgentCredentials
}

interface AiSocketState {
  scopeId: string
  requests: Map<string, AbortController>
}

const FLOW_PROVIDER_PREVIEW_MAX_OUTPUT_TOKENS = 32

function bridgeAiRequestId(value: unknown): string | null {
  if (value === undefined) return ''
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'requestId')) return null
  return typeof input.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.requestId)
    ? input.requestId
    : null
}

function bridgeProviderId(value: unknown): ProviderIdV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 1 && Object.hasOwn(input, 'providerId')
    && typeof input.providerId === 'string' && PROVIDER_IDS_V1.includes(input.providerId as ProviderIdV1)
    ? input.providerId as ProviderIdV1
    : null
}

function bridgeRequestId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid-request'
  const requestId = (value as { requestId?: unknown }).requestId
  return typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)
    ? requestId
    : 'invalid-request'
}

function providerFailureCode(value: unknown): ProviderFailureCodeV1 {
  return value === 'busy' || value === 'conflict' || value === 'rate_limited'
    ? value
    : 'provider_error'
}

function retryableProviderFailure(code: ProviderFailureCodeV1): boolean {
  return ['busy', 'rate_limited', 'provider_unavailable', 'timeout', 'provider_error'].includes(code)
}

function isProviderAllowedForSocket(ws: WebSocket, providerId: ProviderIdV1): boolean {
  return getBridgeConnectionContext(ws)?.capability !== 'provider-bridge.v1'
    || isProviderGrantedToFlow(providerId)
}

function isFlowProviderPreviewSocket(ws: WebSocket): boolean {
  return getBridgeConnectionContext(ws)?.capability === 'provider-bridge.v1'
}

export function registerAllHandlers(_options: HandlerRegistrationOptions = {}): void {
  resetHandlers()

  const aiService = new AgentAiFacade()
  const configuredAiClient = {
    chat: (messages: AgentAiMessage[], unsafeConfig: Record<string, unknown>) => {
      const runtime = resolveProviderRuntime(undefined)
      if (!runtime) return Promise.resolve({ ok: false as const, error: 'AI provider request failed.', message: undefined })
      return aiService.chat(messages, {
        provider: runtime.providerId,
        model: runtime.model,
        ...(runtime.key ? { key: runtime.key } : {}),
        systemInstructions: typeof unsafeConfig.systemInstructions === 'string' ? unsafeConfig.systemInstructions : undefined,
      })
    },
  }
  const fsService = new AgentFsService()
  const gitService = new AgentGitService({ aiClient: configuredAiClient })
  const projectContextService = new ProjectContextService()
  const projectRegistryService = new AgentProjectRegistryService()
  const reconService = new AgentReconService()
  const reportService = new AgentReportService()
  const runHistoryService = new AgentRunHistoryService()
  const runnerService = new AgentRunnerService()
  const swarmService = new AgentSwarmService()
  const aiStateBySocket = new WeakMap<WebSocket, AiSocketState>()
  let nextAiSocketScope = 0
  const getAiSocketState = (ws: WebSocket): AiSocketState => {
    const existing = aiStateBySocket.get(ws)
    if (existing) return existing
    const authenticatedScope = getBridgeConnectionContext(ws)?.sessionFamilyId
    const created = {
      scopeId: authenticatedScope || `socket-${++nextAiSocketScope}`,
      requests: new Map<string, AbortController>(),
    }
    aiStateBySocket.set(ws, created)
    return created
  }

  registerHandler('agentGetAuditLog', () => SecurityGuard.getAgentAuditLog())
  registerHandler('agentGetPolicy', () => getAgentModePolicy(SecurityGuard.getAgentMode()))
  registerHandler('agentReadiness', (projectPath) => getAgentReadiness({
    projectPath: typeof projectPath === 'string' && projectPath.trim() ? projectPath : undefined,
  }))
  registerHandler('agentInstallBrowsers', () => installPlaywrightChromium())
  registerHandler('configGet', () => getConfigSummary())
  registerHandler('configSet', (payload) => ({
    ok: true,
    summary: getConfigSummaryForUpdate(payload),
  }))
  registerHandler('aiProviderStatus', () => getProviderConfigurationStatuses())
  registerHandler('aiProviderSave', (payload) => {
    try {
      return { ok: true, status: saveProviderConfiguration(payload) }
    } catch {
      return { ok: false, error: 'AI provider configuration failed.' }
    }
  })
  registerHandler('aiProviderDelete', (request) => {
    try {
      const providerId = bridgeProviderId(request)
      if (!providerId) throw new Error('Invalid provider configuration')
      return { ok: true, status: deleteProviderConfiguration(providerId) }
    } catch {
      return { ok: false, error: 'AI provider configuration failed.' }
    }
  })
  registerHandler('aiProviderVerify', async (request) => {
    const providerId = bridgeProviderId(request)
    if (!providerId) return { ok: false, error: 'AI provider request failed.' }
    const connection = resolveProviderConnection(providerId)
    if (!connection) return { ok: false, error: 'AI provider request failed.' }
    return aiService.listModels({ provider: connection.providerId, ...(connection.key ? { key: connection.key } : {}) })
  })
  registerHandler('licenseStatus', () => getLicenseStatus())
  registerHandler('listProjects', () => projectRegistryService.listProjects())
  registerHandler('addProject', (projectPath) => projectRegistryService.addProject(String(projectPath)))
  registerHandler('getProjectInfo', (projectPath) => projectRegistryService.getProjectInfo(String(projectPath)))

  registerHandler('listTestFiles', (projectPath, engine) => fsService.listTestFiles(String(projectPath), engine as 'playwright'))
  registerHandler('discoverTests', (projectPath, engine) => fsService.discoverTests(String(projectPath), engine as 'playwright'))
  registerHandler('readDir', (dirPath) => fsService.readDir(String(dirPath)))
  registerHandler('readFile', (filePath) => fsService.readFile(String(filePath)))
  registerHandler('writeFile', (filePath, content) => fsService.writeFile(String(filePath), String(content)))
  registerHandler('findFiles', (rootPath, pattern, limit) => fsService.findFiles(String(rootPath), String(pattern), Number(limit || 50)))

  registerHandler('validateGitLabToken', (token, baseUrl) => {
    if (baseUrl !== undefined && baseUrl !== null && String(baseUrl).trim() !== 'https://gitlab.com') {
      return { ok: false, error: 'GitLab token validation failed.' }
    }
    return gitService.validateGitLabToken(String(token))
  })
  registerHandler('gitStatus', (rootPath) => gitService.getStatus(String(rootPath)))
  registerHandler('gitListBranches', (rootPath) => gitService.listBranches(String(rootPath)))
  registerHandler('gitCreateBranch', (rootPath, branchName) => gitService.createBranch(String(rootPath), String(branchName)))
  registerHandler('gitCheckout', (rootPath, branchName) => gitService.checkout(String(rootPath), String(branchName)))
  registerHandler('gitPull', (rootPath, branch) => gitService.pull(String(rootPath), branch ? String(branch) : 'main'))
  registerHandler('gitDiff', (rootPath) => gitService.getDiff(String(rootPath)))
  registerHandler('gitGetConflictingFiles', (rootPath) => gitService.getConflictingFiles(String(rootPath)))
  registerHandler('gitGetFileWithMarkers', (rootPath, filePath) => gitService.getFileWithMarkers(String(rootPath), String(filePath)))
  registerHandler('gitResolveConflictWithAI', (request) => {
    const input = request as { rootPath: string; filePath: string; content: string; config?: Record<string, unknown> }
    return gitService.resolveConflictWithAI({ ...input, config: {} })
  })
  registerHandler('gitApplyResolvedConflict', (rootPath, filePath, resolvedContent) => gitService.applyResolvedConflict(String(rootPath), String(filePath), String(resolvedContent)))
  registerHandler('generateCommitMessage', (request) => {
    const payload = request as { diff: string }
    return gitService.generateCommitMessage(payload.diff, {})
  })
  registerHandler('gitGenerateCommitMessage', (request) => {
    const payload = request as { diff: string }
    return gitService.generateCommitMessage(payload.diff, {})
  })
  registerHandler('commitAndPush', (rootPath, message, branch) => gitService.commitAndPush(String(rootPath), String(message), String(branch)))
  registerHandler('gitCommitAndPush', (rootPath, message, branch) => gitService.commitAndPush(String(rootPath), String(message), String(branch)))

  registerStreamingHandler('scanRepo', async (ws, projectPath, profile) => {
    return reconService.scanRepository(String(projectPath), {
      profile: (profile as 'express' | 'deep' | undefined) || 'deep',
      onUpdate: (update) => sendEvent(ws, 'recon:scan:update', update),
    })
  })
  registerHandler('projectGetStateHash', (projectPath) => projectContextService.getStateHash(String(projectPath)))
  registerHandler('ingestReport', (projectPath, reportPath) => reportService.ingest(String(projectPath), String(reportPath)))
  registerHandler('getReportHistory', () => reportService.getHistory())
  registerHandler('runHistory.load', (projectPath) => runHistoryService.load(String(projectPath)))
  registerHandler('runHistory.append', (projectPath, entry) => runHistoryService.append(String(projectPath), entry as never))
  registerHandler('runHistory.clear', (projectPath) => runHistoryService.clear(String(projectPath)))
  registerHandler('swarmStop', () => swarmService.stop())
  registerHandler('swarmSaveCredentials', (payload) => swarmService.saveCredentials(payload as { projectPath: string; username: string; password: string }))
  registerHandler('swarmHasCredentials', (projectPath) => swarmService.hasCredentials(String(projectPath)))
  registerHandler('swarmClearCredentials', (projectPath) => swarmService.clearCredentials(String(projectPath)))
  registerHandler('swarmRunHistory', (projectPath) => swarmService.runHistory(String(projectPath)))
  registerHandler('swarmGetRunDetail', (projectPath, runId) => swarmService.getRunDetail(String(projectPath), String(runId)))

  registerHandler('aiListModels', (request) => {
    const providerId = bridgeProviderId(request)
    if (!providerId) return { ok: false, error: 'AI provider request failed.' }
    const connection = resolveProviderConnection(providerId)
    if (!connection) return { ok: false, error: 'AI provider request failed.' }
    return aiService.listModels({ provider: connection.providerId, ...(connection.key ? { key: connection.key } : {}) } as AgentAiListModelsRequest)
  })
  registerStreamingHandler('providerListModelsV1', async (ws, requestValue) => {
    const fallbackRequestId = bridgeRequestId(requestValue)
    let request: ReturnType<typeof validateProviderModelListRequestV1>
    try {
      request = validateProviderModelListRequestV1(requestValue)
    } catch {
      return validateProviderModelListOutcomeV1({
        schemaVersion: 1,
        status: 'failed',
        requestId: fallbackRequestId,
        code: 'invalid_request',
        retryable: false,
      })
    }
    try {
      if (!isProviderAllowedForSocket(ws, request.providerId)) {
        return validateProviderModelListOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'policy_denied',
          retryable: false,
        })
      }
      const descriptor = listProviderDescriptorsV1().find((candidate) => candidate.providerId === request.providerId)
      const connection = resolveProviderConnection(request.providerId)
      if (!descriptor || !connection) {
        return validateProviderModelListOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'policy_denied',
          retryable: false,
        })
      }
      const result = await aiService.listModels({
        provider: connection.providerId,
        ...(connection.key ? { key: connection.key } : {}),
      })
      if (!result.ok) {
        return validateProviderModelListOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'provider_unavailable',
          retryable: true,
        })
      }
      return validateProviderModelListOutcomeV1({
        schemaVersion: 1,
        status: 'completed',
        requestId: request.requestId,
        providerId: request.providerId,
        models: result.models.map((modelId) => ({
          schemaVersion: 1,
          providerId: request.providerId,
          modelId,
          displayName: modelId,
          capabilities: descriptor.capabilities,
          maxOutputTokens: isFlowProviderPreviewSocket(ws)
            ? FLOW_PROVIDER_PREVIEW_MAX_OUTPUT_TOKENS
            : null,
          status: 'available',
        })),
      })
    } catch {
      return validateProviderModelListOutcomeV1({
        schemaVersion: 1,
        status: 'failed',
        requestId: request.requestId,
        code: 'provider_error',
        retryable: true,
      })
    }
  })
  registerStreamingHandler('providerInferV1', async (ws, requestValue) => {
    const fallbackRequestId = bridgeRequestId(requestValue)
    let request: ReturnType<typeof validateProviderInferenceRequestV1>
    try {
      request = validateProviderInferenceRequestV1(requestValue)
    } catch {
      return validateProviderInferenceOutcomeV1({
        schemaVersion: 1,
        status: 'failed',
        requestId: fallbackRequestId,
        code: 'invalid_request',
        retryable: false,
      })
    }
    try {
      if (!isProviderAllowedForSocket(ws, request.providerId)) {
        return validateProviderInferenceOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'policy_denied',
          retryable: false,
        })
      }
      if (isFlowProviderPreviewSocket(ws)
        && request.maxOutputTokens > FLOW_PROVIDER_PREVIEW_MAX_OUTPUT_TOKENS) {
        return validateProviderInferenceOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'policy_denied',
          retryable: false,
        })
      }
      const descriptor = listProviderDescriptorsV1().find((candidate) => candidate.providerId === request.providerId)
      const connection = resolveProviderConnection(request.providerId)
      if (!descriptor || !connection || !supportsProviderCapabilitiesV1(descriptor.capabilities, request.requiredCapabilities)) {
        return validateProviderInferenceOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'policy_denied',
          retryable: false,
        })
      }
      const socketState = getAiSocketState(ws)
      if (socketState.requests.has(request.requestId)) {
        return validateProviderInferenceOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code: 'conflict',
          retryable: false,
        })
      }
      const controller = new AbortController()
      socketState.requests.set(request.requestId, controller)
      const abortOnClose = () => controller.abort()
      ws.once('close', abortOnClose)
      try {
        const result = await aiService.chat(request.messages, {
          provider: connection.providerId,
          model: request.modelId,
          ...(connection.key ? { key: connection.key } : {}),
          maxOutputTokens: request.maxOutputTokens,
        }, {
          requestId: request.idempotencyKey,
          scopeId: socketState.scopeId,
          signal: controller.signal,
        })
        if (result.ok) {
          const generatedTokens = result.usage.outputTokens + result.usage.reasoningTokens
          if (!Number.isSafeInteger(generatedTokens)
            || generatedTokens > request.maxOutputTokens
            || (isFlowProviderPreviewSocket(ws) && result.usage.source !== 'reported')) {
            return validateProviderInferenceOutcomeV1({
              schemaVersion: 1,
              status: 'failed',
              requestId: request.requestId,
              code: 'provider_error',
              retryable: false,
            })
          }
          return validateProviderInferenceOutcomeV1({
            schemaVersion: 1,
            status: 'completed',
            requestId: request.requestId,
            providerId: request.providerId,
            modelId: request.modelId,
            outputText: result.message,
            usage: result.usage,
          })
        }
        if (result.code === 'cancelled') {
          return validateProviderInferenceOutcomeV1({
            schemaVersion: 1,
            status: 'cancelled',
            requestId: request.requestId,
          })
        }
        const code = providerFailureCode(result.code)
        return validateProviderInferenceOutcomeV1({
          schemaVersion: 1,
          status: 'failed',
          requestId: request.requestId,
          code,
          retryable: retryableProviderFailure(code),
        })
      } finally {
        ws.off('close', abortOnClose)
        socketState.requests.delete(request.requestId)
      }
    } catch {
      return validateProviderInferenceOutcomeV1({
        schemaVersion: 1,
        status: 'failed',
        requestId: request.requestId,
        code: 'provider_error',
        retryable: true,
      })
    }
  })
  registerStreamingHandler('providerCancelV1', (ws, requestValue) => {
    const requestId = bridgeAiRequestId(requestValue)
    const controller = requestId ? aiStateBySocket.get(ws)?.requests.get(requestId) : undefined
    if (!controller) return { ok: false, error: 'AI request not found.' }
    controller.abort()
    return { ok: true, cancellationRequested: true }
  })
  registerStreamingHandler('aiChat', async (ws, configValue, messagesValue, optionsValue) => {
    const requestedProvider = configValue && typeof configValue === 'object'
      ? (configValue as { providerId?: unknown; provider?: unknown }).providerId ?? (configValue as { provider?: unknown }).provider
      : undefined
    const runtime = resolveProviderRuntime(requestedProvider)
    if (!runtime) return { ok: false, error: 'AI provider request failed.' }
    const clientConfig = configValue && typeof configValue === 'object' ? configValue as Record<string, unknown> : {}
    const config: AgentAiConfig = {
      provider: runtime.providerId,
      model: runtime.model,
      ...(runtime.key ? { key: runtime.key } : {}),
      systemInstructions: typeof clientConfig.systemInstructions === 'string' ? clientConfig.systemInstructions : undefined,
      maxOutputTokens: typeof clientConfig.maxOutputTokens === 'number' ? clientConfig.maxOutputTokens : undefined,
    }
    const messages = messagesValue as AgentAiMessage[]
    const requestId = bridgeAiRequestId(optionsValue)
    if (requestId === null) return { ok: false, error: 'AI provider request failed.', code: 'conflict' }
    const controller = new AbortController()
    const socketState = getAiSocketState(ws)
    const { requests } = socketState
    if (requestId && requests.has(requestId)) return { ok: false, error: 'AI provider request failed.', code: 'conflict' }
    if (requestId) requests.set(requestId, controller)
    const abortOnClose = () => controller.abort()
    ws.once('close', abortOnClose)
    try {
      return await aiService.chat(messages, config, {
        requestId: requestId || undefined,
        scopeId: socketState.scopeId,
        signal: controller.signal,
      })
    } finally {
      ws.off('close', abortOnClose)
      if (requestId) requests.delete(requestId)
    }
  })
  registerStreamingHandler('aiCancel', (ws, requestIdValue) => {
    const requestId = typeof requestIdValue === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestIdValue)
      ? requestIdValue
      : null
    const controller = requestId ? aiStateBySocket.get(ws)?.requests.get(requestId) : undefined
    if (!controller) return { ok: false, error: 'AI request not found.' }
    controller.abort()
    return { ok: true, cancellationRequested: true }
  })
  registerHandler('getProjectContext', (projectPath, projectType) => aiService.getProjectContext(String(projectPath), (projectType as 'playwright' | 'cypress' | null | undefined) || null))
  registerHandler('auditAccessibility', (request) => aiService.auditAccessibility(request as { content: string; standard: string; config?: never; language?: string }))
  registerHandler('auditFile', (request) => aiService.auditFile(request as { filePath: string; content: string; config?: never; language?: string }))
  registerHandler('fetchLmStudioModels', () => aiService.fetchLmStudioModels())
  registerHandler('checkOAuth', (provider) => aiService.checkLocalOAuth(String(provider)))
  registerHandler('startBrowserAuth', (provider) => aiService.startBrowserAuth(String(provider)))

  registerStreamingHandler('runTests', async (ws, request) => {
    const guard = checkLicenseGuard()
    if (!guard.allowed) {
      return {
        ok: false,
        blocked: true,
        classification: 'invalid-configuration' as const,
        reason: `License required: ${guard.reason || 'premium action blocked'}`,
      }
    }

    const typedRequest = request as { projectPath?: string }
    if (typedRequest.projectPath) {
      await projectRegistryService.touchProject(typedRequest.projectPath)
    }
    sendEvent(ws, 'runner:analyzing', true)
    const result = await runnerService.runTests(request as never, {
      onLog: (line) => sendEvent(ws, 'runner:log', line),
      onFinished: (code) => {
        sendEvent(ws, 'runner:finished', code)
        sendEvent(ws, 'runner:analyzing', false)
      },
    })
    return result
  })

  registerStreamingHandler('runDraft', async (ws, request) => {
    const guard = checkLicenseGuard()
    if (!guard.allowed) {
      return {
        ok: false,
        blocked: true,
        classification: 'invalid-configuration' as const,
        reason: `License required: ${guard.reason || 'premium action blocked'}`,
      }
    }

    const typedRequest = request as { projectPath?: string }
    if (typedRequest.projectPath) {
      await projectRegistryService.touchProject(typedRequest.projectPath)
    }
    sendEvent(ws, 'runner:analyzing', true)
    const result = await runnerService.runTests(request as never, {
      onLog: (line) => sendEvent(ws, 'runner:log', line),
      onFinished: (code) => {
        sendEvent(ws, 'runner:finished', code)
        sendEvent(ws, 'runner:analyzing', false)
      },
    })
    return result
  })

  registerHandler('stopRunner', () => runnerService.stop())
  registerStreamingHandler('swarmStart', async (ws, config, projectPath) => {
    const guard = checkLicenseGuard()
    if (!guard.allowed) {
      return {
        ok: false,
        error: `License required: ${guard.reason || 'premium action blocked'}`,
      }
    }

    return swarmService.start(String(projectPath), config as never, {
      onAgentUpdate: (update) => sendEvent(ws, 'swarm:agent-update', update),
      onFinding: (event) => sendEvent(ws, 'swarm:finding', event),
      onGuardrailSkip: (event) => sendEvent(ws, 'swarm:guardrail-skip', event),
      onError: (message) => sendEvent(ws, 'swarm:error', message),
      onComplete: (payload) => sendEvent(ws, 'swarm:complete', payload),
    })
  })
}

function getConfigSummaryForUpdate(payload: unknown) {
  updateConfig((payload as Parameters<typeof updateConfig>[0]) || {})
  return getConfigSummary()
}
