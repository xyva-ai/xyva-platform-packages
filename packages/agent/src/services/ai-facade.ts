import { createHash } from 'node:crypto'

import type { ProviderUsageV1 } from '@xyva/contracts'

const MODEL_LIST_TIMEOUT_MS = 10_000
const INFERENCE_TIMEOUT_MS = 120_000
const MAX_REQUEST_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_MESSAGE_COUNT = 64
const MAX_MESSAGE_BYTES = 32 * 1024
const MAX_MODEL_LENGTH = 200
const RATE_WINDOW_MS = 60_000
const IDEMPOTENCY_TTL_MS = 5 * 60_000
const MAX_IDEMPOTENCY_ENTRIES = 128

const LOCAL_ENDPOINTS = {
  ollama: new URL('http://127.0.0.1:11434'),
  lmstudio: new URL('http://127.0.0.1:1234'),
} as const

const CLOUD_ENDPOINTS = {
  openai: new URL('https://api.openai.com'),
  claude: new URL('https://api.anthropic.com'),
  gemini: new URL('https://generativelanguage.googleapis.com'),
} as const

type LocalProvider = keyof typeof LOCAL_ENDPOINTS
type CloudProvider = keyof typeof CLOUD_ENDPOINTS

export interface AgentAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AgentAiConfig {
  provider?: string
  key?: string
  model?: string
  systemInstructions?: string
  maxOutputTokens?: number
  azureResource?: string
  azureDeployment?: string
  azureApiVersion?: string
  aiProxyUrl?: string
  aiProxyBackend?: string
  tools?: unknown[]
}

export interface AgentAiListModelsRequest {
  provider: string
  /** Legacy input accepted only when it is exactly the fixed loopback endpoint. */
  baseUrl?: string
  /** Accepted for compatibility but never sent to local providers. */
  key?: string
  azureResource?: string
  azureDeployment?: string
  azureApiVersion?: string
  aiProxyBackend?: string
}

type NormalizedUsage = ProviderUsageV1

export interface AgentAiRequestOptions {
  requestId?: string
  /** Internal owner scope used to isolate idempotency across WebSocket clients. */
  scopeId?: string
  signal?: AbortSignal
}

export interface AgentAiLimits {
  maxConcurrentRequests: number
  cloudRequestsPerMinute: number
  localRequestsPerMinute: number
}

type ProviderClass = 'cloud' | 'local'
type AgentAiFailureCode = 'busy' | 'cancelled' | 'conflict' | 'rate_limited'
type ChatResult = { ok: true; message: string; usage: NormalizedUsage } | { ok: false; error: string; code?: AgentAiFailureCode; message?: string }
type ModelResult = { ok: true; models: string[] } | { ok: false; error: string }
type CachedInference = {
  expiresAt: number
  signature: string
  state: 'pending' | 'completed'
  result: Promise<ChatResult>
}

const DEFAULT_AI_LIMITS: AgentAiLimits = {
  maxConcurrentRequests: 2,
  cloudRequestsPerMinute: 6,
  localRequestsPerMinute: 12,
}

function genericProviderError(): { ok: false; error: string } {
  return { ok: false, error: 'Local AI provider request failed.' }
}

function genericCloudProviderError(): { ok: false; error: string } {
  return { ok: false, error: 'AI provider request failed.' }
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback
}

function providerFailure(providerClass: ProviderClass, code: AgentAiFailureCode): ChatResult {
  const label = providerClass === 'local' ? 'Local AI provider' : 'AI provider'
  const detail = code === 'cancelled'
    ? 'request was cancelled.'
    : code === 'busy'
      ? 'is busy. Try again shortly.'
      : code === 'rate_limited'
        ? 'rate limit reached. Try again shortly.'
        : 'request conflicts with an existing request.'
  return { ok: false, error: `${label} ${detail}`, code }
}

function inferenceRequestId(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null
}

