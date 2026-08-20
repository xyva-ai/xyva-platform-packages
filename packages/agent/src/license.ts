import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AgentLicenseGuardStatus } from '@xyva/bridge-types'

import type { AgentCredentials } from './auth.js'
import { getXyvaDir } from './auth.js'
import { verifyLicenseToken, type VerifiedLicenseClaims } from './license-signature.js'
import { writePrivateFile } from './secure-store.js'

export interface LicenseState {
  token: string | null
  tier: string | null
  expiresAt: number
  lastValidated: number
  offlineSince: number | null
}

type StoredLicenseFile =
  | {
      version: 1
      source: 'legacy'
      legacyKey: string
      lastValidated: number
      offlineSince: number | null
    }
  | {
      version: 1
      source: 'jwt'
      token: string
      tier: string | null
      expiresAt: number
      lastValidated: number
      offlineSince: number | null
      machineId: string
    }
  | {
      version: 2
      source: 'jwt'
      token: string
      tier: string
      expiresAt: number
      lastValidated: number
      offlineSince: number | null
      machineId: string
      portalUrl: string
    }

const OFFLINE_WARNING_MS = 48 * 60 * 60 * 1000
const OFFLINE_BLOCK_MS = 72 * 60 * 60 * 1000

function getLicensePath() {
  return path.join(getXyvaDir(), 'license.json')
}

function getMachineIdPath() {
  return path.join(getXyvaDir(), 'machine-id.json')
}

function readStoredLicense(): StoredLicenseFile | null {
  try {
    const filePath = getLicensePath()
    if (!fs.existsSync(filePath)) {
      return null
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredLicenseFile | string
    if (typeof parsed === 'string' && parsed.startsWith('XYVA-')) {
      return {
        version: 1,
        source: 'legacy',
        legacyKey: parsed,
        lastValidated: 0,
        offlineSince: null,
      }
    }

    if (
      parsed
      && typeof parsed === 'object'
      && (parsed.version === 1 || parsed.version === 2)
      && (parsed.source === 'legacy' || parsed.source === 'jwt')
    ) {
      return parsed
    }
  } catch {
    // Corrupt or attacker-modified files are treated as missing.
  }

  return null
}

function writeStoredLicense(state: StoredLicenseFile) {
  writePrivateFile(getLicensePath(), JSON.stringify(state, null, 2))
}

function removeStoredLicense() {
  try {
    fs.rmSync(getLicensePath(), { force: true })
  } catch {
    // The in-memory result still fails closed if cleanup is unavailable.
  }
}

function readPersistedMachineId(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getMachineIdPath(), 'utf8')) as { version?: number; machineId?: string }
    return parsed.version === 1 && typeof parsed.machineId === 'string' && /^[a-f0-9-]{32,64}$/i.test(parsed.machineId)
      ? parsed.machineId
      : null
  } catch {
    return null
  }
}

function persistMachineId(machineId: string): string {
  writePrivateFile(getMachineIdPath(), JSON.stringify({ version: 1, machineId }, null, 2))
  return machineId
}

