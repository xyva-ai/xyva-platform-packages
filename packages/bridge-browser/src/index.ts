import type {
  BridgeAuth,
  BridgeAuthResult,
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  Transport,
} from '@xyva/bridge-types'

/** Runtime protocol constant, compile-time bound to the canonical bridge type. */
export const BRIDGE_PROTOCOL_VERSION: BridgeAuth['protocolVersion'] = 1

type AgentInfo = NonNullable<BridgeAuthResult['agent']>

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface WsTransportOptions {
  callTimeoutMs?: number
  maxReconnectAttempts?: number
  maxReconnectDelayMs?: number
}

export interface TimedCallContext {
  requestId: string
  method: string
}

interface InternalCallOptions {
  timeoutMs?: number
  onTimeout?: (context: TimedCallContext) => void
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback
  return value as number
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) return fallback
  return value as number
}

function createRequestId(): string {
  const cryptoRef = globalThis.crypto
  if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID()
  if (typeof cryptoRef?.getRandomValues !== 'function') {
    throw new Error('Secure browser randomness is unavailable')
  }

  const bytes = cryptoRef.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const MISSING_PROPERTY = Symbol('missing-property')
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CHANNEL_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u

function ownDataProperty(record: Record<string, unknown>, key: string): unknown | typeof MISSING_PROPERTY {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !('value' in descriptor)) return MISSING_PROPERTY
  return descriptor.value
}

function hasExactDataProperties(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index] && ownDataProperty(record, key) !== MISSING_PROPERTY)
  )
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isAgentInfo(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasExactDataProperties(value, ['version', 'platform', 'node']) &&
    isBoundedString(ownDataProperty(value, 'version'), 256) &&
    isBoundedString(ownDataProperty(value, 'platform'), 256) &&
    isBoundedString(ownDataProperty(value, 'node'), 256)
  )
}

function isBridgeMessage(value: unknown): value is BridgeAuthResult | BridgeResponse | BridgeEvent {
  if (!isRecord(value)) return false
  const protocolVersion = ownDataProperty(value, 'protocolVersion')
  const type = ownDataProperty(value, 'type')
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION || typeof type !== 'string') {
    return false
  }

  if (type === 'auth-result') {
    const ok = ownDataProperty(value, 'ok')
    if (ok === true) {
      return (
        hasExactDataProperties(value, ['type', 'ok', 'agent', 'protocolVersion']) &&
        isAgentInfo(ownDataProperty(value, 'agent'))
      )
    }
    return (
      ok === false &&
      hasExactDataProperties(value, ['type', 'ok', 'error', 'protocolVersion']) &&
      isBoundedString(ownDataProperty(value, 'error'), 2_048)
    )
  }
  if (type === 'result') {
    const id = ownDataProperty(value, 'id')
    if (typeof id !== 'string' || !REQUEST_ID_PATTERN.test(id)) return false
    const ok = ownDataProperty(value, 'ok')
    if (ok === true) {
      return (
        hasExactDataProperties(value, ['type', 'id', 'ok', 'protocolVersion']) ||
        hasExactDataProperties(value, ['type', 'id', 'ok', 'data', 'protocolVersion'])
      )
    }
    return (
      ok === false &&
      hasExactDataProperties(value, ['type', 'id', 'ok', 'error', 'protocolVersion']) &&
      isBoundedString(ownDataProperty(value, 'error'), 2_048)
    )
  }
  if (type === 'event') {
    const channel = ownDataProperty(value, 'channel')
    return (
      typeof channel === 'string' &&
      CHANNEL_PATTERN.test(channel) &&
      hasExactDataProperties(value, ['type', 'channel', 'data', 'protocolVersion'])
    )
  }
  return false
}

/**
 * Browser-only transport for the versioned XYVA bridge protocol.
 *
 * This class is deliberately product- and method-neutral. Product wrappers may
 * specialize call timeouts through the protected callWithOptions hook without
 * moving product methods, credentials or UI policy into this package.
 */
