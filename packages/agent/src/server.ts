import crypto from 'node:crypto'
import { createServer } from 'node:http'

import cors from 'cors'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'

import { BRIDGE_PROTOCOL_VERSION } from '@xyva/bridge-types'

import type { AgentCredentials } from './auth.js'

import { registerAllHandlers } from './bridge/register-handlers.js'
import { activateLicense, getLicenseStatus, validateLicense } from './license.js'
import {
  consumeFlowEntitlement,
  FLOW_PROVIDER_PREVIEW_PRODUCT,
  flowPairingTokenHash,
} from './flow-entitlement.js'
import {
  createFlowPairingProof,
  verifyFlowPairingPrechallengeProof,
  FLOW_PAIRING_PROOF_TTL_MS,
  type FlowPairingProofClaims,
  verifyFlowPairingProof,
} from './flow-pairing-proof.js'
import { shouldAllowPortalPrivateNetworkAccess } from './private-network-access.js'
import { AgentProjectRegistryService } from './services/project-registry-service.js'
import {
  clearBridgeConnectionContext,
  handleWsMessage,
  setBridgeConnectionContext,
} from './bridge/ws-handler.js'
import { SecurityGuard } from './utils/SecurityGuard.js'
import { getAgentReadiness } from './readiness.js'
import {
  isAllowedProductOrigin,
  resolveAgentProductCapability,
  resolveAgentProductOrigins,
  type AgentProductCapability,
} from './product-origins.js'
import { AGENT_VERSION } from './version.js'
import { isAllowedAgentPort, resolveAllowedAgentPorts } from './agent-port-policy.js'

export interface ServerOptions {
  port: number
  projectPath?: string
  credentials: AgentCredentials
}

type ConnectionTokenRecord = {
  capability: AgentProductCapability
  expiresAt: number
  familyExpiresAt: number
  origin: string | null
  originBound: boolean
  purpose: 'pairing' | 'session' | 'socket'
  sessionFamilyId: string
}

type FlowPairingChallengeRecord = FlowPairingProofClaims & {
  readonly pairingToken: string
  readonly proof: string
}

const DEFAULT_MAX_WS_CONNECTIONS = 5
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 256 * 1024
const DEFAULT_WS_AUTH_TIMEOUT_MS = 5_000
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000
const SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000
const SOCKET_TOKEN_TTL_MS = 2 * 60 * 1000
const FLOW_SESSION_FAMILY_MAX_TTL_MS = 5 * 60 * 1000
const FLOW_PAIRING_PROOF_REQUEST_MARGIN_MS = 1_000
const MAXIMUM_FLOW_PAIRING_CHALLENGES = 16
const MAXIMUM_FLOW_PAIRING_CHALLENGES_PER_TOKEN = 8

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function safeTokenEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function exactRequestBody(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null
}

