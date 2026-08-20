// @vitest-environment node
/**
 * Agent <-> Portal smoke E2E.
 *
 * Boots @xyva/agent (built dist) on a free port, talks to it over HTTP and
 * WebSocket and validates the bridge flow end to end. Uses a throwaway HOME
 * so it cannot disturb the developer's real ~/.xyva.
 */

import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { createServer, type Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import WebSocket from "ws"

const PORT = 7902
const BASE = `http://127.0.0.1:${PORT}`
const WS_BASE = `ws://127.0.0.1:${PORT}`
const QA_ORIGIN = "https://qa.xyva.ai"
const FLOW_ORIGIN = "https://flow.xyva.ai"
const FLOW_ENTITLEMENT_GRANT = "g".repeat(43)

const repoRoot = path.resolve(__dirname, "..", "..")
const agentDist = path.join(repoRoot, "packages", "agent", "dist", "cli.js")
const agentPackageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "packages", "agent", "package.json"), "utf-8"),
) as { version: string }

let tmpHome: string
let proc: ChildProcess | null = null
let agentStdout = ""
let qaPairingToken = ""
let flowPairingToken = ""
let sessionRefreshToken = ""
let flowSessionRefreshToken = ""
let mockPortal: Server | null = null
let mockPortalUrl = ""
let signedLicenseToken = ""
let consumedFlowBinding: string | null = null

const { privateKey: testLicensePrivateKey, publicKey: testLicensePublicKey } = crypto.generateKeyPairSync("ed25519")

function signTestLicense(machineId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "xyva-test", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    aud: "xyva-agent",
    iss: mockPortalUrl,
    sub: "flow-alpha-user",
    tier: "solo",
    machineId,
    seats: 1,
    iat: now,
    exp: now + 60 * 60,
  })).toString("base64url")
  const unsigned = `${header}.${payload}`
  return `${unsigned}.${crypto.sign(null, Buffer.from(unsigned), testLicensePrivateKey).toString("base64url")}`
}

async function startMockPortal(): Promise<void> {
  mockPortal = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      const json = () => {
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }
        catch { return null }
      }
      response.setHeader("Content-Type", "application/json")
      response.setHeader("Cache-Control", "no-store")
      if (request.method === "POST" && request.url === "/api/portal/license/validate") {
        response.writeHead(200).end(JSON.stringify({ token: signedLicenseToken, expiresAt: Date.now() + 60 * 60 * 1000 }))
        return
      }
      if (request.method === "POST" && request.url === "/v1/agent-entitlement-grants/consume") {
        const body = json()
        const expectedPairingHash = crypto.createHash("sha256").update(flowPairingToken, "ascii").digest("hex")
        const binding = typeof body?.sessionFamilyBinding === "string" ? body.sessionFamilyBinding : ""
        const valid = body?.schemaVersion === 1
          && body?.grant === FLOW_ENTITLEMENT_GRANT
          && body?.product === "flow-provider-preview.v1"
          && body?.browserOrigin === FLOW_ORIGIN
          && body?.pairingToken === flowPairingToken
          && expectedPairingHash.length === 64
          && /^[A-Za-z0-9_-]{43}$/u.test(binding)
          && (consumedFlowBinding === null || consumedFlowBinding === binding)
        if (!valid) {
          response.writeHead(401).end(JSON.stringify({ schemaVersion: 1, error: { code: "denied" } }))
          return
        }
        consumedFlowBinding ??= binding
        response.writeHead(200).end(JSON.stringify({
          schemaVersion: 1,
          consumed: true,
          leaseExpiresAt: Date.now() + 299_000,
        }))
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    mockPortal?.once("error", reject)
    mockPortal?.listen(0, "127.0.0.1", () => resolve())
  })
  const address = mockPortal.address()
  if (!address || typeof address === "string") throw new Error("mock portal did not bind")
  mockPortalUrl = `http://127.0.0.1:${address.port}`
}

async function pollHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch {
      // not yet listening
    }
    await delay(200)
  }
  throw new Error(`agent did not become healthy within ${timeoutMs}ms`)
}

async function waitForPairingToken(product: "QA Studio" | "Flow provider", timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const token = agentStdout.match(new RegExp(`${product} pairing token \\(valid for 5 minutes, single use\\): ([A-Za-z0-9_-]+)`))?.[1]
    if (token) return token
    await delay(25)
  }
  throw new Error("agent did not print a pairing token")
}

