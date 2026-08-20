import crypto from 'node:crypto'

import { FLOW_PROVIDER_PREVIEW_PRODUCT, flowPairingTokenHash } from './flow-entitlement'

export const FLOW_PAIRING_PROOF_TTL_MS = 30_000

const TRANSCRIPT_PREFIX = 'XYVA-FLOW-AGENT-POP-V1'
const PRECHALLENGE_TRANSCRIPT_PREFIX = 'XYVA-FLOW-AGENT-PRECHALLENGE-V1'
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const HASH = /^[a-f0-9]{64}$/u
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/u

export interface FlowPairingProofClaims {
  readonly origin: string
  readonly product: typeof FLOW_PROVIDER_PREVIEW_PRODUCT
  readonly port: number
  readonly pairingTokenHash: string
  readonly clientNonce: string
  readonly challengeId: string
  readonly issuedAt: number
  readonly expiresAt: number
}

export type FlowPairingPrechallengeClaims = Omit<
  FlowPairingProofClaims,
  'challengeId' | 'issuedAt' | 'expiresAt'
>

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function exactProductOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    const secureOrigin = url.protocol === 'https:'
    const loopbackOrigin = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
    if ((!secureOrigin && !loopbackOrigin) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.origin !== value) return null
    return url.origin
  } catch {
    return null
  }
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validatedPrechallengeClaims(
  value: FlowPairingPrechallengeClaims,
): FlowPairingPrechallengeClaims | null {
  if (exactProductOrigin(value.origin) === null
    || value.product !== FLOW_PROVIDER_PREVIEW_PRODUCT
    || !validPort(value.port)
    || !HASH.test(value.pairingTokenHash)
    || !TOKEN.test(value.clientNonce)) return null
  return value
}

function validatedClaims(value: FlowPairingProofClaims): FlowPairingProofClaims | null {
  if (exactProductOrigin(value.origin) === null
    || value.product !== FLOW_PROVIDER_PREVIEW_PRODUCT
    || !validPort(value.port)
    || !HASH.test(value.pairingTokenHash)
    || !TOKEN.test(value.clientNonce)
    || !TOKEN.test(value.challengeId)
    || !validEpoch(value.issuedAt)
    || !validEpoch(value.expiresAt)
    || value.expiresAt !== value.issuedAt + FLOW_PAIRING_PROOF_TTL_MS) return null
  return value
}

/**
 * Serializes exactly the fields that bind a Flow pairing proof. Every field is
 * validated first, so delimiters cannot be injected into the transcript.
 */
export function flowPairingProofTranscript(claims: FlowPairingProofClaims): string | null {
  const valid = validatedClaims(claims)
  if (valid === null) return null
  return [
    TRANSCRIPT_PREFIX,
    `origin=${valid.origin}`,
    `product=${valid.product}`,
    `port=${String(valid.port)}`,
    `pairingTokenHash=${valid.pairingTokenHash}`,
    `clientNonce=${valid.clientNonce}`,
    `challengeId=${valid.challengeId}`,
    `issuedAt=${String(valid.issuedAt)}`,
    `expiresAt=${String(valid.expiresAt)}`,
  ].join('\n')
}

/** Serializes the browser's token proof before an Agent challenge is issued. */
export function flowPairingPrechallengeTranscript(
  claims: FlowPairingPrechallengeClaims,
): string | null {
  const valid = validatedPrechallengeClaims(claims)
  if (valid === null) return null
  return [
    PRECHALLENGE_TRANSCRIPT_PREFIX,
    `origin=${valid.origin}`,
    `product=${valid.product}`,
    `port=${String(valid.port)}`,
    `pairingTokenHash=${valid.pairingTokenHash}`,
    `clientNonce=${valid.clientNonce}`,
  ].join('\n')
}

function validPairingTokenForClaims(pairingToken: string, claims: FlowPairingProofClaims): boolean {
  if (!TOKEN.test(pairingToken)) return false
  const hash = flowPairingTokenHash(pairingToken)
  return hash !== null && hash === claims.pairingTokenHash
}

function calculateProof(pairingToken: string, claims: FlowPairingProofClaims): string | null {
  const transcript = flowPairingProofTranscript(claims)
  if (transcript === null || !validPairingTokenForClaims(pairingToken, claims)) return null
  return crypto.createHmac('sha256', pairingToken, { encoding: 'ascii' })
    .update(transcript, 'ascii')
    .digest('base64url')
}

function calculatePrechallengeProof(
  pairingToken: string,
  claims: FlowPairingPrechallengeClaims,
): string | null {
  const transcript = flowPairingPrechallengeTranscript(claims)
  if (transcript === null || !TOKEN.test(pairingToken)
    || flowPairingTokenHash(pairingToken) !== claims.pairingTokenHash) return null
  return crypto.createHmac('sha256', pairingToken, { encoding: 'ascii' })
    .update(transcript, 'ascii')
    .digest('base64url')
}

/** Creates the browser's port-bound proof required to request an Agent challenge. */
export function createFlowPairingPrechallengeProof(
  pairingToken: string,
  claims: FlowPairingPrechallengeClaims,
): string | null {
  return calculatePrechallengeProof(pairingToken, claims)
}

export function verifyFlowPairingPrechallengeProof(
  pairingToken: string,
  claims: FlowPairingPrechallengeClaims,
  proof: string,
): boolean {
  if (!BASE64URL_SHA256.test(proof)) return false
  const expected = calculatePrechallengeProof(pairingToken, claims)
  if (expected === null || expected.length !== proof.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(proof, 'ascii'))
}

/** Creates an opaque base64url HMAC proof and never returns the pairing token. */
export function createFlowPairingProof(pairingToken: string, claims: FlowPairingProofClaims): string | null {
  return calculateProof(pairingToken, claims)
}

/**
 * Verifies a proof for one exact, 30-second Flow challenge. Invalid input and
 * expired/not-yet-valid challenges fail closed without exposing secret state.
 */
export function verifyFlowPairingProof(
  pairingToken: string,
  claims: FlowPairingProofClaims,
  proof: string,
  nowEpochMs: number,
): boolean {
  const valid = validatedClaims(claims)
  if (valid === null || !validEpoch(nowEpochMs) || nowEpochMs < valid.issuedAt
    || nowEpochMs >= valid.expiresAt || !BASE64URL_SHA256.test(proof)) return false
  const expected = calculateProof(pairingToken, valid)
  if (expected === null || expected.length !== proof.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(proof, 'ascii'))
}