export async function startServer(options: ServerOptions): Promise<void> {
  const allowedAgentPorts = resolveAllowedAgentPorts()
  if (!isAllowedAgentPort(options.port, allowedAgentPorts)) throw new Error('Invalid Agent port')
  const app = express()
  const allowedOrigins = resolveAgentProductOrigins(options.credentials.portalUrl)
  const projectRegistryService = new AgentProjectRegistryService()
  const maxConnections = parsePositiveInteger(process.env.XYVA_AGENT_MAX_WS_CONNECTIONS, DEFAULT_MAX_WS_CONNECTIONS)
  const maxPayload = parsePositiveInteger(process.env.XYVA_AGENT_MAX_WS_PAYLOAD_BYTES, DEFAULT_MAX_WS_PAYLOAD_BYTES)
  const authTimeoutMs = parsePositiveInteger(process.env.XYVA_AGENT_WS_AUTH_TIMEOUT_MS, DEFAULT_WS_AUTH_TIMEOUT_MS)
  const connectionTokens = new Map<string, ConnectionTokenRecord>()
  const flowPairingChallenges = new Map<string, FlowPairingChallengeRecord>()
  const activeSocketsByFamily = new Map<string, Set<WebSocket>>()

  const cleanupConnectionTokens = () => {
    const now = Date.now()

    for (const [token, record] of connectionTokens.entries()) {
      if (record.expiresAt <= now) {
        connectionTokens.delete(token)
      }
    }
    for (const [challengeId, challenge] of flowPairingChallenges.entries()) {
      const parent = connectionTokens.get(challenge.pairingToken)
      if (challenge.expiresAt <= now || !parent || parent.purpose !== 'pairing'
        || parent.capability !== 'provider-bridge.v1') {
        flowPairingChallenges.delete(challengeId)
      }
    }
  }

  const issueConnectionToken = (
    purpose: ConnectionTokenRecord['purpose'] = 'socket',
    origin: string | null = null,
    originBound = true,
    capability: AgentProductCapability = 'qa-studio.full-bridge',
    sessionFamilyId = crypto.randomBytes(24).toString('base64url'),
    familyExpiresAt = Date.now() + SESSION_TOKEN_TTL_MS,
  ) => {
    cleanupConnectionTokens()
    const token = crypto.randomBytes(32).toString('base64url')
    const ttl = purpose === 'pairing'
      ? PAIRING_TOKEN_TTL_MS
      : purpose === 'session'
        ? SESSION_TOKEN_TTL_MS
        : SOCKET_TOKEN_TTL_MS
    const now = Date.now()
    const expiresAt = Math.min(now + ttl, familyExpiresAt)
    if (!Number.isSafeInteger(familyExpiresAt) || expiresAt <= now) {
      throw new Error('Session family is expired')
    }
    connectionTokens.set(token, {
      capability,
      expiresAt,
      familyExpiresAt,
      origin,
      originBound,
      purpose,
      sessionFamilyId,
    })

    return {
      token,
      expiresAt,
    }
  }

  const consumeSocketToken = (token: string, origin: string | null): ConnectionTokenRecord | null => {
    cleanupConnectionTokens()

    const issued = connectionTokens.get(token)
    if (!issued || issued.purpose !== 'socket' || !issued.originBound || issued.origin !== origin
      || issued.familyExpiresAt <= Date.now()) {
      return null
    }

    if (issued.expiresAt <= Date.now()) {
      connectionTokens.delete(token)
      return null
    }

    connectionTokens.delete(token)
    return issued
  }

  const consumeRefreshToken = (
    token: string,
    origin: string | null,
    capability: AgentProductCapability,
  ): ConnectionTokenRecord | null => {
    cleanupConnectionTokens()
    const issued = connectionTokens.get(token)
    if (!issued
      || (issued.purpose !== 'pairing' && issued.purpose !== 'session')
      || issued.capability !== capability
      || issued.familyExpiresAt <= Date.now()) {
      return null
    }

    if (issued.purpose === 'pairing') {
      if (issued.capability === 'provider-bridge.v1') return null
      if (issued.originBound && issued.origin !== origin) return null
      connectionTokens.delete(token)
      return issued
    }

    if (!issued.originBound || issued.origin !== origin) return null
    connectionTokens.delete(token)
    return issued
  }

  const revokeSessionFamily = (sessionFamilyId: string) => {
    for (const [token, record] of connectionTokens.entries()) {
      if (record.sessionFamilyId === sessionFamilyId) connectionTokens.delete(token)
    }
    for (const ws of activeSocketsByFamily.get(sessionFamilyId) || []) {
      clearBridgeConnectionContext(ws)
      ws.close(1008, 'Session revoked')
    }
    activeSocketsByFamily.delete(sessionFamilyId)
  }

  const startupQaPairingToken = issueConnectionToken(
    'pairing',
    null,
    false,
    'qa-studio.full-bridge',
  )
  const startupFlowPairingToken = issueConnectionToken(
    'pairing',
    null,
    false,
    'provider-bridge.v1',
  )

  const hasAgentCredential = (authorization: string | undefined) => {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
    return Boolean(token) && safeTokenEquals(token, options.credentials.token)
  }

  if (options.projectPath) {
    // Step 5b has no workspace resolver yet, so the project path is the best available write boundary.
    SecurityGuard.setWorkspaceRoot(options.projectPath)
  }
  SecurityGuard.setAgentMode(process.env.XYVA_AGENT_MODE || 'builder')

  registerAllHandlers({ projectPath: options.projectPath, credentials: options.credentials })

  app.use((request, response, next) => {
    if (request.path === '/auth/flow/challenge' || request.path === '/auth/flow/pair') {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Pragma', 'no-cache')
    }
    next()
  })

  app.use((request, response, next) => {
    if (shouldAllowPortalPrivateNetworkAccess(request.headers.origin, allowedOrigins)) {
      response.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    next()
  })

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedProductOrigin(origin, allowedOrigins)) {
        callback(null, true)
        return
      }

      callback(new Error('Origin not allowed'))
    },
  }))
  app.use(express.json({ limit: `${maxPayload}b` }))

  app.post('/auth/flow/challenge', (request, response) => {
    const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null
    const requestedCapability = resolveAgentProductCapability(requestOrigin, options.credentials.portalUrl)
    const body = exactRequestBody(request.body, [
      'schemaVersion', 'product', 'agentPort', 'pairingTokenHash', 'clientNonce', 'clientProof',
    ])
    if (requestedCapability !== 'provider-bridge.v1' || requestOrigin === null || body === null
      || body.schemaVersion !== 1 || body.product !== FLOW_PROVIDER_PREVIEW_PRODUCT
      || body.agentPort !== options.port || typeof body.pairingTokenHash !== 'string'
      || typeof body.clientNonce !== 'string' || typeof body.clientProof !== 'string') {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    cleanupConnectionTokens()
    let pairingToken: string | undefined
    let pairingRecord: ConnectionTokenRecord | undefined
    for (const [token, record] of connectionTokens.entries()) {
      const hash = record.purpose === 'pairing' && record.capability === 'provider-bridge.v1'
        ? flowPairingTokenHash(token)
        : null
      if (hash !== null && safeTokenEquals(hash, body.pairingTokenHash)) {
        pairingToken = token
        pairingRecord = record
        break
      }
    }
    const now = Date.now()
    if (!pairingToken || !pairingRecord || !getLicenseStatus().allowed
      || pairingRecord.expiresAt < now + FLOW_PAIRING_PROOF_TTL_MS + FLOW_PAIRING_PROOF_REQUEST_MARGIN_MS
      || !verifyFlowPairingPrechallengeProof(pairingToken, {
        origin: requestOrigin,
        product: FLOW_PROVIDER_PREVIEW_PRODUCT,
        port: options.port,
        pairingTokenHash: body.pairingTokenHash,
        clientNonce: body.clientNonce,
      }, body.clientProof)) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    const existing = [...flowPairingChallenges.values()].find((challenge) => (
      challenge.pairingToken === pairingToken
      && challenge.origin === requestOrigin
      && challenge.product === FLOW_PROVIDER_PREVIEW_PRODUCT
      && challenge.port === options.port
      && challenge.clientNonce === body.clientNonce
      && challenge.pairingTokenHash === body.pairingTokenHash
      && challenge.expiresAt > now
    ))
    let challenge = existing
    if (!challenge) {
      const perToken = [...flowPairingChallenges.values()].filter(
        (candidate) => candidate.pairingToken === pairingToken,
      ).length
      if (flowPairingChallenges.size >= MAXIMUM_FLOW_PAIRING_CHALLENGES
        || perToken >= MAXIMUM_FLOW_PAIRING_CHALLENGES_PER_TOKEN) {
        response.status(429).json({ ok: false, error: 'Unavailable' })
        return
      }
      const claims: FlowPairingProofClaims = {
        origin: requestOrigin,
        product: FLOW_PROVIDER_PREVIEW_PRODUCT,
        port: options.port,
        pairingTokenHash: body.pairingTokenHash,
        clientNonce: body.clientNonce,
        challengeId: crypto.randomBytes(32).toString('base64url'),
        issuedAt: now,
        expiresAt: now + FLOW_PAIRING_PROOF_TTL_MS,
      }
      const proof = createFlowPairingProof(pairingToken, claims)
      if (proof === null) {
        response.status(401).json({ ok: false, error: 'Unauthorized' })
        return
      }
      challenge = { ...claims, pairingToken, proof }
      flowPairingChallenges.set(challenge.challengeId, challenge)
    }

    response.json({
      schemaVersion: 1,
      product: challenge.product,
      agentPort: challenge.port,
      pairingTokenHash: challenge.pairingTokenHash,
      clientNonce: challenge.clientNonce,
      challengeId: challenge.challengeId,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      proof: challenge.proof,
    })
  })

  app.post('/auth/flow/pair', async (request, response) => {
    const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null
    const requestedCapability = resolveAgentProductCapability(requestOrigin, options.credentials.portalUrl)
    const body = exactRequestBody(request.body, [
      'schemaVersion', 'product', 'agentPort', 'challengeId', 'clientNonce', 'proof', 'entitlementGrant',
    ])
    if (requestedCapability !== 'provider-bridge.v1' || requestOrigin === null || body === null
      || body.schemaVersion !== 2 || body.product !== FLOW_PROVIDER_PREVIEW_PRODUCT
      || body.agentPort !== options.port || typeof body.challengeId !== 'string'
      || typeof body.clientNonce !== 'string' || typeof body.proof !== 'string'
      || typeof body.entitlementGrant !== 'string') {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    cleanupConnectionTokens()
    const challenge = flowPairingChallenges.get(body.challengeId)
    if (challenge) flowPairingChallenges.delete(body.challengeId)
    const pairing = challenge ? connectionTokens.get(challenge.pairingToken) : undefined
    if (!pairing || pairing.purpose !== 'pairing' || pairing.capability !== 'provider-bridge.v1'
      || pairing.expiresAt <= Date.now() || pairing.familyExpiresAt <= Date.now()
      || (pairing.originBound && pairing.origin !== requestOrigin) || !challenge
      || challenge.origin !== requestOrigin || challenge.port !== options.port
      || challenge.product !== FLOW_PROVIDER_PREVIEW_PRODUCT
      || !safeTokenEquals(challenge.challengeId, body.challengeId)
      || !safeTokenEquals(challenge.clientNonce, body.clientNonce)
      || !safeTokenEquals(challenge.proof, body.proof)
      || !verifyFlowPairingProof(challenge.pairingToken, challenge, body.proof, Date.now())) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    const license = getLicenseStatus()
    if (!license.allowed) {
      response.status(403).json({ ok: false, error: 'License required' })
      return
    }

    // Consume the local single-use pairing token before network I/O. A lost or
    // ambiguous backchannel response therefore never permits a second family.
    connectionTokens.delete(challenge.pairingToken)
    const sessionFamilyId = crypto.randomBytes(32).toString('base64url')
    const entitlement = await consumeFlowEntitlement({
      browserOrigin: requestOrigin,
      entitlementGrant: body.entitlementGrant,
      pairingToken: challenge.pairingToken,
      sessionFamilyBinding: sessionFamilyId,
    })
    const now = Date.now()
    if (entitlement === null || entitlement.leaseExpiresAt <= now
      || entitlement.leaseExpiresAt > now + FLOW_SESSION_FAMILY_MAX_TTL_MS) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    try {
      const connectionToken = issueConnectionToken(
        'socket', requestOrigin, true, 'provider-bridge.v1', sessionFamilyId, entitlement.leaseExpiresAt,
      )
      const sessionToken = issueConnectionToken(
        'session', requestOrigin, true, 'provider-bridge.v1', sessionFamilyId, entitlement.leaseExpiresAt,
      )
      response.json({
        ok: true,
        token: connectionToken.token,
        expiresAt: connectionToken.expiresAt,
        refreshToken: sessionToken.token,
        refreshExpiresAt: sessionToken.expiresAt,
      })
    } catch {
      revokeSessionFamily(sessionFamilyId)
      response.status(401).json({ ok: false, error: 'Unauthorized' })
    }
  })

  app.post('/auth/refresh', (request, response) => {
    const bearerHeader = request.headers.authorization
    const token = bearerHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''

    const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null
    const requestedCapability = resolveAgentProductCapability(requestOrigin, options.credentials.portalUrl)

    const consumed = token && requestedCapability
      ? consumeRefreshToken(token, requestOrigin, requestedCapability)
      : null
    if (!consumed) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    try {
      const connectionToken = issueConnectionToken(
        'socket',
        requestOrigin,
        true,
        consumed.capability,
        consumed.sessionFamilyId,
        consumed.familyExpiresAt,
      )
      const sessionToken = issueConnectionToken(
        'session',
        requestOrigin,
        true,
        consumed.capability,
        consumed.sessionFamilyId,
        consumed.familyExpiresAt,
      )
      response.setHeader('Cache-Control', 'no-store')
      response.json({
        ok: true,
        token: connectionToken.token,
        expiresAt: connectionToken.expiresAt,
        refreshToken: sessionToken.token,
        refreshExpiresAt: sessionToken.expiresAt,
      })
    } catch {
      revokeSessionFamily(consumed.sessionFamilyId)
      response.status(401).json({ ok: false, error: 'Unauthorized' })
    }
  })

  app.post('/auth/revoke', (request, response) => {
    cleanupConnectionTokens()
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
    const issued = token ? connectionTokens.get(token) : null
    const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null
    if (!issued || issued.purpose !== 'session' || !issued.originBound || issued.origin !== requestOrigin) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    revokeSessionFamily(issued.sessionFamilyId)
    response.setHeader('Cache-Control', 'no-store')
    response.json({ ok: true })
  })

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      agent: '@xyva/agent',
      version: AGENT_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      flowPairingProtocolVersion: 2,
      platform: process.platform,
      node: process.version,
      configPort: options.port,
      connectionLimits: {
        authTimeoutMs,
        maxConnections,
        maxPayload,
      },
      license: getLicenseStatus(),
    })
  })

  app.get('/runtime-readiness', (request, response) => {
    const bearerHeader = request.headers.authorization
    const token = bearerHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
    if (!token || !safeTokenEquals(token, options.credentials.token)) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }

    const license = getLicenseStatus()
    if (!license.allowed) {
      response.status(403).json({ ok: false, error: `License required: ${license.reason || 'paid agent capability blocked'}` })
      return
    }

    response.setHeader('Cache-Control', 'no-store')
    response.json({
      ok: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      readiness: getAgentReadiness({ projectPath: options.projectPath || null }),
    })
  })

  app.get('/projects', async (request, response) => {
    if (!hasAgentCredential(request.headers.authorization)) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }
    const license = getLicenseStatus()
    if (!license.allowed) {
      response.status(403).json({ ok: false, error: `License required: ${license.reason || 'paid agent capability blocked'}` })
      return
    }

    try {
      const projects = await projectRegistryService.listProjects()
      response.json({ ok: true, projects })
    } catch (error) {
      response.status(500).json({ ok: false, error: (error as Error).message })
    }
  })

  app.post('/projects/add', async (request, response) => {
    if (!hasAgentCredential(request.headers.authorization)) {
      response.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }
    const license = getLicenseStatus()
    if (!license.allowed) {
      response.status(403).json({ ok: false, error: `License required: ${license.reason || 'paid agent capability blocked'}` })
      return
    }

    try {
      const projectPath = String(request.body?.path || '')
      const project = await projectRegistryService.addProject(projectPath)
      response.json({ ok: true, project })
    } catch (error) {
      response.status(400).json({ ok: false, error: (error as Error).message })
    }
  })

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof Error && error.message === 'Origin not allowed') {
      response.status(403).json({ ok: false, error: 'Origin not allowed' })
      return
    }
    next(error)
  })

  const server = createServer(app)
  const wss = new WebSocketServer({
    server,
    maxPayload,
    verifyClient: ({ origin }, callback) => {
      if (!origin || isAllowedProductOrigin(origin, allowedOrigins)) {
        callback(true)
        return
      }

      callback(false, 403, 'Origin not allowed')
    },
  })

  try {
    const initialState = await validateLicense(options.credentials)
    if (!initialState.token) {
      await activateLicense(options.credentials.portalUrl, options.credentials.token).catch(() => undefined)
    }
  } catch (error) {
    console.warn(`[LICENSE] Initial validation failed: ${(error as Error).message}`)
  }

  const licenseTimer = setInterval(() => {
    void validateLicense(options.credentials).catch((error) => {
      console.warn(`[LICENSE] Background validation failed: ${(error as Error).message}`)
    })
  }, 60 * 60 * 1000)

  wss.on('connection', (ws, request) => {
    if (wss.clients.size > maxConnections) {
      ws.send(JSON.stringify({
        type: 'auth-result',
        ok: false,
        error: 'Too many concurrent connections',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      }))
      ws.close(1013, 'Too many connections')
      return
    }

    let authenticated = false
    let authenticatedFamilyId: string | null = null
    let familyLeaseTimer: NodeJS.Timeout | null = null
    const connectionOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null
    const authTimer = setTimeout(() => {
      if (authenticated) return
      ws.close(1008, 'Authentication timeout')
    }, authTimeoutMs)
    authTimer.unref()
    const clearAuthTimer = () => clearTimeout(authTimer)
    ws.once('close', () => {
      clearAuthTimer()
      if (familyLeaseTimer !== null) clearTimeout(familyLeaseTimer)
      clearBridgeConnectionContext(ws)
      if (authenticatedFamilyId) {
        const sockets = activeSocketsByFamily.get(authenticatedFamilyId)
        sockets?.delete(ws)
        if (sockets?.size === 0) activeSocketsByFamily.delete(authenticatedFamilyId)
      }
    })
    ws.once('error', clearAuthTimer)

    ws.on('message', async (raw) => {
      try {
        if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
          throw new Error('Invalid WebSocket payload')
        }

        const message = JSON.parse(raw.toString()) as { type?: string; token?: string; protocolVersion?: number }

        if (!authenticated) {
          const versionMismatch = message.protocolVersion !== BRIDGE_PROTOCOL_VERSION
          const acceptedToken = !versionMismatch
            && message.type === 'auth'
            && typeof message.token === 'string'
            ? consumeSocketToken(message.token, connectionOrigin)
            : null

          if (versionMismatch || !acceptedToken) {
            ws.send(JSON.stringify({
              type: 'auth-result',
              ok: false,
              error: versionMismatch ? 'Protocol version mismatch' : 'Auth required',
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
            }))
            ws.close()
            return
          }

          authenticated = true
          authenticatedFamilyId = acceptedToken.sessionFamilyId
          setBridgeConnectionContext(ws, {
            capability: acceptedToken.capability,
            sessionFamilyId: acceptedToken.sessionFamilyId,
          })
          const familySockets = activeSocketsByFamily.get(acceptedToken.sessionFamilyId) || new Set<WebSocket>()
          familySockets.add(ws)
          activeSocketsByFamily.set(acceptedToken.sessionFamilyId, familySockets)
          familyLeaseTimer = setTimeout(() => {
            revokeSessionFamily(acceptedToken.sessionFamilyId)
          }, Math.max(1, acceptedToken.familyExpiresAt - Date.now()))
          familyLeaseTimer.unref()
          clearAuthTimer()
          ws.send(JSON.stringify({
            type: 'auth-result',
            ok: true,
            agent: {
              version: AGENT_VERSION,
              platform: process.platform,
              node: process.version,
            },
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
          }))
          return
        }

        await handleWsMessage(ws, message)
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'result',
          id: 'invalid',
          ok: false,
          error: (error as Error).message || 'Invalid request payload',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
        }))
      }
    })

    ws.on('error', (error) => {
      console.warn(`[WS] Connection error: ${(error as Error).message}`)
    })
  })

  const shutdown = () => {
    console.log('\nShutting down...')
    clearInterval(licenseTimer)
    wss.close()
    server.close(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await new Promise<void>((resolve) => {
    server.listen(options.port, '127.0.0.1', () => {
      const maskedToken = options.credentials.token.slice(0, 8) + '...' + options.credentials.token.slice(-4)
      console.log(`Agent server listening on http://127.0.0.1:${options.port}`)
      console.log(`Health: http://127.0.0.1:${options.port}/health`)
      console.log(`WebSocket: ws://127.0.0.1:${options.port}`)
      console.log('')
      console.log(`Token (masked): ${maskedToken}`)
      console.log(`QA Studio pairing token (valid for 5 minutes, single use): ${startupQaPairingToken.token}`)
      console.log(`Flow provider pairing token (valid for 5 minutes, single use): ${startupFlowPairingToken.token}`)
      console.log('Open the matching product, enter its pairing token, and connect.')
      console.log('Waiting for portal connection...')
      resolve()
    })
  })
}
