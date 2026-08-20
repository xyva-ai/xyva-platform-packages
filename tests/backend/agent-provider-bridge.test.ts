// @vitest-environment node

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'

vi.mock('../../packages/agent/src/license.js', () => ({
  checkLicenseGuard: () => ({ allowed: true, tier: 'test' }),
  getLicenseStatus: () => ({ allowed: true, tier: 'test' }),
}))

import { registerAllHandlers } from '../../packages/agent/src/bridge/register-handlers.js'
import { handleWsMessage, resetHandlers, setBridgeConnectionContext } from '../../packages/agent/src/bridge/ws-handler.js'
import { saveProviderConfiguration, setFlowProviderGrant } from '../../packages/agent/src/config.js'
import { AgentAiFacade } from '../../packages/agent/src/services/ai-facade.js'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readonly sent: string[] = []
  readyState = this.OPEN

  send(value: string): void {
    this.sent.push(value)
  }
}

const previousStateDirectory = process.env.XYVA_AGENT_STATE_DIR
const stateDirectories: string[] = []

afterEach(() => {
  resetHandlers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.env.XYVA_AGENT_STATE_DIR = previousStateDirectory
  for (const directory of stateDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function configureOpenAi(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-bridge-'))
  stateDirectories.push(directory)
  process.env.XYVA_AGENT_STATE_DIR = directory
  saveProviderConfiguration({ providerId: 'openai', defaultModel: 'gpt-5', apiKey: 'stored-openai-key' })
}

function configureAllProviders(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-parity-'))
  stateDirectories.push(directory)
  process.env.XYVA_AGENT_STATE_DIR = directory
  saveProviderConfiguration({ providerId: 'ollama', defaultModel: 'qwen2.5-coder:7b-instruct' })
  saveProviderConfiguration({ providerId: 'lmstudio', defaultModel: 'local-model' })
  saveProviderConfiguration({ providerId: 'openai', defaultModel: 'gpt-5', apiKey: 'stored-openai-key' })
  saveProviderConfiguration({ providerId: 'claude', defaultModel: 'claude-sonnet', apiKey: 'stored-claude-key' })
  saveProviderConfiguration({ providerId: 'gemini', defaultModel: 'gemini-2.5-flash', apiKey: 'stored-gemini-key' })
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

function response(socket: FakeWebSocket, id: string): Record<string, unknown> | undefined {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>).find((entry) => entry.id === id)
}

function authorizeQa(socket: FakeWebSocket): void {
  setBridgeConnectionContext(socket as unknown as WebSocket, {
    capability: 'qa-studio.full-bridge',
    sessionFamilyId: 'qa-test-family',
  })
}

function authorizeFlow(socket: FakeWebSocket): void {
  setBridgeConnectionContext(socket as unknown as WebSocket, {
    capability: 'provider-bridge.v1',
    sessionFamilyId: 'flow-test-family',
  })
}

describe('provider configuration bridge', () => {
  it('rejects browser-selected GitLab endpoints before sending a token', async () => {
    registerAllHandlers()
    const socket = new FakeWebSocket()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'unsafe-gitlab-endpoint', method: 'validateGitLabToken', protocolVersion: 1,
      args: ['browser-token', 'http://127.0.0.1:8080'],
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(response(socket, 'unsafe-gitlab-endpoint')).toMatchObject({
      ok: true,
      data: { ok: false, error: 'GitLab token validation failed.' },
    })
    expect(JSON.stringify(socket.sent)).not.toContain('browser-token')
  })

  it('uses only stored credentials and rejects extra connection fields', async () => {
    configureOpenAi()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'invalid-models', method: 'aiListModels', protocolVersion: 1,
      args: [{ providerId: 'openai', key: 'browser-key', baseUrl: 'https://attacker.invalid' }],
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response(socket, 'invalid-models')).toMatchObject({ ok: true, data: { ok: false } })

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'valid-models', method: 'aiListModels', protocolVersion: 1,
      args: [{ providerId: 'openai' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer stored-openai-key' }) })
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('browser-key')
    expect(response(socket, 'valid-models')).toMatchObject({ ok: true, data: { ok: true, models: ['gpt-5'] } })
  })

  it('returns secret-free status and requires object-shaped verify/delete requests', async () => {
    configureOpenAi()
    registerAllHandlers()
    const socket = new FakeWebSocket()

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'status', method: 'aiProviderStatus', protocolVersion: 1, args: [],
    })
    expect(JSON.stringify(response(socket, 'status'))).not.toContain('stored-openai-key')
    expect(response(socket, 'status')).toMatchObject({ ok: true, data: expect.arrayContaining([
      expect.objectContaining({ providerId: 'openai', selected: true, defaultModel: 'gpt-5', keyConfigured: true }),
    ]) })

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'invalid-delete', method: 'aiProviderDelete', protocolVersion: 1, args: ['openai'],
    })
    expect(response(socket, 'invalid-delete')).toMatchObject({ ok: true, data: { ok: false } })
  })

  it('exposes the same versioned model-list and inference bridge for all five providers', async () => {
    configureAllProviders()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    authorizeQa(socket)
    const providerFixtures = [
      { providerId: 'ollama', modelId: 'qwen2.5-coder:7b-instruct' },
      { providerId: 'lmstudio', modelId: 'local-model' },
      { providerId: 'openai', modelId: 'gpt-5' },
      { providerId: 'claude', modelId: 'claude-sonnet' },
      { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
    ] as const
    const fetchMock = vi.fn(async (urlValue: string | URL) => {
      const url = String(urlValue)
      if (url.endsWith('/api/tags')) return json({ models: [{ name: providerFixtures[0].modelId }] })
      if (url.endsWith('/api/chat')) return json({ message: { content: 'ollama answer' }, prompt_eval_count: 2, eval_count: 3 })
      if (url === 'http://127.0.0.1:1234/v1/models') return json({ data: [{ id: providerFixtures[1].modelId }] })
      if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { content: 'lmstudio answer' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
      if (url === 'https://api.openai.com/v1/models') return json({ data: [{ id: providerFixtures[2].modelId }] })
      if (url === 'https://api.openai.com/v1/responses') return json({ output: [{ content: [{ type: 'output_text', text: 'openai answer' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
      if (url === 'https://api.anthropic.com/v1/models') return json({ data: [{ id: providerFixtures[3].modelId }] })
      if (url === 'https://api.anthropic.com/v1/messages') return json({ content: [{ type: 'text', text: 'claude answer' }], usage: { input_tokens: 2, output_tokens: 3 } })
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models') return json({ models: [{ name: `models/${providerFixtures[4].modelId}` }] })
      if (url.includes(':generateContent')) return json({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 0, totalTokenCount: 5 } })
      throw new Error(`Unexpected provider URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    for (const [index, fixture] of providerFixtures.entries()) {
      const listId = `models-${index}`
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: listId, method: 'providerListModelsV1', protocolVersion: 1,
        args: [{ schemaVersion: 1, requestId: listId, providerId: fixture.providerId }],
      })
      expect(response(socket, listId)).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 1,
          status: 'completed',
          requestId: listId,
          providerId: fixture.providerId,
          models: [expect.objectContaining({ providerId: fixture.providerId, modelId: fixture.modelId })],
        },
      })

      const inferenceId = `inference-${index}`
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: inferenceId, method: 'providerInferV1', protocolVersion: 1,
        args: [{
          schemaVersion: 1,
          requestId: inferenceId,
          idempotencyKey: `effect-${index}`,
          providerId: fixture.providerId,
          modelId: fixture.modelId,
          messages: [{ role: 'user', content: 'Analyze the failing test.' }],
          maxOutputTokens: 128,
          requiredCapabilities: ['text.generate'],
        }],
      })
      expect(response(socket, inferenceId)).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 1,
          status: 'completed',
          requestId: inferenceId,
          providerId: fixture.providerId,
          modelId: fixture.modelId,
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 },
        },
      })
    }

    expect(JSON.stringify(socket.sent)).not.toContain('stored-openai-key')
    expect(JSON.stringify(socket.sent)).not.toContain('stored-claude-key')
    expect(JSON.stringify(socket.sent)).not.toContain('stored-gemini-key')
  })

  it('keeps Flow default-denied and opens only explicitly granted providers across the five-provider matrix', async () => {
    configureAllProviders()
    const listModels = vi.spyOn(AgentAiFacade.prototype, 'listModels').mockImplementation(async (request) => ({
      ok: true,
      models: [`${request.provider}-model`],
    }))
    const chat = vi.spyOn(AgentAiFacade.prototype, 'chat').mockResolvedValue({
      ok: true,
      message: 'provider answer',
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3, source: 'reported' },
    })
    registerAllHandlers()
    const socket = new FakeWebSocket()
    authorizeFlow(socket)

    for (const [index, providerId] of (['ollama', 'lmstudio', 'openai', 'claude', 'gemini'] as const).entries()) {
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: `denied-list-${index}`, method: 'providerListModelsV1', protocolVersion: 1,
        args: [{ schemaVersion: 1, requestId: `denied-list-${index}`, providerId }],
      })
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: `denied-infer-${index}`, method: 'providerInferV1', protocolVersion: 1,
        args: [{
          schemaVersion: 1,
          requestId: `denied-infer-${index}`,
          idempotencyKey: `denied-effect-${index}`,
          providerId,
          modelId: `${providerId}-model`,
          messages: [{ role: 'user', content: 'hello' }],
          maxOutputTokens: 64,
          requiredCapabilities: ['text.generate'],
        }],
      })
      expect(response(socket, `denied-list-${index}`)).toMatchObject({
        ok: true,
        data: { status: 'failed', code: 'policy_denied', retryable: false },
      })
      expect(response(socket, `denied-infer-${index}`)).toMatchObject({
        ok: true,
        data: { status: 'failed', code: 'policy_denied', retryable: false },
      })
      setFlowProviderGrant(providerId, true)
    }
    expect(listModels).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()

    for (const [index, providerId] of (['ollama', 'lmstudio', 'openai', 'claude', 'gemini'] as const).entries()) {
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: `granted-list-${index}`, method: 'providerListModelsV1', protocolVersion: 1,
        args: [{ schemaVersion: 1, requestId: `granted-list-${index}`, providerId }],
      })
      await handleWsMessage(socket as unknown as WebSocket, {
        type: 'call', id: `granted-infer-${index}`, method: 'providerInferV1', protocolVersion: 1,
        args: [{
          schemaVersion: 1,
          requestId: `granted-infer-${index}`,
          idempotencyKey: `granted-effect-${index}`,
          providerId,
          modelId: `${providerId}-model`,
          messages: [{ role: 'user', content: 'hello' }],
          maxOutputTokens: 32,
          requiredCapabilities: ['text.generate'],
        }],
      })
      expect(response(socket, `granted-list-${index}`)).toMatchObject({
        ok: true,
        data: {
          status: 'completed',
          providerId,
          models: [expect.objectContaining({ maxOutputTokens: 32 })],
        },
      })
      expect(response(socket, `granted-infer-${index}`)).toMatchObject({
        ok: true,
        data: { status: 'completed', providerId, modelId: `${providerId}-model` },
      })
    }
    expect(listModels).toHaveBeenCalledTimes(5)
    expect(chat).toHaveBeenCalledTimes(5)

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'oversized-flow-preview', method: 'providerInferV1', protocolVersion: 1,
      args: [{
        schemaVersion: 1,
        requestId: 'oversized-flow-preview',
        idempotencyKey: 'oversized-flow-preview-effect',
        providerId: 'ollama',
        modelId: 'ollama-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 33,
        requiredCapabilities: ['text.generate'],
      }],
    })
    expect(response(socket, 'oversized-flow-preview')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'policy_denied', retryable: false },
    })
    expect(chat).toHaveBeenCalledTimes(5)

    chat.mockResolvedValueOnce({
      ok: true,
      message: 'provider exceeded the budget',
      usage: { inputTokens: 1, outputTokens: 33, reasoningTokens: 0, totalTokens: 34, source: 'reported' },
    })
    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'over-budget-flow-response', method: 'providerInferV1', protocolVersion: 1,
      args: [{
        schemaVersion: 1,
        requestId: 'over-budget-flow-response',
        idempotencyKey: 'over-budget-flow-response-effect',
        providerId: 'ollama',
        modelId: 'ollama-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 32,
        requiredCapabilities: ['text.generate'],
      }],
    })
    expect(response(socket, 'over-budget-flow-response')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'provider_error', retryable: false },
    })
    expect(JSON.stringify(response(socket, 'over-budget-flow-response'))).not.toContain('exceeded the budget')

    chat.mockResolvedValueOnce({
      ok: true,
      message: 'usage was only estimated',
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, source: 'estimated' },
    })
    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'estimated-flow-response', method: 'providerInferV1', protocolVersion: 1,
      args: [{
        schemaVersion: 1,
        requestId: 'estimated-flow-response',
        idempotencyKey: 'estimated-flow-response-effect',
        providerId: 'ollama',
        modelId: 'ollama-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 32,
        requiredCapabilities: ['text.generate'],
      }],
    })
    expect(response(socket, 'estimated-flow-response')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'provider_error', retryable: false },
    })
    expect(JSON.stringify(response(socket, 'estimated-flow-response'))).not.toContain('only estimated')

    setFlowProviderGrant('openai', false)
    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'revoked-openai', method: 'providerListModelsV1', protocolVersion: 1,
      args: [{ schemaVersion: 1, requestId: 'revoked-openai', providerId: 'openai' }],
    })
    expect(response(socket, 'revoked-openai')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'policy_denied', retryable: false },
    })
    expect(listModels).toHaveBeenCalledTimes(5)
  })

  it('fails closed for Provider Bridge V1 when no authenticated product context exists', async () => {
    configureOpenAi()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    const listModels = vi.spyOn(AgentAiFacade.prototype, 'listModels')

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'missing-context', method: 'providerListModelsV1', protocolVersion: 1,
      args: [{ schemaVersion: 1, requestId: 'missing-context', providerId: 'openai' }],
    })
    expect(response(socket, 'missing-context')).toMatchObject({ ok: false, error: 'Bridge method unavailable' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('denies unsupported capabilities and secret-bearing provider requests before network access', async () => {
    configureAllProviders()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    authorizeQa(socket)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'unsupported-capability', method: 'providerInferV1', protocolVersion: 1,
      args: [{
        schemaVersion: 1,
        requestId: 'unsupported-capability',
        idempotencyKey: 'unsupported-effect',
        providerId: 'ollama',
        modelId: 'qwen2.5-coder:7b-instruct',
        messages: [{ role: 'user', content: 'Think deeply.' }],
        maxOutputTokens: 128,
        requiredCapabilities: ['text.generate', 'usage.reasoning'],
      }],
    })
    expect(response(socket, 'unsupported-capability')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'policy_denied', retryable: false },
    })

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'secret-request', method: 'providerListModelsV1', protocolVersion: 1,
      args: [{ schemaVersion: 1, requestId: 'secret-request', providerId: 'openai', apiKey: 'browser-secret' }],
    })
    expect(response(socket, 'secret-request')).toMatchObject({
      ok: true,
      data: { status: 'failed', code: 'invalid_request', retryable: false },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(socket.sent)).not.toContain('browser-secret')
  })

  it('distinguishes valid requests from unexpected provider failures', async () => {
    configureOpenAi()
    vi.spyOn(AgentAiFacade.prototype, 'listModels').mockRejectedValueOnce(new Error('sensitive provider detail'))
    vi.spyOn(AgentAiFacade.prototype, 'chat').mockRejectedValueOnce(new Error('sensitive provider detail'))
    registerAllHandlers()
    const socket = new FakeWebSocket()
    authorizeQa(socket)

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'models-provider-error', method: 'providerListModelsV1', protocolVersion: 1,
      args: [{ schemaVersion: 1, requestId: 'models-provider-error', providerId: 'openai' }],
    })
    expect(response(socket, 'models-provider-error')).toMatchObject({
      ok: true,
      data: { requestId: 'models-provider-error', status: 'failed', code: 'provider_error', retryable: true },
    })

    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'inference-provider-error', method: 'providerInferV1', protocolVersion: 1,
      args: [{
        schemaVersion: 1,
        requestId: 'inference-provider-error',
        idempotencyKey: 'inference-provider-error-effect',
        providerId: 'openai',
        modelId: 'gpt-5',
        messages: [{ role: 'user', content: 'Analyze the failing test.' }],
        maxOutputTokens: 128,
        requiredCapabilities: ['text.generate'],
      }],
    })
    expect(response(socket, 'inference-provider-error')).toMatchObject({
      ok: true,
      data: { requestId: 'inference-provider-error', status: 'failed', code: 'provider_error', retryable: true },
    })
    expect(JSON.stringify(socket.sent)).not.toContain('sensitive provider detail')
  })
})
