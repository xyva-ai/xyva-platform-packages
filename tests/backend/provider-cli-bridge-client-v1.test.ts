import { describe, expect, it, vi } from 'vitest'

import { ProviderCliBridgeClientError, ProviderCliBridgeClientV1 } from '../../packages/bridge-types/src/provider-cli-bridge-v1.js'

describe('provider CLI bridge client v1', () => {
  it('uses only the versioned credential-free CLI methods', async () => {
    const call = vi.fn(async (method: string, request: unknown) => {
      const input = request as { requestId: string }
      if (method === 'providerCliCapabilitiesV1') return { schemaVersion: 1, status: 'completed', requestId: input.requestId, capabilities: [{ schemaVersion: 1, providerId: 'codex', installed: true, authenticated: true, enabled: true, modes: ['read_only'] }] }
      if (method === 'providerCliCancelV1') return { schemaVersion: 1, status: 'completed', requestId: input.requestId, cancellationRequested: true }
      return { schemaVersion: 1, status: 'completed', requestId: input.requestId, providerId: 'codex', outputText: 'synthetic', inputTokens: 1, outputTokens: 1 }
    })
    const client = new ProviderCliBridgeClientV1({ call })
    await expect(client.capabilities({ schemaVersion: 1, requestId: 'cap-1' })).resolves.toMatchObject({ status: 'completed' })
    await expect(client.infer({ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' })).resolves.toMatchObject({ status: 'completed' })
    await expect(client.cancel({ schemaVersion: 1, requestId: 'infer-1' })).resolves.toMatchObject({ cancellationRequested: true })
    expect(JSON.stringify(call.mock.calls)).not.toMatch(/key|token|password|path|cwd/iu)
  })

  it('fails closed for malformed or mismatched responses', async () => {
    const client = new ProviderCliBridgeClientV1({ call: vi.fn().mockResolvedValue({ schemaVersion: 1, status: 'completed', requestId: 'other', providerId: 'codex', outputText: 'x', inputTokens: 0, outputTokens: 0 }) })
    await expect(client.infer({ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' })).rejects.toThrow(ProviderCliBridgeClientError)
    await expect(client.infer({ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'write', prompt: 'synthetic' } as never)).rejects.toThrow(ProviderCliBridgeClientError)
  })
})
