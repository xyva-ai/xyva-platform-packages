import { describe, expect, it } from 'vitest'

import {
  ProviderCliContractValidationError,
  validateProviderCliCancellationOutcomeV1,
  validateProviderCliCapabilitiesOutcomeV1,
  validateProviderCliInferenceOutcomeV1,
  validateProviderCliInferenceRequestV1,
} from '../../packages/contracts/src/providers/cli-v1.js'

describe('provider CLI contracts v1', () => {
  it('accepts the three official provider identifiers but only read-only, secret-free requests', () => {
    expect(validateProviderCliInferenceRequestV1({
      schemaVersion: 1, requestId: 'cli-1', providerId: 'codex', mode: 'read_only', prompt: 'Summarize this synthetic failure.',
    })).toMatchObject({ providerId: 'codex', mode: 'read_only' })
    expect(validateProviderCliInferenceRequestV1({
      schemaVersion: 1, requestId: 'claude-1', providerId: 'claude', mode: 'read_only', prompt: 'Synthetic only.',
    })).toMatchObject({ providerId: 'claude' })
    expect(validateProviderCliInferenceRequestV1({
      schemaVersion: 1, requestId: 'gemini-1', providerId: 'gemini', mode: 'read_only', prompt: 'Synthetic only.',
    })).toMatchObject({ providerId: 'gemini' })
    expect(validateProviderCliInferenceOutcomeV1({
      schemaVersion: 1, status: 'completed', requestId: 'cli-1', providerId: 'codex', outputText: 'Synthetic response.', inputTokens: 2, outputTokens: 3,
    })).toMatchObject({ status: 'completed', providerId: 'codex' })
    expect(validateProviderCliCapabilitiesOutcomeV1({
      schemaVersion: 1, status: 'completed', requestId: 'cap-1', capabilities: [{ schemaVersion: 1, providerId: 'codex', installed: true, authenticated: null, enabled: false, modes: ['read_only'] }],
    })).toMatchObject({ status: 'completed' })
    expect(validateProviderCliCancellationOutcomeV1({ schemaVersion: 1, status: 'completed', requestId: 'cli-1', cancellationRequested: true }))
      .toMatchObject({ status: 'completed' })
  })

  it('fails closed for an unknown CLI, secret-shaped fields, unsafe modes, and malformed outcomes', () => {
    const request = { schemaVersion: 1, requestId: 'cli-1', providerId: 'codex', mode: 'read_only', prompt: 'safe' }
    expect(() => validateProviderCliInferenceRequestV1({ ...request, providerId: 'unknown-cli' })).toThrow(ProviderCliContractValidationError)
    expect(() => validateProviderCliInferenceRequestV1({ ...request, mode: 'write' })).toThrow(ProviderCliContractValidationError)
    expect(() => validateProviderCliInferenceRequestV1({ ...request, apiKey: 'secret' })).toThrow(ProviderCliContractValidationError)
    expect(() => validateProviderCliInferenceRequestV1({ ...request, workingDirectory: '/tmp' })).toThrow(ProviderCliContractValidationError)
    expect(() => validateProviderCliInferenceOutcomeV1({ schemaVersion: 1, status: 'completed', requestId: 'cli-1', providerId: 'codex', outputText: 'x', inputTokens: 1, outputTokens: 1, stderr: 'secret' }))
      .toThrow(ProviderCliContractValidationError)
    expect(() => validateProviderCliCancellationOutcomeV1({ schemaVersion: 1, status: 'failed', requestId: 'cli-1', code: 'adapter_error', retryable: false }))
      .toThrow(ProviderCliContractValidationError)
  })
})
