import crypto from 'node:crypto'

export const FLOW_PROVIDER_PREVIEW_PRODUCT = 'flow-provider-preview.v1' as const

const FLOW_PAIRING_TOKEN = /^[A-Za-z0-9_-]{43}$/u
const FLOW_ENTITLEMENT_GRANT = /^[A-Za-z0-9_-]{43}$/u
const FLOW_SESSION_FAMILY_BINDING = /^[A-Za-z0-9_-]{43}$/u
const SHA256_HEX = /^[a-f0-9]{64}$/u
const MAXIMUM_RESPONSE_BYTES = 4_096
const CONSUME_TIMEOUT_MS = 5_000
const MAXIMUM_FLOW_LEASE_MS = 5 * 60_000

export interface FlowEntitlementConsumeInput {
  readonly browserOrigin: string
  readonly entitlementGrant: string
  readonly pairingToken: string
  readonly sessionFamilyBinding: string
}

export interface FlowEntitlementConsumeResult {
  readonly leaseExpiresAt: number
}

interface FlowEntitlementDependencies {
  readonly fetch?: typeof fetch
  readonly nowEpochMs?: () => number
  readonly consumeUrl?: URL
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null
}

function loopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function exactOrigin(value: string): URL | null {
  try {
    const url = new URL(value)
    const testLoopback = process.env.NODE_ENV === 'test'
      && url.protocol === 'http:'
      && loopbackHost(url.hostname)
    if ((!testLoopback && url.protocol !== 'https:') || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.origin !== value) return null
    return url
  } catch {
    return null
  }
}

function validatedConsumeUrl(browserOrigin: URL, override?: URL): URL | null {
  const candidate = override ?? new URL('/v1/agent-entitlement-grants/consume', browserOrigin)
  const testLoopback = process.env.NODE_ENV === 'test'
    && candidate.protocol === 'http:'
    && loopbackHost(candidate.hostname)
  if ((!testLoopback && candidate.protocol !== 'https:') || candidate.username || candidate.password
    || candidate.search || candidate.hash
    || candidate.pathname !== '/v1/agent-entitlement-grants/consume') return null
  if (override === undefined && candidate.origin !== browserOrigin.origin) return null
  if (override !== undefined && process.env.NODE_ENV !== 'test') return null
  return candidate
}

function configuredTestConsumeUrl(): URL | undefined {
  if (process.env.NODE_ENV !== 'test' || !process.env.XYVA_AGENT_FLOW_ENTITLEMENT_TEST_URL) return undefined
  try {
    return new URL(process.env.XYVA_AGENT_FLOW_ENTITLEMENT_TEST_URL)
  } catch {
    return undefined
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new Error('invalid_response')
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAXIMUM_RESPONSE_BYTES) throw new Error('invalid_response')
  return JSON.parse(body) as unknown
}

export function flowPairingTokenHash(pairingToken: string): string | null {
  if (!FLOW_PAIRING_TOKEN.test(pairingToken)) return null
  const hash = crypto.createHash('sha256').update(pairingToken, 'ascii').digest('hex')
  return SHA256_HEX.test(hash) ? hash : null
}

/**
 * Consumes a Flow-issued one-time grant over an exact HTTPS backchannel.
 * All transport and parsing failures intentionally collapse to a fail-closed
 * null result; neither the grant nor its challenge is reflected to callers.
 */
export async function consumeFlowEntitlement(
  input: FlowEntitlementConsumeInput,
  dependencies: FlowEntitlementDependencies = {},
): Promise<FlowEntitlementConsumeResult | null> {
  const origin = exactOrigin(input.browserOrigin)
  const pairingTokenHash = flowPairingTokenHash(input.pairingToken)
  if (origin === null || pairingTokenHash === null
    || !FLOW_ENTITLEMENT_GRANT.test(input.entitlementGrant)
    || !FLOW_SESSION_FAMILY_BINDING.test(input.sessionFamilyBinding)) return null
  const url = validatedConsumeUrl(origin, dependencies.consumeUrl ?? configuredTestConsumeUrl())
  if (url === null) return null

  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const nowEpochMs = dependencies.nowEpochMs ?? Date.now
  if (typeof fetchImpl !== 'function' || typeof nowEpochMs !== 'function') return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONSUME_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const before = nowEpochMs()
    if (!Number.isSafeInteger(before) || before < 0) return null
    const response = await fetchImpl(url, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        grant: input.entitlementGrant,
        product: FLOW_PROVIDER_PREVIEW_PRODUCT,
        browserOrigin: origin.origin,
        pairingToken: input.pairingToken,
        sessionFamilyBinding: input.sessionFamilyBinding,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = exactRecord(await boundedJson(response), ['schemaVersion', 'consumed', 'leaseExpiresAt'])
    if (payload === null || payload.schemaVersion !== 1 || payload.consumed !== true
      || !Number.isSafeInteger(payload.leaseExpiresAt)) return null
    const after = nowEpochMs()
    const leaseExpiresAt = payload.leaseExpiresAt as number
    if (!Number.isSafeInteger(after) || after < before || leaseExpiresAt <= after
      || leaseExpiresAt > after + MAXIMUM_FLOW_LEASE_MS) return null
    return { leaseExpiresAt }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