async function rotateSession(
  refreshToken: string,
  origin = QA_ORIGIN,
): Promise<{ token: string; refreshToken: string }> {
  const response = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}`, Origin: origin },
  })
  if (!response.ok) throw new Error(`session rotation failed with ${response.status}`)
  const payload = await response.json() as { token?: string; refreshToken?: string }
  if (!payload.token || !payload.refreshToken) throw new Error("session rotation returned an invalid payload")
  return { token: payload.token, refreshToken: payload.refreshToken }
}

async function requestFlowChallenge(
  pairingToken: string,
  clientNonce = "n".repeat(43),
  clientProofOverride?: string,
) {
  const pairingTokenHash = crypto.createHash("sha256").update(pairingToken, "ascii").digest("hex")
  const prechallengeTranscript = [
    "XYVA-FLOW-AGENT-PRECHALLENGE-V1",
    `origin=${FLOW_ORIGIN}`,
    "product=flow-provider-preview.v1",
    `port=${PORT}`,
    `pairingTokenHash=${pairingTokenHash}`,
    `clientNonce=${clientNonce}`,
  ].join("\n")
  const clientProof = clientProofOverride ?? crypto.createHmac("sha256", Buffer.from(pairingToken, "ascii"))
    .update(prechallengeTranscript, "utf8")
    .digest("base64url")
  const response = await fetch(`${BASE}/auth/flow/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: FLOW_ORIGIN },
    body: JSON.stringify({
      schemaVersion: 1,
      product: "flow-provider-preview.v1",
      agentPort: PORT,
      pairingTokenHash,
      clientNonce,
      clientProof,
    }),
  })
  const payload = await response.json() as Record<string, unknown>
  return { response, payload, pairingTokenHash, clientNonce }
}

function verifyChallengeProof(pairingToken: string, payload: Record<string, unknown>): boolean {
  const transcript = [
    "XYVA-FLOW-AGENT-POP-V1",
    `origin=${FLOW_ORIGIN}`,
    "product=flow-provider-preview.v1",
    `port=${PORT}`,
    `pairingTokenHash=${String(payload.pairingTokenHash)}`,
    `clientNonce=${String(payload.clientNonce)}`,
    `challengeId=${String(payload.challengeId)}`,
    `issuedAt=${String(payload.issuedAt)}`,
    `expiresAt=${String(payload.expiresAt)}`,
  ].join("\n")
  const expected = crypto.createHmac("sha256", Buffer.from(pairingToken, "ascii"))
    .update(transcript, "utf8")
    .digest("base64url")
  return typeof payload.proof === "string" && payload.proof === expected
}

beforeAll(async () => {
  if (!fs.existsSync(agentDist)) {
    throw new Error(
      `agent dist not built at ${agentDist}. Run: npm run build --workspace @xyva/agent`,
    )
  }

  await startMockPortal()
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xyva-agent-test-"))
  // Pre-seed credentials so the CLI does not try the loginFlow listener.
  fs.mkdirSync(path.join(tmpHome, ".xyva"), { recursive: true })
  const machineId = crypto.randomUUID()
  signedLicenseToken = signTestLicense(machineId)
  fs.writeFileSync(path.join(tmpHome, ".xyva", "machine-id.json"), JSON.stringify({ version: 1, machineId }))
  fs.writeFileSync(path.join(tmpHome, ".xyva", "license.json"), JSON.stringify({
    version: 2,
    source: "jwt",
    token: signedLicenseToken,
    tier: "solo",
    expiresAt: Date.now() + 60 * 60 * 1000,
    lastValidated: Date.now(),
    offlineSince: null,
    machineId,
    portalUrl: mockPortalUrl,
  }))
  const creds = {
    token: "test-fixture-token-not-real",
    email: "fixture@xyva.test",
    expiresAt: Date.now() + 60 * 60 * 1000,
    portalUrl: mockPortalUrl,
  }
  fs.writeFileSync(
    path.join(tmpHome, ".xyva", "credentials.json"),
    JSON.stringify(creds, null, 2),
  )

  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XYVA_AGENT_MODE: "advisor",
    XYVA_AGENT_SKIP_BROWSER_REPAIR: "1",
    XYVA_AGENT_WS_AUTH_TIMEOUT_MS: "250",
    NODE_ENV: "test",
    XYVA_AGENT_FLOW_ENTITLEMENT_TEST_URL: `${mockPortalUrl}/v1/agent-entitlement-grants/consume`,
    XYVA_AGENT_FLOW_ORIGINS: FLOW_ORIGIN,
    XYVA_AGENT_QA_ORIGINS: QA_ORIGIN,
    XYVA_LICENSE_TEST_PUBLIC_KEY: testLicensePublicKey.export({ type: "spki", format: "pem" }).toString(),
  }

  proc = spawn(process.execPath, [agentDist, "start", "--port", String(PORT), "--no-banner"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  proc.stdout?.on("data", (chunk) => {
    agentStdout += chunk.toString()
    if (process.env.AGENT_E2E_DEBUG) console.log("[agent stdout]", chunk.toString())
  })
  proc.stderr?.on("data", (chunk) => {
    if (process.env.AGENT_E2E_DEBUG) console.error("[agent stderr]", chunk.toString())
  })

  await pollHealth()
  qaPairingToken = await waitForPairingToken("QA Studio")
  flowPairingToken = await waitForPairingToken("Flow provider")
  const initialSession = await rotateSession(qaPairingToken)
  sessionRefreshToken = initialSession.refreshToken
}, 60_000)

afterAll(async () => {
  if (sessionRefreshToken) {
    await fetch(`${BASE}/auth/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionRefreshToken}`, Origin: QA_ORIGIN },
    }).catch(() => undefined)
  }
  if (flowSessionRefreshToken) {
    await fetch(`${BASE}/auth/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${flowSessionRefreshToken}`, Origin: FLOW_ORIGIN },
    }).catch(() => undefined)
  }
  if (proc && !proc.killed) {
    proc.kill("SIGTERM")
    await delay(300)
    if (!proc.killed) proc.kill("SIGKILL")
  }
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
  if (mockPortal?.listening) {
    await new Promise<void>((resolve) => mockPortal?.close(() => resolve()))
  }
})

