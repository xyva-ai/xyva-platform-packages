// @vitest-environment node
import crypto from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  consumeFlowEntitlement,
  flowPairingTokenHash,
  FLOW_PROVIDER_PREVIEW_PRODUCT,
} from '../../packages/agent/src/flow-entitlement'

const pairingToken = 'p'.repeat(43)
const grant = 'g'.repeat(43)
const sessionFamilyBinding = 's'.repeat(43)
const now = 1_800_000_000_000
const consumeUrl = new URL('http://127.0.0.1:7999/v1/agent-entitlement-grants/consume')

function success(leaseExpiresAt = now + 300_000): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, consumed: true, leaseExpiresAt }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Flow entitlement backchannel', () => {
  it('proves possession of the exact pairing token only to the fixed HTTPS consume endpoint', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success())
    await expect(consumeFlowEntitlement({
      browserOrigin: 'https://flow.xyva.ai',
      entitlementGrant: grant,
      pairingToken,
      sessionFamilyBinding,
    }, { fetch: fetch as typeof globalThis.fetch, nowEpochMs: () => now, consumeUrl }))
      .resolves.toEqual({ leaseExpiresAt: now + 300_000 })

    expect(fetch).toHaveBeenCalledWith(consumeUrl, expect.objectContaining({
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
    }))
    const request = fetch.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body))
    expect(body).toEqual({
      schemaVersion: 1,
      grant,
      product: FLOW_PROVIDER_PREVIEW_PRODUCT,
      browserOrigin: 'https://flow.xyva.ai',
      pairingToken,
      sessionFamilyBinding,
    })
    expect(body).not.toHaveProperty('pairingTokenHash')
    expect(flowPairingTokenHash(pairingToken)).toBe(
      crypto.createHash('sha256').update(pairingToken, 'ascii').digest('hex'),
    )
  })

  it('changes the challenge for a different local pairing token', () => {
    expect(flowPairingTokenHash(pairingToken)).toMatch(/^[a-f0-9]{64}$/)
    expect(flowPairingTokenHash(pairingToken)).not.toBe(flowPairingTokenHash('q'.repeat(43)))
  })

  it('fails closed before network I/O for malformed grants, bindings, or browser origins', async () => {
    const fetch = vi.fn()
    for (const input of [
      { browserOrigin: 'http://flow.xyva.ai', entitlementGrant: grant, pairingToken, sessionFamilyBinding },
      { browserOrigin: 'https://flow.xyva.ai/path', entitlementGrant: grant, pairingToken, sessionFamilyBinding },
      { browserOrigin: 'https://flow.xyva.ai', entitlementGrant: 'short', pairingToken, sessionFamilyBinding },
      { browserOrigin: 'https://flow.xyva.ai', entitlementGrant: grant, pairingToken, sessionFamilyBinding: 'short' },
    ]) {
      await expect(consumeFlowEntitlement(input, {
        fetch: fetch as typeof globalThis.fetch, nowEpochMs: () => now, consumeUrl,
      })).resolves.toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects non-success, malformed, oversized, and overlong lease responses without reflecting details', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'private detail' }), { status: 401, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ schemaVersion: 1, consumed: true, leaseExpiresAt: now + 1_000, extra: true }), { headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ padding: 'x'.repeat(4_096) }), { headers: { 'content-type': 'application/json' } }),
      success(now + 300_001),
    ]
    for (const response of responses) {
      await expect(consumeFlowEntitlement({
        browserOrigin: 'https://flow.xyva.ai', entitlementGrant: grant, pairingToken, sessionFamilyBinding,
      }, { fetch: vi.fn(async () => response) as typeof globalThis.fetch, nowEpochMs: () => now, consumeUrl }))
        .resolves.toBeNull()
    }
  })
})
