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

  it('sends tenant-bound job commands without leaking workspace routing into the body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createPlatformClient({
      baseUrl: 'https://api.xyva.ai',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify({ job: {
          jobId: 'job_1', state: 'queued', createdAt: '2026-10-03T00:00:00.000Z',
          correlationId: 'corr_1', resultReference: null,
        } }), { status: 202, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.startJob({
      workspaceId: 'ws_1', productId: 'flow', integrationId: 'qa-studio',
      capability: 'quality.read', idempotencyKey: 'job-request-1',
    })).resolves.toMatchObject({ jobId: 'job_1' })
    expect(calls[0]?.url).toBe('https://api.xyva.ai/v1/workspaces/ws_1/jobs')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      productId: 'flow', integrationId: 'qa-studio', capability: 'quality.read', idempotencyKey: 'job-request-1',
    })

    await expect(client.cancelJob('ws_1', 'job_1')).resolves.toMatchObject({ jobId: 'job_1' })
    expect(calls[1]?.url).toBe('https://api.xyva.ai/v1/workspaces/ws_1/jobs/job_1/cancel')
  })
})