function inferenceSignature(messages: AgentAiMessage[], config: AgentAiConfig): string {
  const keyDigest = typeof config.key === 'string' && config.key
    ? createHash('sha256').update(config.key, 'utf8').digest('hex')
    : null
  return createHash('sha256').update(JSON.stringify({
    keyDigest,
    maxOutputTokens: config.maxOutputTokens ?? null,
    messages,
    model: config.model ?? null,
    provider: config.provider ?? null,
    systemInstructions: config.systemInstructions ?? null,
  }), 'utf8').digest('hex')
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function hasJsonContentType(response: Response): boolean {
  const value = response.headers.get('content-type') || ''
  return /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(value)
}

function isSafeLoopbackBaseUrl(value: string | undefined, provider: LocalProvider): boolean {
  if (!value) return true
  try {
    const candidate = new URL(value)
    const expected = LOCAL_ENDPOINTS[provider]
    return candidate.protocol === expected.protocol &&
      candidate.hostname === expected.hostname &&
      candidate.port === expected.port &&
      candidate.pathname.replace(/\/$/u, '') === '' &&
      !candidate.username && !candidate.password && !candidate.search && !candidate.hash
  } catch {
    return false
  }
}

function endpoint(provider: LocalProvider, pathname: string): string {
  return new URL(pathname, LOCAL_ENDPOINTS[provider]).toString()
}

function cloudEndpoint(provider: CloudProvider, pathname: string): string {
  return new URL(pathname, CLOUD_ENDPOINTS[provider]).toString()
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function optionalSafeTokenCount(source: Record<string, unknown>, key: string): number | null {
  if (!(key in source)) return 0
  return safeTokenCount(source[key])
}

function normalizedUsageCounts(
  inputValue: unknown,
  outputValue: unknown,
  totalValue?: unknown,
  reasoningValue: unknown = 0,
  reasoningIncludedInOutput = true,
): NormalizedUsage | undefined {
  const inputTokens = safeTokenCount(inputValue)
  const reportedOutputTokens = safeTokenCount(outputValue)
  const reasoningTokens = safeTokenCount(reasoningValue)
  if (inputTokens === null || reportedOutputTokens === null || reasoningTokens === null) return undefined
  if (reasoningIncludedInOutput && reasoningTokens > reportedOutputTokens) return undefined
  const outputTokens = reasoningIncludedInOutput ? reportedOutputTokens - reasoningTokens : reportedOutputTokens
  const accountedTotal = inputTokens + outputTokens + reasoningTokens
  if (!Number.isSafeInteger(accountedTotal)) return undefined
  if (totalValue === undefined) return { inputTokens, outputTokens, reasoningTokens, totalTokens: accountedTotal, source: 'reported' }
  const reportedTotal = safeTokenCount(totalValue)
  if (reportedTotal === null) return undefined
  return { inputTokens, outputTokens, reasoningTokens, totalTokens: Math.max(reportedTotal, accountedTotal), source: 'reported' }
}

function normalizedLocalUsage(provider: LocalProvider, response: Record<string, unknown>): NormalizedUsage | undefined {
  if (provider === 'ollama') {
    return normalizedUsageCounts(response.prompt_eval_count, response.eval_count)
  }
  const usage = response.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const source = usage as Record<string, unknown>
  const details = source.completion_tokens_details
  const reasoningTokens = details && typeof details === 'object' && !Array.isArray(details)
    ? optionalSafeTokenCount(details as Record<string, unknown>, 'reasoning_tokens')
    : 0
  return normalizedUsageCounts(source.prompt_tokens, source.completion_tokens, source.total_tokens, reasoningTokens)
}

function estimatedUsage(messages: readonly AgentAiMessage[], outputText: string): NormalizedUsage {
  const inputCharacters = messages.reduce((total, message) => total + message.content.length, 0)
  const inputTokens = Math.ceil(inputCharacters / 4)
  const outputTokens = Math.ceil(outputText.length / 4)
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  }
}

function normalizedCloudUsage(provider: CloudProvider, value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (provider === 'openai') {
    const details = source.output_tokens_details
    const reasoningTokens = details && typeof details === 'object' && !Array.isArray(details)
      ? optionalSafeTokenCount(details as Record<string, unknown>, 'reasoning_tokens')
      : 0
    return normalizedUsageCounts(source.input_tokens, source.output_tokens, source.total_tokens, reasoningTokens)
  }
  if (provider === 'claude') {
    const input = safeTokenCount(source.input_tokens)
    const cacheCreation = optionalSafeTokenCount(source, 'cache_creation_input_tokens')
    const cacheRead = optionalSafeTokenCount(source, 'cache_read_input_tokens')
    const outputTokens = safeTokenCount(source.output_tokens)
    if (input === null || cacheCreation === null || cacheRead === null || outputTokens === null) return undefined
    const inputTokens = input + cacheCreation + cacheRead
    const totalTokens = inputTokens + outputTokens
    return Number.isSafeInteger(totalTokens)
      ? { inputTokens, outputTokens, reasoningTokens: 0, totalTokens, source: 'reported' }
      : undefined
  }
  const inputTokens = safeTokenCount(source.promptTokenCount)
  const candidateTokens = safeTokenCount(source.candidatesTokenCount)
  const thoughtTokens = optionalSafeTokenCount(source, 'thoughtsTokenCount')
  const totalTokens = safeTokenCount(source.totalTokenCount)
  if (inputTokens === null || candidateTokens === null || thoughtTokens === null || totalTokens === null) return undefined
  return normalizedUsageCounts(inputTokens, candidateTokens, totalTokens, thoughtTokens, false)
}

function normalizeMessages(messages: AgentAiMessage[]): AgentAiMessage[] | null {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGE_COUNT) return null
  const validRoles = new Set<AgentAiMessage['role']>(['system', 'user', 'assistant'])
  const normalized: AgentAiMessage[] = []
  for (const message of messages) {
    if (!message || !validRoles.has(message.role) || typeof message.content !== 'string' || !message.content.trim() || byteLength(message.content) > MAX_MESSAGE_BYTES) {
      return null
    }
    normalized.push({ role: message.role, content: message.content })
  }
  return normalized
}

