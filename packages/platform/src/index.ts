export * from './contracts.js'

import type { IntegrationGrantV1, PlatformJobCommandResponseV1, PlatformJobV1, ProductEntitlementV1, QaValidationRequestV1, StartPlatformJobRequestV1, WorkspaceV1 } from './contracts.js'

export interface PlatformFetch {
  (input: string, init?: RequestInit): Promise<Response>
}

export interface PlatformClientOptions {
  readonly baseUrl: string
  readonly fetch?: PlatformFetch
}

export class PlatformClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number | null,
    public readonly correlationId: string | null,
  ) {
    super(message)
    this.name = 'PlatformClientError'
  }
}

function apiBaseUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('baseUrl must be an absolute HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('baseUrl must be an absolute HTTPS URL without credentials, query or fragment')
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, '')}/v1/`
  return parsed
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TypeError(`${name} must be a bounded identifier`)
}

async function responseJson<T>(response: Response): Promise<T> {
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) throw new PlatformClientError('XYVA platform request failed', response.status, correlationId)
  try {
    return await response.json() as T
  } catch {
    throw new PlatformClientError('XYVA platform returned invalid JSON', response.status, correlationId)
  }
}

export class PlatformClient {
  readonly #baseUrl: URL
  readonly #fetch: PlatformFetch

  public constructor(options: PlatformClientOptions) {
    this.#baseUrl = apiBaseUrl(options.baseUrl)
    this.#fetch = options.fetch ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') throw new TypeError('A fetch implementation is required')
  }

  public async listWorkspaces(): Promise<readonly WorkspaceV1[]> {
    return responseJson<readonly WorkspaceV1[]>(await this.#fetch(new URL('workspaces', this.#baseUrl).href, { headers: { accept: 'application/json' } }))
  }

  public async listEntitlements(workspaceId: string): Promise<readonly ProductEntitlementV1[]> {
    assertIdentifier(workspaceId, 'workspaceId')
    return responseJson<readonly ProductEntitlementV1[]>(await this.#fetch(new URL(`workspaces/${encodeURIComponent(workspaceId)}/entitlements`, this.#baseUrl).href, { headers: { accept: 'application/json' } }))
  }

  public async getIntegrationGrant(workspaceId: string, integrationId: string): Promise<IntegrationGrantV1> {
    assertIdentifier(workspaceId, 'workspaceId')
    assertIdentifier(integrationId, 'integrationId')
    return responseJson<IntegrationGrantV1>(await this.#fetch(new URL(`workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(integrationId)}`, this.#baseUrl).href, { headers: { accept: 'application/json' } }))
  }

  public async getJob(jobId: string): Promise<PlatformJobV1> {
    assertIdentifier(jobId, 'jobId')
    return responseJson<PlatformJobV1>(await this.#fetch(new URL(`jobs/${encodeURIComponent(jobId)}`, this.#baseUrl).href, { headers: { accept: 'application/json' } }))
  }

  public async startJob(request: StartPlatformJobRequestV1): Promise<PlatformJobV1> {
    assertIdentifier(request.workspaceId, 'workspaceId')
    assertIdentifier(request.productId, 'productId')
    assertIdentifier(request.integrationId, 'integrationId')
    assertIdentifier(request.capability, 'capability')
    assertIdentifier(request.idempotencyKey, 'idempotencyKey')
    const response = await this.#fetch(new URL(`workspaces/${encodeURIComponent(request.workspaceId)}/jobs`, this.#baseUrl).href, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, workspaceId: undefined }),
    })
    return (await responseJson<PlatformJobCommandResponseV1>(response)).job
  }

  public async startQaValidation(request: QaValidationRequestV1): Promise<PlatformJobV1> {
    if (request.schemaVersion !== 1 || request.environment !== 'staging' || request.capability !== 'qa.validation.run') {
      throw new TypeError('qa validation requests must be schema v1, staging-only, and use qa.validation.run')
    }
    assertIdentifier(request.workspaceId, 'workspaceId')
    assertIdentifier(request.flowRunId, 'flowRunId')
    assertIdentifier(request.testPlanReference, 'testPlanReference')
    assertIdentifier(request.contractVersion, 'contractVersion')
    assertIdentifier(request.correlationId, 'correlationId')
    assertIdentifier(request.idempotencyKey, 'idempotencyKey')
    return this.startJob({
      workspaceId: request.workspaceId,
      productId: 'flow',
      integrationId: 'qa-studio',
      capability: request.capability,
      idempotencyKey: request.idempotencyKey,
      requestReference: request.testPlanReference,
      correlationId: request.correlationId,
    })
  }

  public async cancelJob(workspaceId: string, jobId: string): Promise<PlatformJobV1> {
    assertIdentifier(workspaceId, 'workspaceId')
    assertIdentifier(jobId, 'jobId')
    const response = await this.#fetch(new URL(`workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/cancel`, this.#baseUrl).href, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    return (await responseJson<PlatformJobCommandResponseV1>(response)).job
  }
}

export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  return new PlatformClient(options)
}