export class WsTransport implements Transport {
  private ws: WebSocket | null = null
  private connectedState = false
  private readonly pending = new Map<string, PendingCall>()
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private readonly errorListeners = new Set<(error: string | null) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly callTimeoutMs: number
  private readonly maxReconnectAttempts: number
  private readonly maxReconnectDelayMs: number
  private url = ''
  private token = ''
  private tokenProvider: (() => Promise<string>) | null = null
  private shouldReconnect = false
  private connectionGeneration = 0
  private lastError: string | null = null
  private agentInfo: AgentInfo | null = null

  constructor(options: WsTransportOptions = {}) {
    this.callTimeoutMs = normalizePositiveInteger(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS)
    this.maxReconnectAttempts = normalizeNonNegativeInteger(
      options.maxReconnectAttempts,
      DEFAULT_MAX_RECONNECT_ATTEMPTS,
    )
    this.maxReconnectDelayMs = normalizePositiveInteger(
      options.maxReconnectDelayMs,
      DEFAULT_MAX_RECONNECT_DELAY_MS,
    )
  }

  get connected(): boolean {
    return this.connectedState
  }

  getAgentInfo(): AgentInfo | null {
    return this.agentInfo
  }

  getLastError(): string | null {
    return this.lastError
  }

  connect(url: string, token: string, tokenProvider?: () => Promise<string>): void {
    const previousSocket = this.ws
    const generation = ++this.connectionGeneration
    this.ws = null
    this.url = url
    this.token = token
    this.tokenProvider = tokenProvider ?? null
    this.shouldReconnect = true
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.rejectPending(new Error('Connection replaced'))
    this.agentInfo = null
    this.setConnected(false)
    this.setError(null)
    previousSocket?.close()

    void this.doConnect(false, generation)
  }

  disconnect(): void {
    const previousSocket = this.ws
    this.connectionGeneration += 1
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.rejectPending(new Error('Connection closed'))
    this.ws = null
    this.token = ''
    this.tokenProvider = null
    this.agentInfo = null
    this.setConnected(false)
    previousSocket?.close()
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.callWithOptions<T>(method, args)
  }

