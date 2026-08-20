import {
  validateProviderInferenceOutcomeV1,
  validateProviderInferenceRequestV1,
  validateProviderModelListOutcomeV1,
  validateProviderModelListRequestV1,
  type ProviderInferenceOutcomeV1,
  type ProviderInferenceRequestV1,
  type ProviderModelListOutcomeV1,
  type ProviderModelListRequestV1,
} from '@xyva/contracts'

export type ProviderBridgeMethodV1 =
  | 'providerListModelsV1'
  | 'providerInferV1'
  | 'providerCancelV1'

export interface ProviderBridgeCallTransportV1 {
  call(method: ProviderBridgeMethodV1, ...args: unknown[]): Promise<unknown>
}

export type ProviderCancellationOutcomeV1 =
  | { ok: true; cancellationRequested: true }
  | { ok: false; code: 'not_found' }

export class ProviderBridgeClientError extends Error {
  public constructor() {
    super('Invalid provider bridge response')
    this.name = 'ProviderBridgeClientError'
  }
}

function validRequestId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function exactCancellationResult(value: unknown): ProviderCancellationOutcomeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProviderBridgeClientError()
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (input.ok === true
    && keys.length === 2
    && keys[0] === 'cancellationRequested'
    && keys[1] === 'ok'
    && input.cancellationRequested === true) {
    return { ok: true, cancellationRequested: true }
  }
  if (input.ok === false && keys.length === 2 && keys[0] === 'error' && keys[1] === 'ok'
    && typeof input.error === 'string') {
    return { ok: false, code: 'not_found' }
  }
  throw new ProviderBridgeClientError()
}

/**
 * Product-neutral client for the credential-free provider bridge exposed by
 * @xyva/agent. Provider keys, endpoints and browser session tokens are owned by
 * the injected transport and never accepted by this API.
 */
export class ProviderBridgeClientV1 {
  readonly #transport: ProviderBridgeCallTransportV1

  public constructor(transport: ProviderBridgeCallTransportV1) {
    if (!transport || typeof transport.call !== 'function') throw new ProviderBridgeClientError()
    this.#transport = transport
  }

  public async listModels(requestValue: ProviderModelListRequestV1): Promise<ProviderModelListOutcomeV1> {
    let request: ProviderModelListRequestV1
    try {
      request = validateProviderModelListRequestV1(requestValue)
    } catch {
      throw new ProviderBridgeClientError()
    }
    try {
      const outcome = validateProviderModelListOutcomeV1(
        await this.#transport.call('providerListModelsV1', request),
      )
      if (outcome.requestId !== request.requestId
        || (outcome.status === 'completed' && outcome.providerId !== request.providerId)) {
        throw new ProviderBridgeClientError()
      }
      return outcome
    } catch (error) {
      if (error instanceof ProviderBridgeClientError) throw error
      throw new ProviderBridgeClientError()
    }
  }

  public async infer(requestValue: ProviderInferenceRequestV1): Promise<ProviderInferenceOutcomeV1> {
    let request: ProviderInferenceRequestV1
    try {
      request = validateProviderInferenceRequestV1(requestValue)
    } catch {
      throw new ProviderBridgeClientError()
    }
    try {
      const outcome = validateProviderInferenceOutcomeV1(
        await this.#transport.call('providerInferV1', request),
      )
      if (outcome.requestId !== request.requestId
        || (outcome.status === 'completed'
          && (outcome.providerId !== request.providerId || outcome.modelId !== request.modelId))) {
        throw new ProviderBridgeClientError()
      }
      return outcome
    } catch (error) {
      if (error instanceof ProviderBridgeClientError) throw error
      throw new ProviderBridgeClientError()
    }
  }

  public async cancel(requestId: string): Promise<ProviderCancellationOutcomeV1> {
    if (!validRequestId(requestId)) throw new ProviderBridgeClientError()
    try {
      return exactCancellationResult(
        await this.#transport.call('providerCancelV1', { requestId }),
      )
    } catch (error) {
      if (error instanceof ProviderBridgeClientError) throw error
      throw new ProviderBridgeClientError()
    }
  }
}