function legacyMachineId() {
  const networkSignature = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry): entry is NonNullable<typeof entry> => !!entry && !entry.internal)
    .map((entry) => entry.mac)
    .sort()
    .join('|')

  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}::${os.userInfo().username}::${networkSignature}`)
    .digest('hex')
    .slice(0, 32)
}

function issuerFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as { iss?: unknown }
    return typeof payload.iss === 'string' ? payload.iss : null
  } catch {
    return null
  }
}

function locallyVerifiedStoredLicense(stored: Extract<StoredLicenseFile, { source: 'jwt' }>, portalUrl?: string) {
  const expectedPortalUrl = portalUrl || (stored.version === 2 ? stored.portalUrl : issuerFromToken(stored.token))
  if (!expectedPortalUrl) {
    return { ok: false as const, error: 'Legacy license requires online migration' }
  }

  return verifyLicenseToken(stored.token, {
    portalUrl: expectedPortalUrl,
    machineId: stored.machineId,
  })
}

function invalidLicenseState(token: string | null = null, lastValidated = 0): LicenseState {
  return {
    token,
    tier: null,
    expiresAt: 0,
    lastValidated,
    offlineSince: null,
  }
}

function stateFromClaims(
  token: string,
  claims: VerifiedLicenseClaims,
  lastValidated: number,
  offlineSince: number | null,
): LicenseState {
  return {
    token,
    tier: claims.tier,
    expiresAt: claims.exp * 1000,
    lastValidated,
    offlineSince,
  }
}

function createOfflineStatus(source: 'missing' | 'legacy' | 'jwt', state: LicenseState, warning?: string | null): AgentLicenseGuardStatus {
  const offlineOrigin = state.offlineSince ?? state.lastValidated
  const offlineDuration = offlineOrigin > 0 ? Date.now() - offlineOrigin : Number.POSITIVE_INFINITY

  if (!state.token && source === 'missing') {
    return {
      allowed: false,
      reason: 'No active license found.',
      tier: null,
      source: 'missing',
      expiresAt: 0,
      warning: null,
    }
  }

  if (state.expiresAt <= Date.now()) {
    return {
      allowed: false,
      reason: 'License token expired.',
      tier: state.tier,
      source,
      expiresAt: state.expiresAt,
      warning: null,
    }
  }

  if (offlineDuration >= OFFLINE_BLOCK_MS) {
    return {
      allowed: false,
      reason: 'License heartbeat overdue. Reconnect the portal within 72 hours.',
      tier: state.tier,
      source,
      expiresAt: state.expiresAt,
      warning: null,
    }
  }

  return {
    allowed: true,
    tier: state.tier,
    source,
    expiresAt: state.expiresAt,
    warning: warning || (offlineDuration >= OFFLINE_WARNING_MS
      ? 'License heartbeat is overdue. Reconnect soon to avoid blocking premium actions.'
      : null),
  }
}

export function createMachineId() {
  const persisted = readPersistedMachineId()
  if (persisted) {
    return persisted
  }

  const stored = readStoredLicense()
  if (stored?.source === 'jwt') {
    const verified = locallyVerifiedStoredLicense(stored)
    if (verified.ok) {
      return persistMachineId(verified.claims.machineId)
    }

    // Preserve the pre-v2 network-derived id so the portal can migrate an old
    // HMAC token online without consuming another machine seat.
    return persistMachineId(stored.machineId || legacyMachineId())
  }

  return persistMachineId(crypto.randomUUID())
}

export async function activateLicense(portalUrl: string, sessionToken: string): Promise<void> {
  const machineId = createMachineId()
  const normalizedPortalUrl = portalUrl.replace(/\/$/, '')
  const response = await fetch(`${normalizedPortalUrl}/api/portal/license/activate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ machineId }),
    signal: AbortSignal.timeout(8_000),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || typeof payload?.token !== 'string') {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'License activation failed.')
  }

  const verified = verifyLicenseToken(payload.token, { portalUrl: normalizedPortalUrl, machineId })
  if (!verified.ok) {
    throw new Error(`Portal returned an unverifiable license: ${verified.error}`)
  }

  const now = Date.now()
  writeStoredLicense({
    version: 2,
    source: 'jwt',
    token: payload.token,
    tier: verified.claims.tier,
    expiresAt: verified.claims.exp * 1000,
    lastValidated: now,
    offlineSince: null,
    machineId,
    portalUrl: normalizedPortalUrl,
  })
}

