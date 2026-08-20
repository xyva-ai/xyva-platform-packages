import { describe, expect, it, vi } from 'vitest'

import {
  ProviderBridgeClientError,
  ProviderBridgeClientV1,
} from '../../packages/bridge-types/src/provider-bridge-v1.js'

const providers = ['ollama', 'lmstudio', 'openai', 'claude', 'gemini'] as const

describe('provider bridge client v1', () => {
  it.each(providers)('uses the same credential-free model and inference methods for %s', async (providerId) => {
    const call = vi.fn(async (method: string, request: unknown) => {
      const input = request as { requestId: string; modelId?: string }
      if (method === 'providerListModelsV1') {
        return {
          schemaVersion: 1,
          status: 'completed',
          requestId: input.requestId,
          providerId,
          models: [{
            schemaVersion: 1,
            providerId,
            modelId: 'model-1',
            displayName: 'Model 1',
            capabilities: ['text.generate'],
            maxOutputTokens: null,
            status: 'available',
          }],
        }
      }
      return {
        schemaVersion: 1,
        status: 'completed',
        requestId: input.requestId,
        providerId,
        modelId: input.modelId,
        outputText: 'answer',
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          reasoningTokens: 0,
          totalTokens: 5,
          source: 'reported',
        },
      }
    })
    const client = new ProviderBridgeClientV1({ call })

    await expect(client.listModels({ schemaVersion: 1, requestId: 'models-1', providerId }))
      .resolves.toMatchObject({ status: 'completed', providerId })
    await expect(client.infer({
      schemaVersion: 1,
      requestId: 'inference-1',
      idempotencyKey: 'effect-1',
      providerId,
      modelId: 'model-1',
      messages: [{ role: 'user', content: 'Analyze the test.' }],
      maxOutputTokens: 128,
      requiredCapabilities: ['text.generate'],
    })).resolves.toMatchObject({ status: 'completed', providerId, modelId: 'model-1' })

    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'providerListModelsV1',
      'providerInferV1',
    ])
    expect(JSON.stringify(call.mock.calls)).not.toMatch(/apiKey|baseUrl|token/u)
  })

  it('normalizes cancellation without reflecting an agent error', async () => {
    const success = new ProviderBridgeClientV1({
      call: vi.fn().mockResolvedValue({ ok: true, cancellationRequested: true }),
    })
    await expect(success.cancel('request-1')).resolves.toEqual({ ok: true, cancellationRequested: true })

    const missing = new ProviderBridgeClientV1({
      call: vi.fn().mockResolvedValue({ ok: false, error: 'AI request not found.' }),
    })
    await expect(missing.cancel('request-2')).resolves.toEqual({ ok: false, code: 'not_found' })
  })

  it('fails closed for unsafe requests and malformed responses', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'completed', outputText: 'unversioned' })
    const client = new ProviderBridgeClientV1({ call })

    await expect(client.listModels({
      schemaVersion: 1,
      requestId: 'models-1',
      providerId: 'openai',
      apiKey: 'browser-secret',
    } as never)).rejects.toThrow(ProviderBridgeClientError)
    await expect(client.infer({
      schemaVersion: 1,
      requestId: 'inference-1',
      idempotencyKey: 'effect-1',
      providerId: 'openai',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
      requiredCapabilities: ['text.generate'],
    })).rejects.toThrow(ProviderBridgeClientError)
    await expect(client.cancel('../unsafe')).rejects.toThrow(ProviderBridgeClientError)
    expect(call).toHaveBeenCalledOnce()
  })

  it.each([
    ['request id', { requestId: 'other-request', providerId: 'openai', modelId: 'gpt-5' }],
    ['provider id', { requestId: 'inference-1', providerId: 'gemini', modelId: 'gpt-5' }],
    ['model id', { requestId: 'inference-1', providerId: 'openai', modelId: 'gpt-5-mini' }],
  ] as const)('rejects a structurally valid inference response with a mismatched %s', async (_label, identity) => {
    const client = new ProviderBridgeClientV1({
      call: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        status: 'completed',
        ...identity,
        outputText: 'answer',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 2,
          source: 'reported',
        },
      }),
    })

    await expect(client.infer({
      schemaVersion: 1,
      requestId: 'inference-1',
      idempotencyKey: 'effect-1',
      providerId: 'openai',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
      requiredCapabilities: ['text.generate'],
    })).rejects.toThrow(ProviderBridgeClientError)
  })

  it.each([
    ['request id', { requestId: 'other-request', providerId: 'openai' }],
    ['provider id', { requestId: 'models-1', providerId: 'claude' }],
  ] as const)('rejects a structurally valid model-list response with a mismatched %s', async (_label, identity) => {
    const client = new ProviderBridgeClientV1({
      call: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        status: 'completed',
        ...identity,
        models: [],
      }),
    })

    await expect(client.listModels({
      schemaVersion: 1,
      requestId: 'models-1',
      providerId: 'openai',
    })).rejects.toThrow(ProviderBridgeClientError)
  })
})