async function requestJson(url: string, init: RequestInit = {}, timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const externalSignal = init.signal
  const abortFromExternalSignal = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { signal: _externalSignal, ...requestInit } = init
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    })
    if (!response.ok || response.redirected || !hasJsonContentType(response)) return null
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_RESPONSE_BYTES) return null
    const raw = await readBoundedBody(response)
    if (raw === null) return null
    const payload: unknown = JSON.parse(raw)
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternalSignal)
  }
}

async function readBoundedBody(response: Response): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const joined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function validatedModel(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9._:/-]+$/u.test(value.trim()) && value.trim().length > 0 && value.length <= MAX_MODEL_LENGTH ? value.trim() : null
}

function canonicalCloudProvider(provider: string | undefined): CloudProvider | null {
  switch (provider?.trim().toLowerCase()) {
    case 'openai':
    case 'codex':
      return 'openai'
    case 'claude':
    case 'anthropic':
      return 'claude'
    case 'gemini':
    case 'google':
      return 'gemini'
    default:
      return null
  }
}

function requiredKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 16_384 ? value.trim() : null
}

function normalizedMaxOutputTokens(value: unknown): number | null {
  if (value === undefined || value === null) return 1024
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8192 ? value : null
}

function systemInstructions(messages: AgentAiMessage[], explicit?: string): string | null {
  if (explicit !== undefined && (typeof explicit !== 'string' || byteLength(explicit) > MAX_MESSAGE_BYTES)) return null
  const pieces = [...messages.filter((message) => message.role === 'system').map((message) => message.content)]
  if (explicit?.trim()) pieces.push(explicit.trim())
  const combined = pieces.join('\n\n')
  return byteLength(combined) <= MAX_MESSAGE_BYTES ? combined : null
}

function nonSystemMessages(messages: AgentAiMessage[]): AgentAiMessage[] {
  return messages.filter((message) => message.role !== 'system')
}

export class AgentAiFacade {
  readonly #limits: AgentAiLimits
  readonly #recentRequests: Record<ProviderClass, number[]> = { cloud: [], local: [] }
  readonly #idempotency = new Map<string, CachedInference>()
  #activeRequests = 0