export async function validateLicense(credentials?: Pick<AgentCredentials, 'portalUrl' | 'token'>): Promise<LicenseState> {
  const stored = readStoredLicense()
  const now = Date.now()

  if (!stored) {
    return invalidLicenseState()
  }

  if (stored.source === 'legacy') {
    // Shared-secret legacy keys are never verified locally. Removing the file
    // forces the authenticated server activation flow to mint an Ed25519 token.
    removeStoredLicense()
    return invalidLicenseState()
  }

  const normalizedPortalUrl = credentials?.portalUrl?.replace(/\/$/, '')
    || (stored.version === 2 ? stored.portalUrl : issuerFromToken(stored.token))
    || ''
  const localVerification = normalizedPortalUrl
    ? verifyLicenseToken(stored.token, { portalUrl: normalizedPortalUrl, machineId: stored.machineId })
    : { ok: false as const, error: 'Legacy license requires online migration' }

  if (!credentials?.portalUrl || !credentials.token) {
    return localVerification.ok
      ? stateFromClaims(stored.token, localVerification.claims, stored.lastValidated, stored.offlineSince)
      : invalidLicenseState(stored.token, stored.lastValidated)
  }

  try {
    const response = await fetch(`${normalizedPortalUrl}/api/portal/license/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: stored.token }),
      signal: AbortSignal.timeout(8_000),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      if (response.status < 500 && response.status !== 429) {
        removeStoredLicense()
        return invalidLicenseState()
      }
      throw new Error(typeof payload?.error === 'string' ? payload.error : `License server returned ${response.status}`)
    }
    if (typeof payload?.token !== 'string') {
      removeStoredLicense()
      return invalidLicenseState()
    }

    const refreshed = verifyLicenseToken(payload.token, {
      portalUrl: normalizedPortalUrl,
      machineId: createMachineId(),
    })
    if (!refreshed.ok) {
      removeStoredLicense()
      return invalidLicenseState()
    }

    const nextState: Extract<StoredLicenseFile, { version: 2 }> = {
      version: 2,
      source: 'jwt',
      token: payload.token,
      tier: refreshed.claims.tier,
      expiresAt: refreshed.claims.exp * 1000,
      lastValidated: now,
      offlineSince: null,
      machineId: refreshed.claims.machineId,
      portalUrl: normalizedPortalUrl,
    }
    writeStoredLicense(nextState)
    return stateFromClaims(nextState.token, refreshed.claims, now, null)
  } catch {
    if (!localVerification.ok) {
      return invalidLicenseState(stored.token, stored.lastValidated)
    }

    const nextOfflineSince = stored.offlineSince ?? now
    const nextState: Extract<StoredLicenseFile, { version: 2 }> = {
      version: 2,
      source: 'jwt',
      token: stored.token,
      tier: localVerification.claims.tier,
      expiresAt: localVerification.claims.exp * 1000,
      lastValidated: stored.lastValidated,
      offlineSince: nextOfflineSince,
      machineId: localVerification.claims.machineId,
      portalUrl: normalizedPortalUrl,
    }
    writeStoredLicense(nextState)
    return stateFromClaims(stored.token, localVerification.claims, stored.lastValidated, nextOfflineSince)
  }
}

export function checkLicenseGuard(): AgentLicenseGuardStatus {
  const stored = readStoredLicense()
  if (!stored) {
    return createOfflineStatus('missing', invalidLicenseState())
  }

  if (stored.source === 'legacy') {
    return {
      allowed: false,
      reason: 'Legacy license requires authenticated online migration.',
      tier: null,
      source: 'legacy',
      expiresAt: 0,
      warning: null,
    }
  }

  const verified = locallyVerifiedStoredLicense(stored)
  if (!verified.ok || verified.claims.machineId !== createMachineId()) {
    return {
      allowed: false,
      reason: verified.ok ? 'License machine mismatch.' : verified.error,
      tier: null,
      source: 'jwt',
      expiresAt: 0,
      warning: null,
    }
  }

  return createOfflineStatus(
    'jwt',
    stateFromClaims(stored.token, verified.claims, stored.lastValidated, stored.offlineSince),
  )
}

export function getLicenseStatus(): AgentLicenseGuardStatus {
  return checkLicenseGuard()
}
