import crypto from 'node:crypto'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

import open from 'open'

import { isSealedSecret, sealSecret, unsealSecret, writePrivateFile } from './secure-store.js'
import { getAgentDataRoot } from './utils/platform.js'

const DEFAULT_PORTAL_URL = process.env.XYVA_PORTAL_URL || 'https://xyva.ai'
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

export interface AgentCredentials {
  token: string
  email: string
  expiresAt: number
  portalUrl: string
}

type StoredAgentCredentials = Omit<AgentCredentials, 'token'> & {
  version: 2
  token: string
}

export interface LoginFlowOptions {
  token?: string
  email?: string
  portalUrl?: string
  expiresAt?: number
  timeoutMs?: number
}

export function getXyvaDir(): string {
  return getAgentDataRoot()
}

export function getCredentialsPath(): string {
  return path.join(getXyvaDir(), 'credentials.json')
}

export function loadCredentials(): AgentCredentials | null {
  try {
    const filePath = getCredentialsPath()
    if (!fs.existsSync(filePath)) {
      return null
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredAgentCredentials>
    const token = typeof parsed.token === 'string'
      ? (isSealedSecret(parsed.token) ? unsealSecret(parsed.token, 'agent-credentials:token') : parsed.token)
      : null
    if (
      typeof token !== 'string'
      || typeof parsed.email !== 'string'
      || typeof parsed.expiresAt !== 'number'
      || typeof parsed.portalUrl !== 'string'
    ) {
      return null
    }

    if (parsed.expiresAt <= Date.now()) {
      return null
    }

    const credentials: AgentCredentials = {
      token,
      email: parsed.email,
      expiresAt: parsed.expiresAt,
      portalUrl: parsed.portalUrl,
    }

    if (!isSealedSecret(parsed.token || '') || parsed.version !== 2) {
      saveCredentials(credentials)
    } else {
      try {
        fs.chmodSync(filePath, 0o600)
      } catch {
        // Best-effort on platforms where POSIX modes are not available.
      }
    }

    return credentials
  } catch {
    return null
  }
}

export function saveCredentials(credentials: AgentCredentials): void {
  const stored: StoredAgentCredentials = {
    version: 2,
    ...credentials,
    token: sealSecret(credentials.token, 'agent-credentials:token'),
  }
  writePrivateFile(getCredentialsPath(), JSON.stringify(stored, null, 2))
}

export function clearCredentials(): void {
  const filePath = getCredentialsPath()
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath)
  }
}

export async function loginFlow(options: LoginFlowOptions = {}): Promise<AgentCredentials> {
  const portalUrl = normalizePortalUrl(options.portalUrl || DEFAULT_PORTAL_URL)
  const manualToken = String(options.token || '').trim()
  const manualEmail = String(options.email || '').trim()

  if (manualToken && manualEmail) {
    const credentials: AgentCredentials = {
      token: manualToken,
      email: manualEmail,
      expiresAt: options.expiresAt || Date.now() + DEFAULT_EXPIRY_MS,
      portalUrl,
    }

    saveCredentials(credentials)
    return credentials
  }

  return runBrowserLoginFlow({
    portalUrl,
    timeoutMs: options.timeoutMs || 120_000,
  })
}

function normalizePortalUrl(portalUrl: string): string {
  return portalUrl.replace(/\/$/, '')
}

async function runBrowserLoginFlow(options: { portalUrl: string; timeoutMs: number }): Promise<AgentCredentials> {
  const callbackState = await createCallbackServer()
  const callbackUrl = `http://127.0.0.1:${callbackState.port}/callback`
  const state = createUrlSafeToken(24)
  const codeVerifier = createUrlSafeToken(32)
  const codeChallenge = hashCodeVerifier(codeVerifier)
  const authUrl = new URL('/api/agent/auth', options.portalUrl)
  authUrl.searchParams.set('callback', callbackUrl)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('codeChallenge', codeChallenge)

  try {
    await open(authUrl.toString())
  } catch {
    console.log(`Open this URL to authenticate the agent:\n${authUrl.toString()}`)
  }

  try {
    const callbackPayload = await waitForCallback(callbackState.server, callbackState.callbackPromise, options.timeoutMs)
    if (callbackPayload.state !== state) {
      throw new Error('Portal callback state mismatch.')
    }

    const credentials = await exchangeAgentAuthCode({
      callbackUrl,
      code: callbackPayload.code,
      codeVerifier,
      portalUrl: options.portalUrl,
      state,
    })
    saveCredentials(credentials)
    return credentials
  } catch (error) {
    throw new Error(`${(error as Error).message} Use 'xyva-agent login --token <token> --email <email>' as a manual fallback.`)
  }
}

function createUrlSafeToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url')
}

function hashCodeVerifier(codeVerifier: string) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url')
}

async function exchangeAgentAuthCode(input: {
  callbackUrl: string
  code: string
  codeVerifier: string
  portalUrl: string
  state: string
}): Promise<AgentCredentials> {
  const response = await fetch(`${normalizePortalUrl(input.portalUrl)}/api/agent/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      callback: input.callbackUrl,
      code: input.code,
      codeVerifier: input.codeVerifier,
      state: input.state,
    }),
  })

  const payload = await response.json().catch(() => null) as
    | {
        email?: string
        error?: string
        expiresAt?: number
        portalUrl?: string
        token?: string
      }
    | null

  if (!response.ok) {
    throw new Error(payload?.error || `Agent token exchange failed with HTTP ${response.status}`)
  }

  if (
    !payload
    || typeof payload.token !== 'string'
    || typeof payload.email !== 'string'
    || typeof payload.expiresAt !== 'number'
  ) {
    throw new Error('Portal callback exchange returned an invalid payload.')
  }

  return {
    token: payload.token,
    email: payload.email,
    expiresAt: payload.expiresAt,
    portalUrl: normalizePortalUrl(payload.portalUrl || input.portalUrl),
  }
}

async function createCallbackServer(): Promise<{
  port: number
  server: Server
  callbackPromise: Promise<{ code: string; state: string }>
}> {
  let resolvePromise: ((payload: { code: string; state: string }) => void) | null = null
  let rejectPromise: ((error: Error) => void) | null = null

  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  const server = createServer((request, response) => {
    try {
      if (!request.url) {
        response.writeHead(400).end('Missing request URL')
        rejectPromise?.(new Error('Missing callback URL'))
        return
      }

      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        response.writeHead(400).end('Missing authentication code or state')
        rejectPromise?.(new Error('Portal callback completed without code/state.'))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<html><body><h1>xyva agent connected</h1><p>You can return to the terminal.</p></body></html>')
      resolvePromise?.({ code, state })
    } catch (error) {
      response.writeHead(500).end('Callback handling failed')
      rejectPromise?.(error as Error)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind callback server.')
  }

  return { port: address.port, server, callbackPromise }
}

async function waitForCallback(
  server: Server,
  callbackPromise: Promise<{ code: string; state: string }>,
  timeoutMs: number,
): Promise<{ code: string; state: string }> {
  let timeout: NodeJS.Timeout | null = null

  try {
    return await Promise.race([
      callbackPromise,
      new Promise<{ code: string; state: string }>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for portal callback.')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
