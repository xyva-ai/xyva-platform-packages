import { randomUUID } from 'node:crypto'

import type { CliProviderId } from './cli-types.js'

export class CliProcessBusyError extends Error {
  public constructor() { super('CLI provider is busy') }
}

export class CliDuplicateRequestError extends Error {
  public constructor() { super('CLI request ID is already active') }
}

export interface CliProcessLease {
  readonly requestId: string
  readonly signal: AbortSignal
  release(): void
}

type ActiveRequest = { providerId: CliProviderId; controller: AbortController }

/** Shared, bounded, request-addressable lifecycle state for CLI subprocesses. */
export class CliProcessManager {
  readonly #active = new Map<string, ActiveRequest>()

  public constructor(
    private readonly maximumPerProvider = 1,
    private readonly maximumTotal = 2,
  ) {}

  public acquire(providerId: CliProviderId, requestedId?: string): CliProcessLease {
    const requestId = requestedId || randomUUID()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) throw new Error('Invalid CLI request ID')
    if (this.#active.has(requestId)) throw new CliDuplicateRequestError()
    if (this.#active.size >= this.maximumTotal || this.activeFor(providerId) >= this.maximumPerProvider) throw new CliProcessBusyError()
    const controller = new AbortController()
    this.#active.set(requestId, { providerId, controller })
    let released = false
    return {
      requestId,
      signal: controller.signal,
      release: () => {
        if (released) return
        released = true
        const active = this.#active.get(requestId)
        if (active?.controller === controller) this.#active.delete(requestId)
      },
    }
  }

  public cancel(requestId: string): boolean {
    const active = this.#active.get(requestId)
    if (!active || active.controller.signal.aborted) return false
    active.controller.abort()
    return true
  }

  public hasActiveRequests(providerId?: CliProviderId): boolean {
    return providerId ? this.activeFor(providerId) > 0 : this.#active.size > 0
  }

  private activeFor(providerId: CliProviderId): number {
    return [...this.#active.values()].filter((active) => active.providerId === providerId).length
  }
}
