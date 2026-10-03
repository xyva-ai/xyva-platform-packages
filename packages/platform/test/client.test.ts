import { describe, expect, it } from 'vitest'

import { PlatformClientError, createPlatformClient, type ProductAdapterDescriptorV1, type ProductIntegrationRequestV1 } from '../src/index.js'

describe('@xyva/platform client', () => {
  it('exposes versioned adapter and integration contracts without runtime credentials', () => {
    const adapter: ProductAdapterDescriptorV1 = {
      schemaVersion: 1,
      productId: 'flow',
      adapterVersion: '0.1.18-rc1',
      capabilities: ['workflow.validate'],
    }
    const request: ProductIntegrationRequestV1 = {
      schemaVersion: 1,
      workspaceId: 'ws_1',
      productId: 'flow',
      adapterVersion: adapter.adapterVersion,
      integrationId: 'qa-studio',
      capability: 'workflow.validate',
      correlationId: 'corr_0001',
      requestId: 'req_0001',
    }
    expect(request.productId).toBe(adapter.productId)
    expect(request.capability).toBe(adapter.capabilities[0])
  })

  it('uses the versioned API root and retains only typed read contracts', async () => {
    const requests: string[] = []
    const client = createPlatformClient({
      baseUrl: 'https://api.xyva.ai',
      fetch: async (input) => {
        requests.push(String(input))
        return new Response(JSON.stringify([{ workspaceId: 'ws_1', name: 'XYVA', membershipRole: 'owner' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(client.listWorkspaces()).resolves.toEqual([{ workspaceId: 'ws_1', name: 'XYVA', membershipRole: 'owner' }])
    expect(requests).toEqual(['https://api.xyva.ai/v1/workspaces'])
  })

  it('rejects unsafe base URLs and identifiers before a request is made', () => {
    expect(() => createPlatformClient({ baseUrl: 'http://api.xyva.ai' })).toThrow('HTTPS')
    expect(() => createPlatformClient({ baseUrl: 'https://user:password@api.xyva.ai' })).toThrow('without credentials')
    expect(() => createPlatformClient({ baseUrl: 'not a url' })).toThrow('absolute HTTPS')
  })

  it('exposes status and correlation ID without parsing error payloads', async () => {
    const client = createPlatformClient({
      baseUrl: 'https://api.xyva.ai',
      fetch: async () => new Response(null, { status: 403, headers: { 'x-correlation-id': 'corr_1' } }),
    })

    await expect(client.getJob('job_1')).rejects.toEqual(new PlatformClientError('XYVA platform request failed', 403, 'corr_1'))
  })
})
