// @vitest-environment node
import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  createFlowPairingProof,
  createFlowPairingPrechallengeProof,
  FLOW_PAIRING_PROOF_TTL_MS,
  flowPairingProofTranscript,
  flowPairingPrechallengeTranscript,
  type FlowPairingProofClaims,
  verifyFlowPairingProof,
  verifyFlowPairingPrechallengeProof,
} from '../../packages/agent/src/flow-pairing-proof'
import { FLOW_PROVIDER_PREVIEW_PRODUCT } from '../../packages/agent/src/flow-entitlement'

const token = 'a'.repeat(43)
const now = 1_800_000_000_000
const claims: FlowPairingProofClaims = {
  origin: 'https://flow.xyva.ai',
  product: FLOW_PROVIDER_PREVIEW_PRODUCT,
  port: 7900,
  pairingTokenHash: crypto.createHash('sha256').update(token, 'ascii').digest('hex'),
  clientNonce: 'n'.repeat(43),
  challengeId: 'c'.repeat(43),
  issuedAt: now,
  expiresAt: now + FLOW_PAIRING_PROOF_TTL_MS,
}

const expectedTranscript = [
  'XYVA-FLOW-AGENT-POP-V1',
  'origin=https://flow.xyva.ai',
  `product=${FLOW_PROVIDER_PREVIEW_PRODUCT}`,
  'port=7900',
  'pairingTokenHash=66d34fba71f8f450f7e45598853e53bfc23bbd129027cbb131a2f4ffd7878cd0',
  `clientNonce=${'n'.repeat(43)}`,
  `challengeId=${'c'.repeat(43)}`,
  'issuedAt=1800000000000',
  'expiresAt=1800000030000',
].join('\n')
const expectedProof = 'KcRSTxnQGKRhUIimCVG2VecoCi3yaGaG5TrfAwjsChg'
const prechallengeClaims = {
  origin: claims.origin,
  product: claims.product,
  port: claims.port,
  pairingTokenHash: claims.pairingTokenHash,
  clientNonce: claims.clientNonce,
}
const expectedPrechallengeTranscript = [
  'XYVA-FLOW-AGENT-PRECHALLENGE-V1',
  'origin=https://flow.xyva.ai',
  `product=${FLOW_PROVIDER_PREVIEW_PRODUCT}`,
  'port=7900',
  'pairingTokenHash=66d34fba71f8f450f7e45598853e53bfc23bbd129027cbb131a2f4ffd7878cd0',
  `clientNonce=${'n'.repeat(43)}`,
].join('\n')
const expectedPrechallengeProof = 'M61HtDLUeLJbVcgRQwmBNWZo7lhC7Uy06cWVw3HFckI'

describe('Flow pairing proof of possession', () => {
  it('requires a fixed port-bound token proof before issuing a challenge', () => {
    expect(flowPairingPrechallengeTranscript(prechallengeClaims)).toBe(expectedPrechallengeTranscript)
    expect(createFlowPairingPrechallengeProof(token, prechallengeClaims)).toBe(expectedPrechallengeProof)
    expect(verifyFlowPairingPrechallengeProof(token, prechallengeClaims, expectedPrechallengeProof)).toBe(true)
    expect(verifyFlowPairingPrechallengeProof(token, { ...prechallengeClaims, port: 7901 }, expectedPrechallengeProof)).toBe(false)
    expect(verifyFlowPairingPrechallengeProof('b'.repeat(43), prechallengeClaims, expectedPrechallengeProof)).toBe(false)
  })
  it('uses the fixed versioned transcript and an ASCII-token HMAC-SHA256 base64url vector', () => {
    expect(flowPairingProofTranscript(claims)).toBe(expectedTranscript)
    expect(createFlowPairingProof(token, claims)).toBe(expectedProof)
    expect(verifyFlowPairingProof(token, claims, expectedProof, now)).toBe(true)
    expect(expectedProof).not.toContain(token)
    expect(JSON.stringify({ proof: expectedProof })).not.toContain(token)
  })

  it('binds origin, product, port, token hash, nonce, challenge, time, and key', () => {
    const proof = createFlowPairingProof(token, claims)
    expect(proof).toBe(expectedProof)

    const mutations: FlowPairingProofClaims[] = [
      { ...claims, origin: 'https://other.xyva.ai' },
      { ...claims, product: 'other-product' as typeof FLOW_PROVIDER_PREVIEW_PRODUCT },
      { ...claims, port: 7901 },
      { ...claims, pairingTokenHash: '0'.repeat(64) },
      { ...claims, clientNonce: 'x'.repeat(43) },
      { ...claims, challengeId: 'y'.repeat(43) },
      { ...claims, issuedAt: now + 1, expiresAt: now + 1 + FLOW_PAIRING_PROOF_TTL_MS },
      { ...claims, expiresAt: now + FLOW_PAIRING_PROOF_TTL_MS - 1 },
    ]
    for (const mutated of mutations) {
      expect(verifyFlowPairingProof(token, mutated, proof!, now)).toBe(false)
    }
    expect(verifyFlowPairingProof('b'.repeat(43), claims, proof!, now)).toBe(false)
  })

  it('fails closed for invalid fields, malformed proof values, and challenge times outside the exact TTL', () => {
    const proof = createFlowPairingProof(token, claims)
    const invalid = [
      { ...claims, origin: 'http://flow.xyva.ai' },
      { ...claims, origin: 'https://flow.xyva.ai/path' },
      { ...claims, port: 0 },
      { ...claims, port: 65_536 },
      { ...claims, pairingTokenHash: 'A'.repeat(64) },
      { ...claims, clientNonce: 'short' },
      { ...claims, challengeId: 'short' },
      { ...claims, issuedAt: -1 },
      { ...claims, expiresAt: now + FLOW_PAIRING_PROOF_TTL_MS + 1 },
    ]
    for (const candidate of invalid) {
      expect(createFlowPairingProof(token, candidate)).toBeNull()
      expect(verifyFlowPairingProof(token, candidate, proof!, now)).toBe(false)
    }
    expect(createFlowPairingProof('short', claims)).toBeNull()
    expect(createFlowPairingProof(token, { ...claims, pairingTokenHash: '0'.repeat(64) })).toBeNull()
    expect(verifyFlowPairingProof(token, claims, 'not-a-proof', now)).toBe(false)
    expect(verifyFlowPairingProof(token, claims, proof!, now - 1)).toBe(false)
    expect(verifyFlowPairingProof(token, claims, proof!, claims.expiresAt)).toBe(false)
  })

  it('allows HTTP only for exact loopback development origins', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
      const loopbackClaims = { ...claims, origin }
      const proof = createFlowPairingProof(token, loopbackClaims)
      expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(verifyFlowPairingProof(token, loopbackClaims, proof!, now)).toBe(true)
    }
    for (const origin of ['http://flow.xyva.ai', 'http://192.168.1.20:5173']) {
      expect(createFlowPairingProof(token, { ...claims, origin })).toBeNull()
    }
  })
})
