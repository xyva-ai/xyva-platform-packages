// @vitest-environment node

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { validateProviderCliCapabilitiesOutcomeV1 } from '../../packages/contracts/src/providers/cli-v1.js'

vi.mock('../../packages/agent/src/license.js', () => ({
  checkLicenseGuard: () => ({ allowed: true, tier: 'test' }),
  getLicenseStatus: () => ({ allowed: true, tier: 'test' }),
}))

import { registerAllHandlers } from '../../packages/agent/src/bridge/register-handlers.js'
import { handleWsMessage, resetHandlers, setBridgeConnectionContext } from '../../packages/agent/src/bridge/ws-handler.js'
import { setQaCliProviderGrant } from '../../packages/agent/src/config.js'
import { SecurityGuard } from '../../packages/agent/src/utils/SecurityGuard.js'
import type { CliProviderAdapter } from '../../packages/agent/src/providers/cli-types.js'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readonly sent: string[] = []
  readyState = this.OPEN
  send(value: string): void { this.sent.push(value) }
}

const previousStateDirectory = process.env.XYVA_AGENT_STATE_DIR
const previousFeature = process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE
const stateDirectories: string[] = []

afterEach(() => {
  resetHandlers()
  vi.restoreAllMocks()
  if (previousStateDirectory === undefined) delete process.env.XYVA_AGENT_STATE_DIR
  else process.env.XYVA_AGENT_STATE_DIR = previousStateDirectory
  if (previousFeature === undefined) delete process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE
  else process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE = previousFeature
  for (const directory of stateDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function response(socket: FakeWebSocket, id: string): Record<string, unknown> | undefined {
  return socket.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.id === id)
}

function authorizeQa(socket: FakeWebSocket): void {
  setBridgeConnectionContext(socket as unknown as WebSocket, { capability: 'qa-studio.full-bridge', sessionFamilyId: 'qa-family' })
}

function authorizeFlow(socket: FakeWebSocket): void {
  setBridgeConnectionContext(socket as unknown as WebSocket, { capability: 'provider-bridge.v1', sessionFamilyId: 'flow-family' })
}

function grantCli(provider = 'codex'): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-cli-bridge-'))
  stateDirectories.push(parent)
  process.env.XYVA_AGENT_STATE_DIR = path.join(parent, 'state')
  setQaCliProviderGrant(provider, true)
  process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE = '1'
}

function discovery(providerId: 'codex' | 'claude' | 'gemini' = 'codex') {
  return {
    providerId, displayName: providerId, command: providerId, installed: true, executable: true,
    installationKind: 'system' as const, authentication: 'authenticated' as const, readiness: 'ready' as const,
    version: { installedVersion: '0.1.0', latestSupportedVersion: null, supported: true, minimumVersion: '0.1.0', updateStatus: 'current' as const, updateCommand: null, integrityStatus: 'not_checked' as const, rollbackAvailable: false },
    loginCommand: null, installCommand: 'not-used', detail: 'synthetic',
  }
}

function fakeRegistry(adapter: Partial<CliProviderAdapter>) {
  const fullAdapter = {
    providerId: 'codex' as const,
    discover: async () => discovery(), getReadiness: async () => discovery(), beginLogin: async () => ({ started: false, detail: 'disabled' }),
    listModels: async () => [], getVersionStatus: async () => discovery().version,
    cancel: () => false, infer: async () => ({ outputText: 'synthetic', inputTokens: 1, outputTokens: 1 }),
    ...adapter,
  } as CliProviderAdapter
  return { get: (providerId: string) => providerId === 'codex' ? fullAdapter : undefined, status: async () => [discovery()] }
}

async function call(socket: FakeWebSocket, id: string, method: string, args: unknown[]): Promise<void> {
  await handleWsMessage(socket as unknown as WebSocket, { type: 'call', id, method, protocolVersion: 1, args })
}

describe('provider CLI bridge v1', () => {
  it('is unavailable without a product context and unavailable to Flow', async () => {
    registerAllHandlers({ cliRegistry: fakeRegistry({}) })
    const unpaired = new FakeWebSocket()
    await call(unpaired, 'unpaired', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-1' }])
    expect(response(unpaired, 'unpaired')).toMatchObject({ ok: false, error: 'Bridge method unavailable' })

    const flow = new FakeWebSocket()
    authorizeFlow(flow)
    await call(flow, 'flow', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-2' }])
    expect(response(flow, 'flow')).toMatchObject({ ok: false, error: 'Bridge method unavailable' })
  })

  it('is default-deny until both local feature activation and QA consent exist', async () => {
    const socket = new FakeWebSocket()
    authorizeQa(socket)
    registerAllHandlers({ cliRegistry: fakeRegistry({}) })
    await call(socket, 'disabled', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' }])
    expect(response(socket, 'disabled')).toMatchObject({ ok: true, data: { status: 'failed', code: 'feature_disabled' } })

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-cli-bridge-'))
    stateDirectories.push(parent)
    process.env.XYVA_AGENT_STATE_DIR = path.join(parent, 'state')
    process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_BRIDGE_TEST_MODE = '1'
    await call(socket, 'not-granted', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-2', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' }])
    expect(response(socket, 'not-granted')).toMatchObject({ ok: true, data: { status: 'failed', code: 'product_not_authorized' } })
  })

  it('records provider grant changes without secrets or prompt data', () => {
    grantCli('codex')
    const entries = SecurityGuard.getAgentAuditLog().filter((entry) => entry.action === 'provider-cli.grant')
    expect(entries.at(-1)).toMatchObject({ allowed: true, metadata: { providerId: 'codex', product: 'qa-studio', granted: true } })
    expect(JSON.stringify(entries.at(-1))).not.toMatch(/token|prompt|secret/iu)
  })

  it('uses a fake adapter, reports capabilities, and excludes caller-controlled process data', async () => {
    grantCli()
    const infer = vi.fn(async () => ({ outputText: 'synthetic answer', inputTokens: 2, outputTokens: 3 }))
    registerAllHandlers({ cliRegistry: fakeRegistry({ infer }) })
    const socket = new FakeWebSocket()
    authorizeQa(socket)
    await call(socket, 'capabilities', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-1' }])
    await call(socket, 'infer', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'read_only', prompt: 'synthetic prompt' }])
    expect(response(socket, 'capabilities')).toMatchObject({ ok: true, data: { status: 'completed', capabilities: expect.arrayContaining([expect.objectContaining({ providerId: 'codex', enabled: true, modes: ['read_only'] }), expect.objectContaining({ providerId: 'claude', enabled: false, modes: [] }), expect.objectContaining({ providerId: 'gemini', enabled: false, modes: [] })]) } })
    expect(response(socket, 'infer')).toMatchObject({ ok: true, data: { status: 'completed', outputText: 'synthetic answer' } })
    expect(infer).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^cli-socket-\d+:infer-1$/u), prompt: 'synthetic prompt', signal: expect.any(AbortSignal) }))
    await call(socket, 'unsafe', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-2', providerId: 'codex', mode: 'read_only', prompt: 'x', env: { SECRET: 'x' } }])
    expect(response(socket, 'unsafe')).toMatchObject({ ok: true, data: { status: 'failed', code: 'invalid_request' } })
  })

  it('dispatches a separately granted Claude request only to the Claude adapter and preserves provider identity', async () => {
    grantCli('claude')
    const infer = vi.fn(async () => ({ outputText: 'Claude synthetic answer', inputTokens: 4, outputTokens: 2 }))
    const claudeAdapter = {
      providerId: 'claude' as const,
      discover: async () => discovery('claude'), getReadiness: async () => discovery('claude'), beginLogin: async () => ({ started: false, detail: 'disabled' }),
      listModels: async () => [], getVersionStatus: async () => discovery('claude').version,
      cancel: () => false, infer,
    } as CliProviderAdapter
    const codexAdapter = fakeRegistry({}).get('codex')!
    registerAllHandlers({ cliRegistry: { get: (providerId: string) => providerId === 'claude' ? claudeAdapter : providerId === 'codex' ? codexAdapter : undefined, status: async () => [discovery('codex'), discovery('claude'), discovery('gemini')] } })
    const socket = new FakeWebSocket(); authorizeQa(socket)
    await call(socket, 'claude-capabilities', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-claude' }])
    await call(socket, 'claude-infer', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-claude', providerId: 'claude', mode: 'read_only', prompt: 'synthetic' }])
    expect(response(socket, 'claude-capabilities')).toMatchObject({ ok: true, data: { capabilities: expect.arrayContaining([expect.objectContaining({ providerId: 'claude', enabled: true, modes: ['read_only'] }), expect.objectContaining({ providerId: 'codex', enabled: false }), expect.objectContaining({ providerId: 'gemini', enabled: false, modes: [] })]) } })
    expect(response(socket, 'claude-infer')).toMatchObject({ ok: true, data: { status: 'completed', providerId: 'claude', outputText: 'Claude synthetic answer' } })
    expect(infer).toHaveBeenCalledOnce()
  })

  it.each([
    ['a synchronous exception', () => { throw new Error('SEC_CLI_CANARY_DO_NOT_LEAK_001 path=/synthetic/private token=synthetic') }],
    ['a rejected status promise', async () => { throw new Error('SEC_CLI_CANARY_DO_NOT_LEAK_001 path=/synthetic/private token=synthetic') }],
  ])('normalizes %s from capability discovery without leaking it to the WebSocket client', async (_label, status) => {
    grantCli()
    const socket = new FakeWebSocket(); authorizeQa(socket)
    const registry = fakeRegistry({})
    registerAllHandlers({ cliRegistry: { ...registry, status } })
    await call(socket, 'canary-failure', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-canary' }])

    const failure = response(socket, 'canary-failure')
    expect(failure).toMatchObject({ ok: true, data: { schemaVersion: 1, status: 'failed', requestId: 'cap-canary', code: 'adapter_error', retryable: true } })
    expect(validateProviderCliCapabilitiesOutcomeV1(failure?.data)).toMatchObject({ status: 'failed', code: 'adapter_error' })
    expect(JSON.stringify(failure)).not.toMatch(/SEC_CLI_CANARY|synthetic\/private|token=synthetic|stack/iu)
    expect(failure).not.toHaveProperty('error')

    registerAllHandlers({ cliRegistry: fakeRegistry({}) })
    await call(socket, 'after-canary', 'providerCliCapabilitiesV1', [{ schemaVersion: 1, requestId: 'cap-after' }])
    expect(response(socket, 'after-canary')).toMatchObject({ ok: true, data: { status: 'completed', requestId: 'cap-after' } })
  })

  it('cancels only the request on the owning QA socket and fails closed after completion', async () => {
    grantCli()
    const cancel = vi.fn(() => true)
    const infer = vi.fn((request: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))))
    registerAllHandlers({ cliRegistry: fakeRegistry({ infer, cancel }) })
    const owner = new FakeWebSocket(); const other = new FakeWebSocket()
    authorizeQa(owner); authorizeQa(other)
    const pending = call(owner, 'infer', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'shared', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' }])
    await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce())
    await call(other, 'cross-cancel', 'providerCliCancelV1', [{ schemaVersion: 1, requestId: 'shared' }])
    expect(response(other, 'cross-cancel')).toMatchObject({ ok: true, data: { status: 'failed', code: 'conflict' } })
    await call(owner, 'cancel', 'providerCliCancelV1', [{ schemaVersion: 1, requestId: 'shared' }])
    await pending
    expect(cancel).toHaveBeenCalledWith(expect.stringMatching(/^cli-socket-\d+:shared$/u))
    expect(response(owner, 'infer')).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    await call(owner, 'after', 'providerCliCancelV1', [{ schemaVersion: 1, requestId: 'shared' }])
    expect(response(owner, 'after')).toMatchObject({ ok: true, data: { status: 'failed', code: 'conflict' } })
  })

  it('namespaces identical request IDs across QA sockets before reaching the shared process manager', async () => {
    grantCli()
    const signals: AbortSignal[] = []
    const infer = vi.fn((request: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      if (!request.signal) return reject(new Error('missing signal'))
      signals.push(request.signal)
      request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const cancel = vi.fn(() => true)
    registerAllHandlers({ cliRegistry: fakeRegistry({ infer, cancel }) })
    const owner = new FakeWebSocket(); const other = new FakeWebSocket()
    authorizeQa(owner); authorizeQa(other)
    const ownerPending = call(owner, 'owner-infer', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'same', providerId: 'codex', mode: 'read_only', prompt: 'owner' }])
    await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce())
    const otherPending = call(other, 'other-infer', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'same', providerId: 'codex', mode: 'read_only', prompt: 'other' }])
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2))
    await call(other, 'other-cancel', 'providerCliCancelV1', [{ schemaVersion: 1, requestId: 'same' }])
    expect(response(other, 'other-cancel')).toMatchObject({ ok: true, data: { status: 'completed' } })
    expect(signals[0]?.aborted).toBe(false)
    await call(owner, 'owner-cancel', 'providerCliCancelV1', [{ schemaVersion: 1, requestId: 'same' }])
    await Promise.all([ownerPending, otherPending])
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('maps adapter errors to stable secret-free failure codes', async () => {
    grantCli()
    registerAllHandlers({ cliRegistry: fakeRegistry({ infer: async () => { throw new Error('api-key=do-not-reflect') } }) })
    const socket = new FakeWebSocket(); authorizeQa(socket)
    await call(socket, 'failure', 'providerCliInferV1', [{ schemaVersion: 1, requestId: 'infer-1', providerId: 'codex', mode: 'read_only', prompt: 'synthetic' }])
    expect(response(socket, 'failure')).toMatchObject({ ok: true, data: { status: 'failed', code: 'adapter_error' } })
    expect(JSON.stringify(socket.sent)).not.toContain('api-key=do-not-reflect')
  })
})
