import type { SwarmCompletePayload, SwarmCallbacks } from '@xyva/bridge-types'

import type { SwarmRun } from '../../../../xyva-swarms/src/contracts/run-events.js'
import type { SwarmHostEventsPort } from '../../../../xyva-swarms/src/ports/host-events.js'
import { toBridgeSwarmRun } from './mappers.js'

export class CallbackSwarmHostEvents implements SwarmHostEventsPort {
  constructor(private readonly callbacks: SwarmCallbacks) {}

  sendAgentUpdate(update: Parameters<NonNullable<SwarmCallbacks['onAgentUpdate']>>[0]): void {
    this.callbacks.onAgentUpdate?.(update)
  }

  sendFinding(event: Parameters<NonNullable<SwarmCallbacks['onFinding']>>[0]): void {
    this.callbacks.onFinding?.(event)
  }

  sendGuardrailSkip(event: Parameters<NonNullable<SwarmCallbacks['onGuardrailSkip']>>[0]): void {
    this.callbacks.onGuardrailSkip?.(event)
  }

  sendError(message: string): void {
    this.callbacks.onError?.(message)
  }

  sendComplete(payload: { ok: boolean; run?: SwarmRun; runDir?: string; error?: string }): void {
    const bridgePayload: SwarmCompletePayload = {
      ok: payload.ok,
      run: payload.run ? toBridgeSwarmRun(payload.run) : undefined,
      runDir: payload.runDir,
      error: payload.error,
    }

    this.callbacks.onComplete?.(bridgePayload)
  }
}
