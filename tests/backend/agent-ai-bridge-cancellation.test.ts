// @vitest-environment node

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'

vi.mock('../../packages/agent/src/license.js', () => ({
  checkLicenseGuard: () => ({ allowed: true, tier: 'test' }),
  getLicenseStatus: () => ({ allowed: true, tier: 'test' }),
}))

import { registerAllHandlers } from '../../packages/agent/src/bridge/register-handlers.js'
import {
  handleWsMessage,
  resetHandlers,
  setBridgeConnectionContext,
} from '../../packages/agent/src/bridge/ws-handler.js'
import { saveProviderConfiguration, setFlowProviderGrant } from '../../packages/agent/src/config.js'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readonly sent: string[] = []
  readyState = this.OPEN

  send(value: string): void {
    this.sent.push(value)
  }
}

afterEach(() => {
  resetHandlers()
  vi.unstubAllGlobals()
  process.env.XYVA_AGENT_STATE_DIR = previousStateDirectory
  for (const directory of stateDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const stateDirectories: string[] = []
const previousStateDirectory = process.env.XYVA_AGENT_STATE_DIR

function configureLocalProvider(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-ai-cancel-'))
  stateDirectories.push(directory)
  process.env.XYVA_AGENT_STATE_DIR = directory
  saveProviderConfiguration({ providerId: 'ollama', defaultModel: 'gemma3:4b' })
  setFlowProviderGrant('ollama', true)
}

describe('AI bridge cancellation', () => {
  it('aborts only the matching request on the same socket', async () => {
    configureLocalProvider()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chat = handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'bridge-chat', method: 'aiChat', protocolVersion: 1,
      args: [{ provider: 'ollama', model: 'gemma3:4b' }, [{ role: 'user', content: 'hello' }], { requestId: 'request-1' }],
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'bridge-cancel', method: 'aiCancel', protocolVersion: 1, args: ['request-1'],
    })
    await chat

    const responses = socket.sent.map((value) => JSON.parse(value))
    expect(responses.find((response) => response.id === 'bridge-cancel')).toMatchObject({ ok: true, data: { ok: true, cancellationRequested: true } })
    expect(responses.find((response) => response.id === 'bridge-chat')).toMatchObject({
      ok: true,
      data: { ok: false, code: 'cancelled' },
    })
  })

  it('aborts provider I/O when the owning socket closes', async () => {
    configureLocalProvider()
    registerAllHandlers()
    const socket = new FakeWebSocket()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('closed', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chat = handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id: 'bridge-close-chat', method: 'aiChat', protocolVersion: 1,
      args: [{ provider: 'ollama', model: 'gemma3:4b' }, [{ role: 'user', content: 'hello' }], { requestId: 'request-close' }],
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    socket.emit('close')
    await chat

    expect(socket.sent.map((value) => JSON.parse(value)).find((response) => response.id === 'bridge-close-chat'))
      .toMatchObject({ ok: true, data: { ok: false, code: 'cancelled' } })
  })

  it('isolates identical request IDs and cancellation across sockets', async () => {
    configureLocalProvider()
    registerAllHandlers()
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const providerSignals: AbortSignal[] = []
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init.signal) providerSignals.push(init.signal)
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = (socket: FakeWebSocket, id: string) => handleWsMessage(socket as unknown as WebSocket, {
      type: 'call', id, method: 'aiChat', protocolVersion: 1,
      args: [{ provider: 'ollama', model: 'gemma3:4b' }, [{ role: 'user', content: 'same prompt' }], { requestId: 'shared-request' }],
    })
    const chatA = request(socketA, 'chat-a')
    const chatB = request(socketB, 'chat-b')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await handleWsMessage(socketB as unknown as WebSocket, {
      type: 'call', id: 'cancel-b', method: 'aiCancel', protocolVersion: 1, args: ['shared-request'],
    })
    await chatB
    expect(providerSignals[0]?.aborted).toBe(false)
    expect(providerSignals[1]?.aborted).toBe(true)
    expect(socketB.sent.map((value) => JSON.parse(value)).find((response) => response.id === 'chat-b'))
      .toMatchObject({ ok: true, data: { ok: false, code: 'cancelled' } })

    await handleWsMessage(socketA as unknown as WebSocket, {
      type: 'call', id: 'cancel-a', method: 'aiCancel', protocolVersion: 1, args: ['shared-request'],
    })
    await chatA
    expect(providerSignals[0]?.aborted).toBe(true)
  })

  it('deduplicates completed provider work across reconnects in one authenticated session family', async () => {
    configureLocalProvider()
    registerAllHandlers()
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const socketOtherFamily = new FakeWebSocket()
    setBridgeConnectionContext(socketA as unknown as WebSocket, {
      capability: 'provider-bridge.v1',
      sessionFamilyId: 'family-a',
    })
    setBridgeConnectionContext(socketB as unknown as WebSocket, {
      capability: 'provider-bridge.v1',
      sessionFamilyId: 'family-a',
    })
    setBridgeConnectionContext(socketOtherFamily as unknown as WebSocket, {
      capability: 'provider-bridge.v1',
      sessionFamilyId: 'family-b',
    })

    let resolveFirst: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })).mockResolvedValue(new Response(JSON.stringify({
      message: { content: 'separate family' },
      prompt_eval_count: 1,
      eval_count: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const inferenceRequest = (socket: FakeWebSocket, callId: string, requestId: string) => handleWsMessage(
      socket as unknown as WebSocket,
      {
        type: 'call',
        id: callId,
        method: 'providerInferV1',
        protocolVersion: 1,
        args: [{
          schemaVersion: 1,
          requestId,
          idempotencyKey: 'stable-effect',
          providerId: 'ollama',
          modelId: 'gemma3:4b',
          messages: [{ role: 'user', content: 'same prompt' }],
          maxOutputTokens: 32,
          requiredCapabilities: ['text.generate'],
        }],
      },
    )

    const first = inferenceRequest(socketA, 'call-a', 'request-a')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await inferenceRequest(socketB, 'call-b-pending', 'request-b-pending')
    expect(socketB.sent.map((value) => JSON.parse(value)).find((value) => value.id === 'call-b-pending'))
      .toMatchObject({ ok: true, data: { status: 'failed', code: 'conflict' } })

    resolveFirst?.(new Response(JSON.stringify({
      message: { content: 'shared result' },
      prompt_eval_count: 1,
      eval_count: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await first
    await inferenceRequest(socketB, 'call-b-complete', 'request-b-complete')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(socketB.sent.map((value) => JSON.parse(value)).find((value) => value.id === 'call-b-complete'))
      .toMatchObject({ ok: true, data: { status: 'completed', outputText: 'shared result' } })

    await inferenceRequest(socketOtherFamily, 'call-other-family', 'request-other-family')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