describe("agent /health", () => {
  it("returns metadata with protocol version", async () => {
    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agent).toBe("@xyva/agent")
    expect(body.version).toBe(agentPackageJson.version)
    expect(typeof body.protocolVersion).toBe("number")
    expect(typeof body.node).toBe("string")
    expect(body.configPort).toBe(PORT)
    expect(body.flowPairingProtocolVersion).toBe(2)
    expect(body.connectionLimits).toMatchObject({
      authTimeoutMs: 250,
      maxConnections: expect.any(Number),
      maxPayload: expect.any(Number),
    })
  })
})

describe("agent runtime readiness", () => {
  it("rejects readiness requests without the agent credential", async () => {
    const res = await fetch(`${BASE}/runtime-readiness`)
    expect(res.status).toBe(401)
  })

  it("allows active readiness inspection with the signed test license", async () => {
    const res = await fetch(`${BASE}/runtime-readiness`, {
      headers: { Authorization: "Bearer test-fixture-token-not-real" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, readiness: expect.any(Object) })
  })
})

describe("agent project registry HTTP boundary", () => {
  it("rejects project discovery without the agent credential", async () => {
    const res = await fetch(`${BASE}/projects`)
    expect(res.status).toBe(401)
  })

  it("allows project discovery with the signed test license", async () => {
    const res = await fetch(`${BASE}/projects`, {
      headers: { Authorization: "Bearer test-fixture-token-not-real" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, projects: expect.any(Array) })
  })

  it("rejects project mutation without the agent credential", async () => {
    const res = await fetch(`${BASE}/projects/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tmpHome }),
    })
    expect(res.status).toBe(401)
  })

  it("never prints the long-lived portal credential", () => {
    expect(agentStdout).not.toContain("test-fixture-token-not-real")
    expect(agentStdout).toMatch(/QA Studio pairing token \(valid for 5 minutes, single use\): [A-Za-z0-9_-]+/)
    expect(agentStdout).toMatch(/Flow provider pairing token \(valid for 5 minutes, single use\): [A-Za-z0-9_-]+/)
  })

  it("uses separate single-use product grants and rotates origin-bound sessions", async () => {
    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${qaPairingToken}`, Origin: QA_ORIGIN },
    })).status).toBe(401)

    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${flowPairingToken}`, Origin: QA_ORIGIN },
    })).status).toBe(401)

    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${flowPairingToken}`, Origin: FLOW_ORIGIN },
    })).status).toBe(401)

    expect((await fetch(`${BASE}/auth/flow/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: QA_ORIGIN },
      body: JSON.stringify({
        schemaVersion: 1,
        pairingToken: flowPairingToken,
        entitlementGrant: FLOW_ENTITLEMENT_GRANT,
        product: "flow-provider-preview.v1",
      }),
    })).status).toBe(401)

    expect((await fetch(`${BASE}/auth/flow/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FLOW_ORIGIN },
      body: JSON.stringify({
        schemaVersion: 1,
        pairingToken: flowPairingToken,
        entitlementGrant: FLOW_ENTITLEMENT_GRANT,
        product: "flow-provider-preview.v1",
      }),
    })).status).toBe(401)

    const rejectedQaChallenge = await requestFlowChallenge(qaPairingToken, "q".repeat(43))
    expect(rejectedQaChallenge.response.status).toBe(401)
    expect(rejectedQaChallenge.response.headers.get("cache-control")).toBe("no-store")
    expect(rejectedQaChallenge.response.headers.get("pragma")).toBe("no-cache")

    const rejectedRelay = await requestFlowChallenge(flowPairingToken, "r".repeat(43), "x".repeat(43))
    expect(rejectedRelay.response.status).toBe(401)
    expect(rejectedRelay.response.headers.get("cache-control")).toBe("no-store")

    const challenge = await requestFlowChallenge(flowPairingToken)
    expect(challenge.response.status).toBe(200)
    expect(challenge.response.headers.get("cache-control")).toBe("no-store")
    expect(challenge.response.headers.get("pragma")).toBe("no-cache")
    expect(challenge.payload).toEqual({
      schemaVersion: 1,
      product: "flow-provider-preview.v1",
      agentPort: PORT,
      pairingTokenHash: challenge.pairingTokenHash,
      clientNonce: challenge.clientNonce,
      challengeId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      issuedAt: expect.any(Number),
      expiresAt: expect.any(Number),
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    })
    expect(Number(challenge.payload.expiresAt) - Number(challenge.payload.issuedAt)).toBe(30_000)
    expect(verifyChallengeProof(flowPairingToken, challenge.payload)).toBe(true)

    const flowPairBody = {
      schemaVersion: 2,
      product: "flow-provider-preview.v1",
      agentPort: PORT,
      challengeId: challenge.payload.challengeId,
      clientNonce: challenge.payload.clientNonce,
      proof: challenge.payload.proof,
      entitlementGrant: FLOW_ENTITLEMENT_GRANT,
    }
    expect(flowPairBody).not.toHaveProperty("pairingToken")
    const flowPairing = await fetch(`${BASE}/auth/flow/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FLOW_ORIGIN },
      body: JSON.stringify(flowPairBody),
    })
    expect(flowPairing.status).toBe(200)
    const flowPayload = await flowPairing.json() as { refreshToken?: string }
    expect(flowPayload.refreshToken).toEqual(expect.any(String))
    flowSessionRefreshToken = flowPayload.refreshToken || ""

    expect((await fetch(`${BASE}/auth/flow/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FLOW_ORIGIN },
      body: JSON.stringify(flowPairBody),
    })).status).toBe(401)

    const malformedJson = await fetch(`${BASE}/auth/flow/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FLOW_ORIGIN },
      body: "{",
    })
    expect(malformedJson.status).toBe(400)
    expect(malformedJson.headers.get("cache-control")).toBe("no-store")
    expect(malformedJson.headers.get("pragma")).toBe("no-cache")

    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${flowSessionRefreshToken}`, Origin: QA_ORIGIN },
    })).status).toBe(401)

    const previousRefreshToken = sessionRefreshToken
    const rotatedPayload = await rotateSession(previousRefreshToken)
    sessionRefreshToken = rotatedPayload.refreshToken
    expect(rotatedPayload.refreshToken).not.toBe(previousRefreshToken)
    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${previousRefreshToken}` },
    })).status).toBe(401)
  })

  it("allows private-network preflight only for exact QA and Flow origins", async () => {
    for (const origin of [QA_ORIGIN, FLOW_ORIGIN]) {
      const response = await fetch(`${BASE}/auth/flow/challenge`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
      expect(response.headers.get("access-control-allow-private-network")).toBe("true")
    }

    for (const origin of ["https://evil.xyva.ai", "https://evil.example", "null"]) {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { Authorization: "Bearer irrelevant", Origin: origin },
      })
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(response.headers.get("access-control-allow-private-network")).toBeNull()
    }
  })
})

describe("agent /auth/refresh", () => {
  it("rejects requests without bearer token", async () => {
    const res = await fetch(`${BASE}/auth/refresh`, { method: "POST" })
    expect(res.status).toBe(401)
  })

  it("rejects requests with wrong bearer token", async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  it("does not accept the configured long-lived credential as a browser session", async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: "Bearer test-fixture-token-not-real" },
    })
    expect(res.status).toBe(401)
  })
})

describe("agent WebSocket bridge", () => {
  async function getConnectionToken() {
    const session = await rotateSession(sessionRefreshToken)
    sessionRefreshToken = session.refreshToken
    return session.token
  }

  async function getProtocolVersion(): Promise<number> {
    const res = await fetch(`${BASE}/health`)
    const body = await res.json()
    return body.protocolVersion as number
  }

  it.each([
    ["bogus token", "bogus-token"],
    ["long-lived portal credential", "test-fixture-token-not-real"],
  ])("rejects connections with %s", async (_label, rejectedToken) => {
    const protocolVersion = await getProtocolVersion()
    const ws = new WebSocket(WS_BASE, { headers: { Origin: QA_ORIGIN } })
    const result = await new Promise<{ closed: boolean; lastMessage?: any }>((resolve) => {
      let lastMessage: any
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: rejectedToken, protocolVersion }))
      })
      ws.on("message", (data) => {
        try { lastMessage = JSON.parse(data.toString()) } catch { /* ignore */ }
      })
      ws.on("close", () => resolve({ closed: true, lastMessage }))
      setTimeout(() => { try { ws.close() } catch { /* ignore */ } }, 3000)
    })
    expect(result.closed).toBe(true)
    expect(result.lastMessage?.type).toBe("auth-result")
    expect(result.lastMessage?.ok).toBe(false)
  })

  it("rejects browser WebSockets from an origin other than the configured portal", async () => {
    const ws = new WebSocket(WS_BASE, { headers: { Origin: "https://evil.example" } })
    const status = await new Promise<number>((resolve, reject) => {
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode || 0))
      ws.once("open", () => reject(new Error("foreign WebSocket origin was accepted")))
      ws.once("error", () => undefined)
    })

    expect(status).toBe(403)
  })

  it("closes silent unauthenticated sockets and releases all connection slots", async () => {
    const sockets = Array.from({ length: 5 }, () => new WebSocket(WS_BASE))
    const closeCodes = await Promise.all(sockets.map((ws) => new Promise<number>((resolve, reject) => {
      ws.once("close", (code) => resolve(code))
      ws.once("error", reject)
    })))
    expect(closeCodes).toEqual([1008, 1008, 1008, 1008, 1008])

    const protocolVersion = await getProtocolVersion()
    const token = await getConnectionToken()
    const replacement = new WebSocket(WS_BASE, { headers: { Origin: QA_ORIGIN } })
    const authenticated = await new Promise<boolean>((resolve, reject) => {
      replacement.once("open", () => {
        replacement.send(JSON.stringify({ type: "auth", token, protocolVersion }))
      })
      replacement.once("message", (data) => {
        const message = JSON.parse(data.toString())
        replacement.close()
        resolve(message.type === "auth-result" && message.ok === true)
      })
      replacement.once("error", reject)
    })
    expect(authenticated).toBe(true)
  })

  it("accepts a valid connection token and answers a bridge call", async () => {
    const protocolVersion = await getProtocolVersion()
    const token = await getConnectionToken()
    const ws = new WebSocket(WS_BASE, { headers: { Origin: QA_ORIGIN } })

    const result = await new Promise<{ authed: boolean; response?: any }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws bridge timed out")), 8000)
      let authed = false

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token, protocolVersion }))
      })

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString())

        if (msg.type === "auth-result" && msg.ok) {
          authed = true
          // Send bridge call: licenseStatus is a registered handler with no side effects
          ws.send(JSON.stringify({
            type: "call",
            id: "smoke-1",
            method: "licenseStatus",
            args: [],
            protocolVersion,
          }))
          return
        }

        if (msg.type === "result" && msg.id === "smoke-1") {
          clearTimeout(timer)
          ws.close()
          resolve({ authed, response: msg })
        }
      })

      ws.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    expect(result.authed).toBe(true)
    expect(result.response).toBeDefined()
    expect(result.response.id).toBe("smoke-1")
    expect(result.response.type).toBe("result")
    // licenseStatus returns ok:true with structured data
    expect(result.response.ok).toBe(true)
    expect(result.response.data).toBeDefined()
  }, 15_000)

  it("accepts Flow with only Provider Bridge V1 while preventing cross-product token reuse", async () => {
    const protocolVersion = await getProtocolVersion()
    const qaToken = await getConnectionToken()
    const crossOrigin = new WebSocket(WS_BASE, { headers: { Origin: FLOW_ORIGIN } })
    const rejected = await new Promise<boolean>((resolve, reject) => {
      let sawRejection = false
      crossOrigin.once("open", () => {
        crossOrigin.send(JSON.stringify({ type: "auth", token: qaToken, protocolVersion }))
      })
      crossOrigin.on("message", (data) => {
        const message = JSON.parse(data.toString())
        sawRejection ||= message.type === "auth-result" && message.ok === false
      })
      crossOrigin.once("close", () => resolve(sawRejection))
      crossOrigin.once("error", reject)
    })
    expect(rejected).toBe(true)

    const flowSession = await rotateSession(flowSessionRefreshToken, FLOW_ORIGIN)
    flowSessionRefreshToken = flowSession.refreshToken
    const flowSocket = new WebSocket(WS_BASE, { headers: { Origin: FLOW_ORIGIN } })
    const result = await new Promise<{ accepted: boolean; denied?: any; unknown?: any; provider?: any }>((resolve, reject) => {
      let accepted = false
      let denied: any
      let unknown: any
      let provider: any
      flowSocket.once("open", () => {
        flowSocket.send(JSON.stringify({ type: "auth", token: flowSession.token, protocolVersion }))
      })
      flowSocket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "auth-result" && message.ok === true) {
          accepted = true
          flowSocket.send(JSON.stringify({ type: "call", id: "flow-denied", method: "listProjects", args: [], protocolVersion }))
          flowSocket.send(JSON.stringify({ type: "call", id: "flow-unknown", method: "notARealMethod", args: [], protocolVersion }))
          flowSocket.send(JSON.stringify({
            type: "call",
            id: "flow-provider",
            method: "providerListModelsV1",
            args: [{ schemaVersion: 1, requestId: "flow-models", providerId: "ollama" }],
            protocolVersion,
          }))
          return
        }
        if (message.id === "flow-denied") denied = message
        if (message.id === "flow-unknown") unknown = message
        if (message.id === "flow-provider") provider = message
        if (denied && unknown && provider) {
          flowSocket.close()
          resolve({ accepted, denied, unknown, provider })
        }
      })
      flowSocket.once("error", reject)
    })
    expect(result.accepted).toBe(true)
    expect(result.denied).toMatchObject({ ok: false, error: "Bridge method unavailable" })
    expect(result.unknown).toMatchObject({ ok: false, error: "Bridge method unavailable" })
    expect(result.provider).toMatchObject({ ok: true, data: expect.any(Object) })
  })

  it("serves runtime readiness over the bridge with the signed test license", async () => {
    const protocolVersion = await getProtocolVersion()
    const token = await getConnectionToken()
    const ws = new WebSocket(WS_BASE, { headers: { Origin: QA_ORIGIN } })

    const result = await new Promise<{ authed: boolean; response?: any }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws readiness timed out")), 8000)
      let authed = false

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token, protocolVersion }))
      })

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString())

        if (msg.type === "auth-result" && msg.ok) {
          authed = true
          ws.send(JSON.stringify({
            type: "call",
            id: "readiness-1",
            method: "agentReadiness",
            args: [],
            protocolVersion,
          }))
          return
        }

        if (msg.type === "result" && msg.id === "readiness-1") {
          clearTimeout(timer)
          ws.close()
          resolve({ authed, response: msg })
        }
      })

      ws.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    expect(result.authed).toBe(true)
    expect(result.response?.ok).toBe(true)
    expect(result.response?.data).toEqual(expect.any(Object))
  }, 15_000)

  it("revokes every descendant token and active socket in one session family", async () => {
    const protocolVersion = await getProtocolVersion()
    const session = await rotateSession(sessionRefreshToken)
    sessionRefreshToken = session.refreshToken
    const ws = new WebSocket(WS_BASE, { headers: { Origin: QA_ORIGIN } })
    const authenticated = new Promise<void>((resolve, reject) => {
      ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token: session.token, protocolVersion })))
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "auth-result" && message.ok === true) resolve()
      })
      ws.once("error", reject)
    })
    await authenticated

    const closed = new Promise<number>((resolve) => ws.once("close", resolve))
    const revoke = await fetch(`${BASE}/auth/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionRefreshToken}`, Origin: QA_ORIGIN },
    })
    expect(revoke.status).toBe(200)
    expect(await closed).toBe(1008)
    expect((await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionRefreshToken}`, Origin: QA_ORIGIN },
    })).status).toBe(401)
    sessionRefreshToken = ""
  })
})