  constructor(limits: Partial<AgentAiLimits> = {}) {
    this.#limits = {
      maxConcurrentRequests: boundedLimit(limits.maxConcurrentRequests, DEFAULT_AI_LIMITS.maxConcurrentRequests, 16),
      cloudRequestsPerMinute: boundedLimit(limits.cloudRequestsPerMinute, DEFAULT_AI_LIMITS.cloudRequestsPerMinute, 120),
      localRequestsPerMinute: boundedLimit(limits.localRequestsPerMinute, DEFAULT_AI_LIMITS.localRequestsPerMinute, 240),
    }
  }

  async getProjectContext(_projectPath: string, _projectType?: 'playwright' | 'cypress' | null) {
    return {
      ok: false,
      context: '',
      localContext: '',
      technicalBlueprint: '',
      loadedFiles: 0,
      hasEntryPoint: false,
      blueprintLoaded: false,
      blueprintType: 'none',
      error: 'Project-context extraction is not implemented in the agent foundation yet.',
    }
  }

  async checkLocalOAuth(_provider: string): Promise<{ ok: boolean; code?: string; message?: string }> {
    return { ok: false, code: 'NOT_IMPLEMENTED', message: 'Browser OAuth is not available in the local agent.' }
  }

  async startBrowserAuth(_provider: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    return { ok: false, error: 'Browser OAuth is not available in the local agent.' }
  }

  async fetchOllamaModels(baseUrl?: string): Promise<ModelResult> {
    return this.listLocalModels('ollama', baseUrl)
  }

  async fetchLmStudioModels(baseUrl?: string): Promise<ModelResult> {
    return this.listLocalModels('lmstudio', baseUrl)
  }

  async listModels(request: AgentAiListModelsRequest): Promise<ModelResult> {
    if (request.provider === 'ollama') return this.fetchOllamaModels(request.baseUrl)
    if (request.provider === 'lmstudio') return this.fetchLmStudioModels(request.baseUrl)
    const provider = canonicalCloudProvider(request.provider)
    const key = requiredKey(request.key)
    if (!provider || !key) return genericCloudProviderError()
    return this.listCloudModels(provider, key)
  }

  async chat(messages: AgentAiMessage[], config: AgentAiConfig, options: AgentAiRequestOptions = {}): Promise<ChatResult> {
    const provider = config?.provider === 'ollama' || config?.provider === 'lmstudio' ? config.provider : null
    const model = validatedModel(config?.model)
    const normalizedMessages = normalizeMessages(messages)
    if (!provider) return this.chatCloud(messages, config, options)
    const maxOutputTokens = normalizedMaxOutputTokens(config?.maxOutputTokens)
    if (!model || !normalizedMessages || maxOutputTokens === null) return genericProviderError()

    const payload = provider === 'ollama'
      ? { model, messages: normalizedMessages, stream: false, options: { num_predict: maxOutputTokens } }
      : { model, messages: normalizedMessages, stream: false, max_tokens: maxOutputTokens }
    const raw = JSON.stringify(payload)
    if (byteLength(raw) > MAX_REQUEST_BYTES) return genericProviderError()

    return this.#runInference('local', normalizedMessages, config, options, async () => {
      const response = await requestJson(endpoint(provider, provider === 'ollama' ? '/api/chat' : '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
        signal: options.signal,
      }, INFERENCE_TIMEOUT_MS)
      if (!response) return options.signal?.aborted ? providerFailure('local', 'cancelled') : genericProviderError()

      const message = provider === 'ollama'
        ? (response.message as Record<string, unknown> | undefined)?.content
        : ((response.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content
      if (typeof message !== 'string') return genericProviderError()
      return { ok: true, message, usage: normalizedLocalUsage(provider, response) ?? estimatedUsage(normalizedMessages, message) }
    })
  }

  async auditAccessibility(_request: { content: string; standard: string; config?: AgentAiConfig; language?: string }) {
    return { ok: false, error: 'Accessibility auditing is not available in the local agent.' }
  }

  async auditFile(_request: { filePath: string; content: string; config?: AgentAiConfig; language?: string }) {
    return { ok: false, error: 'File auditing is not available in the local agent.' }
  }

  private async listLocalModels(provider: LocalProvider, baseUrl?: string): Promise<ModelResult> {
    if (!isSafeLoopbackBaseUrl(baseUrl, provider)) return genericProviderError()
    return this.#runLimited('local', genericProviderError, async () => {
      const response = await requestJson(endpoint(provider, provider === 'ollama' ? '/api/tags' : '/v1/models'))
      if (!response) return genericProviderError()
      const entries = provider === 'ollama' ? response.models : response.data
      if (!Array.isArray(entries) || entries.length > 256) return genericProviderError()
      const models = entries.map((entry) => validatedModel((entry as Record<string, unknown>)?.[provider === 'ollama' ? 'name' : 'id'])).filter((item): item is string => Boolean(item))
      return { ok: true, models }
    })
  }

  private async listCloudModels(provider: CloudProvider, key: string): Promise<ModelResult> {
    return this.#runLimited('cloud', genericCloudProviderError, async () => {
      const headers = cloudHeaders(provider, key)
      const response = await requestJson(cloudEndpoint(provider, provider === 'gemini' ? '/v1beta/models' : '/v1/models'), { headers })
      if (!response) return genericCloudProviderError()
      const entries = provider === 'gemini' ? response.models : response.data
      if (!Array.isArray(entries) || entries.length > 256) return genericCloudProviderError()
      const models = entries
        .map((entry) => validatedModel((entry as Record<string, unknown>)?.[provider === 'gemini' ? 'name' : 'id']))
        .filter((item): item is string => Boolean(item))
        .map((item) => provider === 'gemini' ? item.replace(/^models\//u, '') : item)
      return { ok: true, models }
    })
  }

  private async chatCloud(messages: AgentAiMessage[], config: AgentAiConfig, options: AgentAiRequestOptions): Promise<ChatResult> {
    const provider = canonicalCloudProvider(config?.provider)
    const key = requiredKey(config?.key)
    const model = validatedModel(config?.model)
    const normalizedMessages = normalizeMessages(messages)
    const maxOutputTokens = normalizedMaxOutputTokens(config?.maxOutputTokens)
    if (!provider || !key || !model || !normalizedMessages || maxOutputTokens === null) return genericCloudProviderError()
    const instruction = systemInstructions(normalizedMessages, config.systemInstructions)
    if (instruction === null) return genericCloudProviderError()
    const messagesWithoutSystem = nonSystemMessages(normalizedMessages)
    if (messagesWithoutSystem.length === 0) return genericCloudProviderError()

    const request = cloudChatRequest(provider, model, messagesWithoutSystem, instruction, maxOutputTokens)
    const raw = JSON.stringify(request.body)
    if (byteLength(raw) > MAX_REQUEST_BYTES) return genericCloudProviderError()
    return this.#runInference('cloud', normalizedMessages, config, options, async () => {
      const response = await requestJson(cloudEndpoint(provider, request.path), {
        method: 'POST',
        headers: { ...cloudHeaders(provider, key), 'Content-Type': 'application/json' },
        body: raw,
        signal: options.signal,
      }, INFERENCE_TIMEOUT_MS)
      if (!response) return options.signal?.aborted ? providerFailure('cloud', 'cancelled') : genericCloudProviderError()
      const message = cloudOutputText(provider, response)
      if (message === null) return genericCloudProviderError()
      return {
        ok: true,
        message,
        usage: normalizedCloudUsage(provider, provider === 'gemini' ? response.usageMetadata : response.usage)
          ?? estimatedUsage(normalizedMessages, message),
      }
    })
  }

  async #runLimited<T>(providerClass: ProviderClass, failure: () => T, task: () => Promise<T>): Promise<T> {
    if (this.#admissionFailureCode(providerClass)) return failure()
    return this.#runAdmitted(task)
  }

  async #runAdmitted<T>(task: () => Promise<T>): Promise<T> {
    this.#activeRequests += 1
    try {
      return await task()
    } finally {
      this.#activeRequests -= 1
    }
  }

  async #runInference(
    providerClass: ProviderClass,
    messages: AgentAiMessage[],
    config: AgentAiConfig,
    options: AgentAiRequestOptions,
    task: () => Promise<ChatResult>,
  ): Promise<ChatResult> {
    const requestId = inferenceRequestId(options.requestId)
    const scopeId = inferenceRequestId(options.scopeId)
    if (requestId === null || scopeId === null) return providerFailure(providerClass, 'conflict')
    if (options.signal?.aborted) return providerFailure(providerClass, 'cancelled')
    const signature = inferenceSignature(messages, config)
    const idempotencyKey = requestId ? `${scopeId || 'local-process'}\u0000${requestId}` : ''
    const now = Date.now()
    for (const [key, cached] of this.#idempotency) {
      if (cached.expiresAt <= now) this.#idempotency.delete(key)
    }
    if (requestId) {
      const cached = this.#idempotency.get(idempotencyKey)
      if (cached) {
        if (cached.signature !== signature || cached.state === 'pending') {
          return providerFailure(providerClass, 'conflict')
        }
        return cached.result
      }
    }
    const admissionFailure = this.#admissionFailureCode(providerClass)
    if (admissionFailure) return providerFailure(providerClass, admissionFailure)

    const result = this.#runAdmitted(task)
    if (requestId) {
      const cached: CachedInference = {
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        signature,
        state: 'pending',
        result,
      }
      this.#idempotency.set(idempotencyKey, cached)
      void result.then(
        () => { cached.state = 'completed' },
        () => { cached.state = 'completed' },
      )
      while (this.#idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
        const oldest = this.#idempotency.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.#idempotency.delete(oldest)
      }
    }
    return result
  }

  #admissionFailureCode(providerClass: ProviderClass): 'busy' | 'rate_limited' | null {
    const now = Date.now()
    const recent = this.#recentRequests[providerClass]
    while (recent.length > 0 && recent[0] <= now - RATE_WINDOW_MS) recent.shift()
    const perMinute = providerClass === 'cloud' ? this.#limits.cloudRequestsPerMinute : this.#limits.localRequestsPerMinute
    if (this.#activeRequests >= this.#limits.maxConcurrentRequests) {
      if (recent.length < perMinute) recent.push(now)
      return 'busy'
    }
    if (recent.length >= perMinute) return 'rate_limited'
    recent.push(now)
    return null
  }
}

