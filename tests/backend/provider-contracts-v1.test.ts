import { describe, expect, it } from 'vitest'
import {
  PROVIDER_IDS_V1,
  ProviderContractValidationError,
  listProviderDescriptorsV1,
  supportsProviderCapabilitiesV1,
  validateProviderDescriptorV1,
  validateProviderInferenceOutcomeV1,
  validateProviderInferenceRequestV1,
  validateProviderModelListOutcomeV1,
  validateProviderModelListRequestV1,
} from '../../packages/contracts/src/providers/v1.js'

const request = {
  schemaVersion: 1,
  requestId: 'request-1',
  idempotencyKey: 'effect-1',
  providerId: 'gemini',
  modelId: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'Summarize this test failure.' }],
  maxOutputTokens: 512,
  requiredCapabilities: ['text.generate', 'usage.reasoning'],
} as const

describe('provider contracts v1', () => {
  it('defines the five canonical providers and negotiates capabilities', () => {
    expect(PROVIDER_IDS_V1).toEqual(['ollama', 'lmstudio', 'openai', 'claude', 'gemini'])
    expect(listProviderDescriptorsV1().map((descriptor) => descriptor.providerId)).toEqual(PROVIDER_IDS_V1)
    expect(listProviderDescriptorsV1().find((descriptor) => descriptor.providerId === 'ollama')?.transportClass).toBe('local-loopback')
    expect(listProviderDescriptorsV1().find((descriptor) => descriptor.providerId === 'openai')?.capabilities).toContain('usage.reasoning')
    expect(supportsProviderCapabilitiesV1(['text.generate', 'usage.reasoning'], request.requiredCapabilities)).toBe(true)
    expect(supportsProviderCapabilitiesV1(['text.generate'], request.requiredCapabilities)).toBe(false)
  })

  it('accepts secret-free Gemini reasoning usage', () => {
    expect(validateProviderInferenceRequestV1(request)).toEqual(request)
    expect(validateProviderInferenceOutcomeV1({
      schemaVersion: 1,
      status: 'completed',
      requestId: 'request-1',
      providerId: 'gemini',
      modelId: 'gemini-2.5-pro',
      outputText: 'The selector is stale.',
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 8, totalTokens: 38, source: 'reported' },
    })).toMatchObject({ status: 'completed', usage: { reasoningTokens: 8 } })
  })

  it('validates a provider-neutral model catalog response', () => {
    expect(validateProviderModelListRequestV1({
      schemaVersion: 1,
      requestId: 'models-1',
      providerId: 'ollama',
    })).toEqual({ schemaVersion: 1, requestId: 'models-1', providerId: 'ollama' })

    expect(validateProviderModelListOutcomeV1({
      schemaVersion: 1,
      status: 'completed',
      requestId: 'models-1',
      providerId: 'ollama',
      models: [{
        schemaVersion: 1,
        providerId: 'ollama',
        modelId: 'qwen2.5-coder:7b-instruct',
        displayName: 'qwen2.5-coder:7b-instruct',
        capabilities: ['text.generate', 'usage.reported', 'request.cancel.abort-signal'],
        maxOutputTokens: null,
        status: 'available',
      }],
    })).toMatchObject({ status: 'completed', providerId: 'ollama' })
  })

  it('rejects unknown fields, secret-shaped fields, invalid usage, and mismatched transport', () => {
    expect(() => validateProviderInferenceRequestV1({ ...request, key: 'do-not-accept' })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderInferenceRequestV1({ ...request, baseUrl: 'https://example.invalid' })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderInferenceOutcomeV1({
      schemaVersion: 1, status: 'completed', requestId: 'request-1', providerId: 'gemini', modelId: 'gemini-2.5-pro', outputText: 'x',
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3, totalTokens: 5, source: 'reported' },
    })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderDescriptorV1({
      schemaVersion: 1, providerId: 'ollama', displayName: 'Ollama', transportClass: 'cloud', capabilities: ['text.generate'],
    })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderInferenceRequestV1({ ...request, requiredCapabilities: [] })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderModelListRequestV1({ schemaVersion: 1, requestId: 'models-1', providerId: 'ollama', apiKey: 'secret' }))
      .toThrow(ProviderContractValidationError)
    expect(() => validateProviderModelListOutcomeV1({
      schemaVersion: 1,
      status: 'completed',
      requestId: 'models-1',
      providerId: 'ollama',
      models: [{
        schemaVersion: 1,
        providerId: 'openai',
        modelId: 'wrong-provider',
        displayName: null,
        capabilities: ['text.generate'],
        maxOutputTokens: null,
        status: 'available',
      }],
    })).toThrow(ProviderContractValidationError)
    expect(() => validateProviderInferenceOutcomeV1({
      schemaVersion: 1, status: 'completed', requestId: 'request-1', providerId: 'gemini', modelId: 'gemini-2.5-pro', outputText: 'x',
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3, totalTokens: 6, source: 'estimated' },
    })).toThrow(ProviderContractValidationError)
  })

  it('models cancellation without provider metadata', () => {
    expect(validateProviderInferenceOutcomeV1({ schemaVersion: 1, status: 'cancelled', requestId: 'request-1' }))
      .toEqual({ schemaVersion: 1, status: 'cancelled', requestId: 'request-1' })
    expect(validateProviderInferenceOutcomeV1({
      schemaVersion: 1, status: 'failed', requestId: 'request-1', code: 'rate_limited', retryable: true,
    })).toEqual({ schemaVersion: 1, status: 'failed', requestId: 'request-1', code: 'rate_limited', retryable: true })
    expect(() => validateProviderInferenceOutcomeV1({
      schemaVersion: 1, status: 'failed', requestId: 'request-1', code: 'raw-provider-secret', retryable: false,
    })).toThrow(ProviderContractValidationError)
  })
})