  protected callWithOptions<T = unknown>(
    method: string,
    args: unknown[] | ((requestId: string) => unknown[]),
    options: InternalCallOptions = {},
  ): Promise<T> {
    const socket = this.ws
    if (!socket || !this.connectedState || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(this.lastError || 'Agent not connected'))
    }

    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(new Error('Bridge method must be a non-empty string'))
    }

    let id: string
    let requestArgs: unknown[]
    try {
      id = createRequestId()
      requestArgs = typeof args === 'function' ? args(id) : args
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Could not prepare bridge call'))
    }

    const request: BridgeRequest = {
      type: 'call',
      id,
      method,
      args: requestArgs,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    }
    const timeoutMs = normalizePositiveInteger(options.timeoutMs, this.callTimeoutMs)

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        try {
          options.onTimeout?.({ requestId: id, method })
        } catch {
          // Timeout callbacks are product-owned best-effort cleanup only.
        }
        reject(new Error(`Timeout while calling ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      try {
        socket.send(JSON.stringify(request))
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('Bridge call could not be sent'))
      }
    })
  }

  protected sendBestEffort(method: string, args: unknown[]): void {
    const socket = this.ws
    if (!socket || !this.connectedState || socket.readyState !== WebSocket.OPEN) return
    if (typeof method !== 'string' || method.length === 0) return

    let id: string
    try {
      id = createRequestId()
    } catch {
      return
    }
    const request: BridgeRequest = {
      type: 'call',
      id,
      method,
      args,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    }
    try {
      socket.send(JSON.stringify(request))
    } catch {
      // Socket close is handled by the owner-generation lifecycle.
    }
  }

  subscribe(channel: string, callback: (data: unknown) => void): () => void {
    let listeners = this.eventListeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(channel, listeners)
    }

    listeners.add(callback)
    return () => {
      const current = this.eventListeners.get(channel)
      current?.delete(callback)
      if (current?.size === 0) this.eventListeners.delete(channel)
    }
  }

  onStatusChange(callback: (connected: boolean) => void): () => void {
    this.statusListeners.add(callback)
    return () => this.statusListeners.delete(callback)
  }

  onErrorChange(callback: (error: string | null) => void): () => void {
    this.errorListeners.add(callback)
    return () => this.errorListeners.delete(callback)
  }

  private async doConnect(refreshToken: boolean, generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation)) return

    if (refreshToken && this.tokenProvider) {
      const tokenProvider = this.tokenProvider
      try {
        const token = await tokenProvider()
        if (!this.isActiveGeneration(generation)) return
        this.token = token
      } catch {
        this.scheduleReconnect(generation)
        return
      }
    }

    if (!this.isActiveGeneration(generation)) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect(generation)
      return
    }
    if (!this.isActiveGeneration(generation)) {
      socket.close()
      return
    }
    this.ws = socket

    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, generation)) return
      const auth: BridgeAuth = {
        type: 'auth',
        token: this.token,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      }
      try {
        socket.send(JSON.stringify(auth))
      } catch {
        this.failConnection(socket, 'Connection authentication failed')
      }
    }

    socket.onmessage = (event) => {
      if (!this.isCurrentSocket(socket, generation) || typeof event.data !== 'string') return
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        this.failConnection(socket, 'Bridge protocol error')
        return
      }
      if (!isBridgeMessage(message)) {
        this.failConnection(socket, 'Bridge protocol error')
        return
      }
      this.handleMessage(message, socket)
    }

    socket.onclose = () => {
      if (!this.isCurrentSocket(socket, generation)) return
      const reconnect = this.shouldReconnect
      this.ws = null
      this.setConnected(false)
      this.rejectPending(new Error('Connection lost'))
      if (reconnect) this.scheduleReconnect(generation)
    }

    socket.onerror = () => {
      // onclose owns reconnect and pending cleanup.
    }
  }

  private handleMessage(message: BridgeAuthResult | BridgeResponse | BridgeEvent, socket: WebSocket): void {
    if (!this.connectedState && message.type !== 'auth-result') {
      this.failConnection(socket, 'Bridge protocol error')
      return
    }

    switch (message.type) {
      case 'auth-result':
        if (this.connectedState) {
          this.failConnection(socket, 'Bridge protocol error')
          return
        }
        if (message.ok) {
          this.agentInfo = message.agent ?? null
          this.setError(null)
          this.setConnected(true)
          this.reconnectAttempt = 0
        } else {
          this.shouldReconnect = false
          this.setError(message.error || 'Authentication failed')
          socket.close()
        }
        break
      case 'result': {
        const pendingCall = this.pending.get(message.id)
        if (!pendingCall) return
        this.pending.delete(message.id)
        clearTimeout(pendingCall.timeout)
        if (message.ok) pendingCall.resolve(message.data)
        else pendingCall.reject(new Error(message.error || 'Call failed'))
        break
      }
      case 'event': {
        const listeners = this.eventListeners.get(message.channel)
        listeners?.forEach((listener) => listener(message.data))
        break
      }
    }
  }

  private failConnection(socket: WebSocket, error: string): void {
    if (this.ws !== socket) return
    this.shouldReconnect = false
    this.ws = null
    this.agentInfo = null
    this.setConnected(false)
    this.setError(error)
    this.rejectPending(new Error(error))
    socket.close()
  }

  private setConnected(connected: boolean): void {
    if (this.connectedState === connected) return
    this.connectedState = connected
    this.statusListeners.forEach((listener) => listener(connected))
  }

  private setError(error: string | null): void {
    if (this.lastError === error) return
    this.lastError = error
    this.errorListeners.forEach((listener) => listener(error))
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.connectionGeneration
  }

  private isActiveGeneration(generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.shouldReconnect
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.ws === socket
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isActiveGeneration(generation) || this.reconnectAttempt >= this.maxReconnectAttempts) return
    this.clearReconnectTimer()
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, this.maxReconnectDelayMs)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      if (!this.isActiveGeneration(generation)) return
      void this.doConnect(true, generation)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((pendingCall) => {
      clearTimeout(pendingCall.timeout)
      pendingCall.reject(error)
    })
    this.pending.clear()
  }
}
