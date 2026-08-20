import crypto from 'node:crypto'

export interface VerifiedLicenseClaims {
  aud: 'xyva-agent'
  iss: string
  sub: string
  tier: string
  machineId: string
  seats: number
  iat: number
  exp: number
}

type LicenseTokenHeader = {
  alg: 'EdDSA'
  kid: string
  typ: 'JWT'
}

const PRODUCTION_LICENSE_ISSUERS = ['https://qa.xyva.ai', 'https://xyva.ai'] as const
const LEGACY_PRODUCTION_LICENSE_ISSUER = 'https://xyva.ai'
const LICENSE_ISSUER_MIGRATION_SUNSET = '2027-03-01T00:00:00.000Z'

type TrustedLicenseKey = {
  issuers: readonly string[]
  legacyIssuer?: string
  legacyIssuerSunset?: string
  publicKey: string
}

const TRUSTED_LICENSE_KEYS: Record<string, TrustedLicenseKey> = {
  'xyva-prod-2026-01': {
    issuers: PRODUCTION_LICENSE_ISSUERS,
    legacyIssuer: LEGACY_PRODUCTION_LICENSE_ISSUER,
    legacyIssuerSunset: LICENSE_ISSUER_MIGRATION_SUNSET,
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA33s6/XsZh+BXEQDMm1npNYtSEPzkvCPbu9uxm2H2RkU=\n-----END PUBLIC KEY-----',
  },
  'xyva-staging-2026-01': {
    issuers: ['https://staging.194.164.193.230.sslip.io'],
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAdNOKVmJzA9niHVFYcpw+10VibF5+a+vZnNFSAC6dVmc=\n-----END PUBLIC KEY-----',
  },
}

function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

function normalizeIssuer(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function isProfileIssuerAllowed(profile: TrustedLicenseKey, issuer: string, nowMs: number) {
  if (!profile.issuers.includes(issuer)) return false
  if (issuer !== profile.legacyIssuer) return true
  const sunset = profile.legacyIssuerSunset ? Date.parse(profile.legacyIssuerSunset) : Number.NaN
  return Number.isFinite(sunset) && nowMs < sunset
}

export function isExpectedLicenseIssuer(
  expectedIssuer: string,
  tokenIssuer: string,
  keyId: string,
  nowMs = Date.now(),
) {
  if (expectedIssuer === tokenIssuer) return true
  const profile = TRUSTED_LICENSE_KEYS[keyId]
  return Boolean(
    profile
    && isProfileIssuerAllowed(profile, expectedIssuer, nowMs)
    && isProfileIssuerAllowed(profile, tokenIssuer, nowMs),
  )
}

function resolveTrustedKey(header: Partial<LicenseTokenHeader>, issuer: string, nowMs: number) {
  if (typeof header.kid !== 'string') {
    return null
  }

  const trusted = TRUSTED_LICENSE_KEYS[header.kid]
  if (trusted) {
    return isProfileIssuerAllowed(trusted, issuer, nowMs) ? trusted.publicKey : null
  }

  if (
    header.kid === 'xyva-test'
    && process.env.NODE_ENV === 'test'
    && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(issuer)
  ) {
    return process.env.XYVA_LICENSE_TEST_PUBLIC_KEY?.replace(/\\n/g, '\n') || null
  }

  return null
}

export function verifyLicenseToken(
  token: string,
  options: { portalUrl: string; machineId?: string; nowMs?: number },
): { ok: true; claims: VerifiedLicenseClaims } | { ok: false; error: string } {
  const [encodedHeader, encodedPayload, signature, ...rest] = token.split('.')
  if (!encodedHeader || !encodedPayload || !signature || rest.length > 0) {
    return { ok: false, error: 'Invalid token format' }
  }

  const header = decodeJson<Partial<LicenseTokenHeader>>(encodedHeader)
  const claims = decodeJson<Partial<VerifiedLicenseClaims>>(encodedPayload)
  if (!header || !claims || header.alg !== 'EdDSA' || header.typ !== 'JWT') {
    return { ok: false, error: 'Unsupported license token' }
  }

  const expectedIssuer = normalizeIssuer(options.portalUrl)
  const tokenIssuer = typeof claims.iss === 'string' ? normalizeIssuer(claims.iss) : null
  const nowMs = options.nowMs ?? Date.now()
  if (
    !expectedIssuer
    || !tokenIssuer
    || typeof header.kid !== 'string'
    || !isExpectedLicenseIssuer(expectedIssuer, tokenIssuer, header.kid, nowMs)
  ) {
    return { ok: false, error: 'License issuer mismatch' }
  }

  const publicKey = resolveTrustedKey(header, tokenIssuer, nowMs)
  if (!publicKey) {
    return { ok: false, error: 'Untrusted license signing key' }
  }

  let validSignature = false
  try {
    validSignature = crypto.verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      crypto.createPublicKey(publicKey),
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return { ok: false, error: 'Invalid license signature' }
  }

  if (!validSignature) {
    return { ok: false, error: 'Invalid license signature' }
  }

  if (
    claims.aud !== 'xyva-agent'
    || typeof claims.sub !== 'string'
    || typeof claims.tier !== 'string'
    || typeof claims.machineId !== 'string'
    || typeof claims.seats !== 'number'
    || !Number.isInteger(claims.seats)
    || claims.seats < 1
    || typeof claims.iat !== 'number'
    || typeof claims.exp !== 'number'
  ) {
    return { ok: false, error: 'Invalid license claims' }
  }

  const nowSeconds = Math.floor(nowMs / 1000)
  if (claims.iat > nowSeconds + 300) {
    return { ok: false, error: 'License issued in the future' }
  }
  if (claims.exp <= nowSeconds) {
    return { ok: false, error: 'License token expired' }
  }
  if (options.machineId && claims.machineId !== options.machineId) {
    return { ok: false, error: 'License machine mismatch' }
  }

  return { ok: true, claims: claims as VerifiedLicenseClaims }
}