function cloudHeaders(provider: CloudProvider, key: string): HeadersInit {
  if (provider === 'openai') return { Authorization: `Bearer ${key}` }
  if (provider === 'claude') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  return { 'x-goog-api-key': key }
}

function cloudChatRequest(provider: CloudProvider, model: string, messages: AgentAiMessage[], instruction: string, maxOutputTokens: number): { path: string; body: Record<string, unknown> } {
  if (provider === 'openai') {
    return {
      path: '/v1/responses',
      body: { model, input: messages.map(({ role, content }) => ({ role, content })), instructions: instruction || undefined, max_output_tokens: maxOutputTokens, store: false },
    }
  }
  if (provider === 'claude') {
    return {
      path: '/v1/messages',
      body: { model, messages: messages.map(({ role, content }) => ({ role, content })), system: instruction || undefined, max_tokens: maxOutputTokens, stream: false },
    }
  }
  return {
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      systemInstruction: instruction ? { parts: [{ text: instruction }] } : undefined,
      contents: messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] })),
      generationConfig: { maxOutputTokens },
    },
  }
}

function cloudOutputText(provider: CloudProvider, response: Record<string, unknown>): string | null {
  if (provider === 'openai') {
    const output = response.output
    if (!Array.isArray(output)) return null
    const texts: string[] = []
    for (const item of output) {
      const content = (item as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const outputPart = part as Record<string, unknown>
        if (outputPart.type === 'output_text' && typeof outputPart.text === 'string') texts.push(outputPart.text)
      }
    }
    return texts.join('') || null
  }
  if (provider === 'claude') {
    const content = response.content
    if (!Array.isArray(content)) return null
    return content.map((part) => {
      const item = part as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
    }).join('') || null
  }
  const parts = ((response.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as Record<string, unknown> | undefined)?.parts
  if (!Array.isArray(parts)) return null
  return parts.map((part) => typeof (part as Record<string, unknown>)?.text === 'string' ? (part as Record<string, unknown>).text : '').join('') || null
}
