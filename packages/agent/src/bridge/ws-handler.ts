import type { BridgeRequest, BridgeResponse, BridgeEvent } from '@xyva/bridge-types'
import { BRIDGE_PROTOCOL_VERSION } from '@xyva/bridge-types'
import type { WebSocket } from 'ws'

import { checkLicenseGuard } from '../license.js'
import type { AgentProductCapability } from '../product-origins.js'

type MethodHandler = (...args: unknown[]) => Promise<unknown> | unknown
type StreamingHandler = (ws: WebSocket, ...args: unknown[]) => Promise<unknown> | unknown

const handlers = new Map<string, MethodHandler>()
const streamingHandlers = new Map<string, StreamingHandler>()
const UNLICENSED_SAFE_METHODS = new Set(['licenseStatus', 'stopRunner', 'swarmStop'])
const PROVIDER_BRIDGE_V1_METHODS = new Set([
  'providerListModelsV1',
  'providerInferV1',
  'providerCancelV1',
])
const UNAVAILABLE_METHOD_ERROR = 'Bridge method unavailable'

export interface BridgeConnectionContext {
  capability: AgentProductCapability
  sessionFamilyId: string
}

const connectionContexts = new WeakMap<WebSocket, BridgeConnectionContext>()

export function setBridgeConnectionContext(ws: WebSocket, context: BridgeConnectionContext): void {
  connectionContexts.set(ws, context)
}

export function clearBridgeConnectionContext(ws: WebSocket): void {
  connectionContexts.delete(ws)
}

export function getBridgeConnectionContext(ws: WebSocket): BridgeConnectionContext | undefined {
  return connectionContexts.get(ws)
}

export function registerHandler(method: string, handler: MethodHandler): void {
  handlers.set(method, handler)
}

export function registerStreamingHandler(method: string, handler: StreamingHandler): void {
  streamingHandlers.set(method, handler)
}

export function resetHandlers(): void {
  handlers.clear()
  streamingHandlers.clear()
}

export function sendEvent(ws: WebSocket, channel: string, data: unknown): void {
  const event: BridgeEvent = {
    type: 'event',
    channel,
    data,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event))
  }
}

export async function handleWsMessage(ws: WebSocket, msg: unknown): Promise<void> {
  if (!isBridgeRequest(msg)) {
    throw new Error('Invalid bridge request')
  }

  const responseBase = {
    type: 'result' as const,
    id: msg.id,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
  }

  const connectionContext = connectionContexts.get(ws)
  if (!connectionContext && PROVIDER_BRIDGE_V1_METHODS.has(msg.method)) {
    const response: BridgeResponse = { ...responseBase, ok: false, error: UNAVAILABLE_METHOD_ERROR }
    ws.send(JSON.stringify(response))
    return
  }
  if (connectionContext?.capability === 'provider-bridge.v1'
    && !PROVIDER_BRIDGE_V1_METHODS.has(msg.method)) {
    const response: BridgeResponse = { ...responseBase, ok: false, error: UNAVAILABLE_METHOD_ERROR }
    ws.send(JSON.stringify(response))
    return
  }

  if (!UNLICENSED_SAFE_METHODS.has(msg.method)) {
    const license = checkLicenseGuard()
    if (!license.allowed) {
      const response: BridgeResponse = {
        ...responseBase,
        ok: false,
        error: `License required: ${license.reason || 'paid agent capability blocked'}`,
      }
      ws.send(JSON.stringify(response))
      return
    }
  }

  const streamingHandler = streamingHandlers.get(msg.method)
  if (streamingHandler) {
    try {
      const data = await streamingHandler(ws, ...(msg.args || []))
      const response: BridgeResponse = { ...responseBase, ok: true, data }
      ws.send(JSON.stringify(response))
    } catch (error) {
      const response: BridgeResponse = { ...responseBase, ok: false, error: (error as Error).message || 'Streaming handler failed' }
      ws.send(JSON.stringify(response))
    }
    return
  }

  const handler = handlers.get(msg.method)
  if (!handler) {
    const response: BridgeResponse = { ...responseBase, ok: false, error: UNAVAILABLE_METHOD_ERROR }
    ws.send(JSON.stringify(response))
    return
  }

  try {
    const data = await handler(...(msg.args || []))
    const response: BridgeResponse = { ...responseBase, ok: true, data }
    ws.send(JSON.stringify(response))
  } catch (error) {
    const response: BridgeResponse = { ...responseBase, ok: false, error: (error as Error).message || 'Handler failed' }
    ws.send(JSON.stringify(response))
  }
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false
  }

  const candidate = value as Partial<BridgeRequest>
  const keys = Object.keys(value).sort()
  return keys.length === 5
    && keys[0] === 'args'
    && keys[1] === 'id'
    && keys[2] === 'method'
    && keys[3] === 'protocolVersion'
    && keys[4] === 'type'
    && candidate.type === 'call'
    && candidate.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof candidate.id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.id)
    && typeof candidate.method === 'string'
    && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(candidate.method)
    && Array.isArray(candidate.args)
    && candidate.args.length <= 32
}
