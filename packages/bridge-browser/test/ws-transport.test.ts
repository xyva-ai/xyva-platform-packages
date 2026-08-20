import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BRIDGE_PROTOCOL_VERSION as CANONICAL_BRIDGE_PROTOCOL_VERSION } from '@xyva/bridge-types'
import { BRIDGE_PROTOCOL_VERSION, WsTransport } from '../src/index.js'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: MockWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSING
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  emitMessage(message: unknown): void {
    this.emitRaw(JSON.stringify(message))
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close') as CloseEvent)
  }
}

function authResult(version = '0.1.13') {
  return {
    type: 'auth-result',
    ok: true,
    agent: { version, platform: 'darwin', node: 'v22.14.0' },
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
  }
}

function authenticate(transport: WsTransport): MockWebSocket {
  transport.connect('ws://bridge.test', 'runtime-session')
  const socket = MockWebSocket.instances.at(-1)
  if (!socket) throw new Error('socket not created')
  socket.emitOpen()
  socket.emitMessage(authResult())
  return socket
}

describe('WsTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances.splice(0)
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps its browser runtime protocol constant aligned with the canonical bridge contract', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(CANONICAL_BRIDGE_PROTOCOL_VERSION)
  })

  it('sends only the protocol auth frame before accepting calls', async () => {
    const transport = new WsTransport()
    transport.connect('ws://bridge.test', 'runtime-session')
    const socket = MockWebSocket.instances[0]
    socket.emitOpen()

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'auth',
      token: 'runtime-session',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    await expect(transport.call('anyMethod')).rejects.toThrow('Agent not connected')
    expect(socket.sent).toHaveLength(1)

    socket.emitMessage(authResult())
    const call = transport.call('anyMethod', { value: 1 })
    const request = JSON.parse(socket.sent[1])
    expect(request).toMatchObject({
      type: 'call',
      method: 'anyMethod',
      args: [{ value: 1 }],
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    socket.emitMessage({
      type: 'result',
      id: request.id,
      ok: true,
      data: { done: true },
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    await expect(call).resolves.toEqual({ done: true })
  })

  it('forwards generic events and removes unsubscribed listeners', () => {
    const transport = new WsTransport()
    const socket = authenticate(transport)
    const listener = vi.fn()
    const unsubscribe = transport.subscribe('run:update', listener)

    socket.emitMessage({
      type: 'event',
      channel: 'run:update',
      data: { phase: 'running' },
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    expect(listener).toHaveBeenCalledWith({ phase: 'running' })

    unsubscribe()
    socket.emitMessage({
      type: 'event',
      channel: 'run:update',
      data: { phase: 'done' },
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects a pending call after its bounded timeout', async () => {
    const transport = new WsTransport({ callTimeoutMs: 25 })
    authenticate(transport)
    const call = transport.call('slowMethod')
    const rejection = expect(call).rejects.toThrow('Timeout while calling slowMethod')

    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })

  it('rejects pending calls when a socket is replaced or disconnected', async () => {
    const transport = new WsTransport()
    authenticate(transport)
    const replacedCall = transport.call('firstOwner')
    const replacedRejection = expect(replacedCall).rejects.toThrow('Connection replaced')

    transport.connect('ws://bridge.test', 'second-runtime-session')
    await replacedRejection
    const secondSocket = MockWebSocket.instances.at(-1)!
    secondSocket.emitOpen()
    secondSocket.emitMessage(authResult('second-owner'))

    const disconnectedCall = transport.call('secondOwner')
    const disconnectedRejection = expect(disconnectedCall).rejects.toThrow('Connection closed')
    transport.disconnect()
    await disconnectedRejection
    expect(transport.connected).toBe(false)
  })

  it('ignores stale owner events and delayed reconnect token work', async () => {
    let resolveRefresh!: (token: string) => void
    const refreshedToken = new Promise<string>((resolve) => {
      resolveRefresh = resolve
    })
    const transport = new WsTransport({ maxReconnectDelayMs: 1_000 })
    const statuses: boolean[] = []
    transport.onStatusChange((connected) => statuses.push(connected))

    transport.connect('ws://bridge.test', 'owner-a', () => refreshedToken)
    const ownerA = MockWebSocket.instances[0]
    ownerA.emitOpen()
    ownerA.emitMessage(authResult('owner-a'))
    ownerA.emitClose()
    await vi.advanceTimersByTimeAsync(1_000)

    transport.connect('ws://bridge.test', 'owner-b')
    const ownerB = MockWebSocket.instances.at(-1)!
    ownerB.emitOpen()
    ownerB.emitMessage(authResult('owner-b'))
    resolveRefresh('late-owner-a')
    await Promise.resolve()
    await Promise.resolve()

    ownerA.emitMessage(authResult('stale-owner'))
    ownerA.emitClose()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(transport.connected).toBe(true)
    expect(transport.getAgentInfo()?.version).toBe('owner-b')
    expect(statuses).toEqual([true, false, true])
  })

  it('fails closed on unauthenticated, malformed or wrong-version frames', () => {
    const transport = new WsTransport()
    transport.connect('ws://bridge.test', 'runtime-session')
    const socket = MockWebSocket.instances[0]
    socket.emitOpen()
    socket.emitMessage({
      type: 'result',
      id: 'not-authenticated',
      ok: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    expect(transport.connected).toBe(false)
    expect(transport.getLastError()).toBe('Bridge protocol error')
    expect(socket.readyState).toBe(MockWebSocket.CLOSING)

    const second = new WsTransport()
    second.connect('ws://bridge.test', 'runtime-session')
    const secondSocket = MockWebSocket.instances.at(-1)!
    secondSocket.emitOpen()
    secondSocket.emitMessage({ ...authResult(), protocolVersion: 999 })
    expect(second.connected).toBe(false)
    expect(second.getLastError()).toBe('Bridge protocol error')
  })

  it('fails closed on ambiguous frames with extra or contradictory fields', () => {
    const transport = new WsTransport()
    transport.connect('ws://bridge.test', 'runtime-session')
    const socket = MockWebSocket.instances[0]
    socket.emitOpen()
    socket.emitMessage({ ...authResult(), error: 'must not coexist with a successful auth result' })

    expect(transport.connected).toBe(false)
    expect(transport.getLastError()).toBe('Bridge protocol error')
    expect(socket.readyState).toBe(MockWebSocket.CLOSING)

    const second = new WsTransport()
    const secondSocket = authenticate(second)
    secondSocket.emitMessage({
      type: 'event',
      channel: 'run:update',
      data: { phase: 'running' },
      unexpected: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    expect(second.connected).toBe(false)
    expect(second.getLastError()).toBe('Bridge protocol error')
  })

  it('ignores non-string foreign-prototype payloads without reading their properties', () => {
    const transport = new WsTransport()
    const socket = authenticate(transport)
    const typeGetter = vi.fn(() => 'event')
    const foreignPayload = Object.create({ type: 'event' })
    Object.defineProperty(foreignPayload, 'type', { get: typeGetter })

    socket.emitRaw(foreignPayload)
    expect(typeGetter).not.toHaveBeenCalled()
    expect(transport.connected).toBe(true)
  })
})
