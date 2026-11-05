import {
  validateProviderCliCancellationOutcomeV1,
  validateProviderCliCancellationRequestV1,
  validateProviderCliCapabilitiesOutcomeV1,
  validateProviderCliCapabilitiesRequestV1,
  validateProviderCliInferenceOutcomeV1,
  validateProviderCliInferenceRequestV1,
  type ProviderCliCancellationOutcomeV1,
  type ProviderCliCancellationRequestV1,
  type ProviderCliCapabilitiesOutcomeV1,
  type ProviderCliCapabilitiesRequestV1,
  type ProviderCliInferenceOutcomeV1,
  type ProviderCliInferenceRequestV1,
} from '@xyva/contracts'

export type ProviderCliBridgeMethodV1 = 'providerCliCapabilitiesV1' | 'providerCliInferV1' | 'providerCliCancelV1'
export interface ProviderCliBridgeCallTransportV1 { call(method: ProviderCliBridgeMethodV1, ...args: unknown[]): Promise<unknown> }
export class ProviderCliBridgeClientError extends Error { public constructor() { super('Invalid provider CLI bridge response'); this.name = 'ProviderCliBridgeClientError' } }

/** Credential-free typed client for the separately authorized CLI bridge. */
export class ProviderCliBridgeClientV1 {
  public constructor(private readonly transport: ProviderCliBridgeCallTransportV1) {
    if (!transport || typeof transport.call !== 'function') throw new ProviderCliBridgeClientError()
  }
  public async capabilities(requestValue: ProviderCliCapabilitiesRequestV1): Promise<ProviderCliCapabilitiesOutcomeV1> {
    let request: ProviderCliCapabilitiesRequestV1
    try { request = validateProviderCliCapabilitiesRequestV1(requestValue) } catch { throw new ProviderCliBridgeClientError() }
    return this.call('providerCliCapabilitiesV1', request, validateProviderCliCapabilitiesOutcomeV1)
  }
  public async infer(requestValue: ProviderCliInferenceRequestV1): Promise<ProviderCliInferenceOutcomeV1> {
    let request: ProviderCliInferenceRequestV1
    try { request = validateProviderCliInferenceRequestV1(requestValue) } catch { throw new ProviderCliBridgeClientError() }
    const outcome = await this.call('providerCliInferV1', request, validateProviderCliInferenceOutcomeV1)
    if (outcome.requestId !== request.requestId || (outcome.status === 'completed' && outcome.providerId !== request.providerId)) throw new ProviderCliBridgeClientError()
    return outcome
  }
  public async cancel(requestValue: ProviderCliCancellationRequestV1): Promise<ProviderCliCancellationOutcomeV1> {
    let request: ProviderCliCancellationRequestV1
    try { request = validateProviderCliCancellationRequestV1(requestValue) } catch { throw new ProviderCliBridgeClientError() }
    const outcome = await this.call('providerCliCancelV1', request, validateProviderCliCancellationOutcomeV1)
    if (outcome.requestId !== request.requestId) throw new ProviderCliBridgeClientError()
    return outcome
  }
  private async call<T>(method: ProviderCliBridgeMethodV1, request: unknown, validate: (value: unknown) => T): Promise<T> {
    try { return validate(await this.transport.call(method, request)) } catch (error) { if (error instanceof ProviderCliBridgeClientError) throw error; throw new ProviderCliBridgeClientError() }
  }
}
