/** Public, transport-safe provider contracts shared by XYVA products. */

export const PROVIDER_IDS_V1 = ['ollama', 'lmstudio', 'openai', 'claude', 'gemini'] as const
export type ProviderIdV1 = (typeof PROVIDER_IDS_V1)[number]

export const PROVIDER_CAPABILITIES_V1 = [
  'model.list',
  'text.generate',
  'usage.reported',
  'usage.reasoning',
  'request.cancel.abort-signal',
] as const
export type ProviderCapabilityIdV1 = (typeof PROVIDER_CAPABILITIES_V1)[number]

export const PROVIDER_FAILURE_CODES_V1 = [
  'invalid_request',
  'authentication_failed',
  'model_unavailable',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'busy',
  'conflict',
  'policy_denied',
  'provider_error',
] as const
export type ProviderFailureCodeV1 = (typeof PROVIDER_FAILURE_CODES_V1)[number]

export type ProviderTransportClassV1 = 'local-loopback' | 'cloud'
export type ProviderUsageSourceV1 = 'reported' | 'estimated'
export type ProviderMessageRoleV1 = 'system' | 'user' | 'assistant'

export interface ProviderDescriptorV1 {
  schemaVersion: 1
  providerId: ProviderIdV1
  displayName: string
  transportClass: ProviderTransportClassV1
  capabilities: ProviderCapabilityIdV1[]
}

export interface ModelDescriptorV1 {
  schemaVersion: 1
  providerId: ProviderIdV1
  modelId: string
  displayName: string | null
  capabilities: ProviderCapabilityIdV1[]
  maxOutputTokens: number | null
  status: 'available' | 'unavailable'
}

export interface ProviderModelListRequestV1 {
  schemaVersion: 1
  requestId: string
  providerId: ProviderIdV1
}

export type ProviderModelListOutcomeV1 =
  | {
      schemaVersion: 1
      status: 'completed'
      requestId: string
      providerId: ProviderIdV1
      models: ModelDescriptorV1[]
    }
  | {
      schemaVersion: 1
      status: 'failed'
      requestId: string
      code: ProviderFailureCodeV1
      retryable: boolean
    }

export interface ProviderMessageV1 {
  role: ProviderMessageRoleV1
  content: string
}

export interface ProviderInferenceRequestV1 {
  schemaVersion: 1
  requestId: string
  idempotencyKey: string
  providerId: ProviderIdV1
  modelId: string
  messages: ProviderMessageV1[]
  maxOutputTokens: number
  requiredCapabilities: ProviderCapabilityIdV1[]
}

export interface ProviderUsageV1 {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  source: ProviderUsageSourceV1
}

export type ProviderInferenceOutcomeV1 =
  | {
      schemaVersion: 1
      status: 'completed'
      requestId: string
      providerId: ProviderIdV1
      modelId: string
      outputText: string
      usage: ProviderUsageV1
    }
  | {
      schemaVersion: 1
      status: 'cancelled'
      requestId: string
    }
  | {
      schemaVersion: 1
      status: 'failed'
      requestId: string
      code: ProviderFailureCodeV1
      retryable: boolean
    }

export class ProviderContractValidationError extends Error {
  public constructor() {
    super('Invalid provider contract')
    this.name = 'ProviderContractValidationError'
  }
}

type UnknownRecord = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const MAX_MESSAGE_BYTES = 32 * 1024
const MAX_MESSAGES = 64
const MAX_OUTPUT_TOKENS = 8_192

function fail(): never { throw new ProviderContractValidationError() }
function record(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail()
  return value as UnknownRecord
}
function exactKeys(value: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail()
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail(); return value }
function modelId(value: unknown): string { if (typeof value !== 'string' || !MODEL_ID.test(value)) fail(); return value }
function positiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) fail()
  return value
}
function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maximumBytes) fail()
  return value
}
function providerId(value: unknown): ProviderIdV1 {
  if (typeof value !== 'string' || !PROVIDER_IDS_V1.includes(value as ProviderIdV1)) fail()
  return value as ProviderIdV1
}
function failureCode(value: unknown): ProviderFailureCodeV1 {
  if (typeof value !== 'string' || !PROVIDER_FAILURE_CODES_V1.includes(value as ProviderFailureCodeV1)) fail()
  return value as ProviderFailureCodeV1
}
function capability(value: unknown): ProviderCapabilityIdV1 {
  if (typeof value !== 'string' || !PROVIDER_CAPABILITIES_V1.includes(value as ProviderCapabilityIdV1)) fail()
  return value as ProviderCapabilityIdV1
}
function capabilities(value: unknown, maximum = 16): ProviderCapabilityIdV1[] {
  if (!Array.isArray(value) || value.length > maximum) fail()
  const result = value.map(capability)
  if (new Set(result).size !== result.length) fail()
  return result
}
function message(value: unknown): ProviderMessageV1 {
  const input = record(value)
  exactKeys(input, ['role', 'content'])
  if (input.role !== 'system' && input.role !== 'user' && input.role !== 'assistant') fail()
  return { role: input.role, content: text(input.content, MAX_MESSAGE_BYTES) }
}

export function validateProviderDescriptorV1(value: unknown): ProviderDescriptorV1 {
  const input = record(value)
  exactKeys(input, ['schemaVersion', 'providerId', 'displayName', 'transportClass', 'capabilities'])
  if (input.schemaVersion !== 1 || (input.transportClass !== 'local-loopback' && input.transportClass !== 'cloud')) fail()
  const parsedProviderId = providerId(input.providerId)
  if ((parsedProviderId === 'ollama' || parsedProviderId === 'lmstudio') !== (input.transportClass === 'local-loopback')) fail()
  return { schemaVersion: 1, providerId: parsedProviderId, displayName: text(input.displayName, 256), transportClass: input.transportClass, capabilities: capabilities(input.capabilities) }
}

const PROVIDER_DESCRIPTOR_CATALOG_V1: readonly ProviderDescriptorV1[] = [
  { schemaVersion: 1, providerId: 'ollama', displayName: 'Ollama', transportClass: 'local-loopback', capabilities: ['model.list', 'text.generate', 'usage.reported', 'request.cancel.abort-signal'] },
  { schemaVersion: 1, providerId: 'lmstudio', displayName: 'LM Studio', transportClass: 'local-loopback', capabilities: ['model.list', 'text.generate', 'usage.reported', 'usage.reasoning', 'request.cancel.abort-signal'] },
  { schemaVersion: 1, providerId: 'openai', displayName: 'OpenAI', transportClass: 'cloud', capabilities: ['model.list', 'text.generate', 'usage.reported', 'usage.reasoning', 'request.cancel.abort-signal'] },
  { schemaVersion: 1, providerId: 'claude', displayName: 'Claude', transportClass: 'cloud', capabilities: ['model.list', 'text.generate', 'usage.reported', 'request.cancel.abort-signal'] },
  { schemaVersion: 1, providerId: 'gemini', displayName: 'Gemini', transportClass: 'cloud', capabilities: ['model.list', 'text.generate', 'usage.reported', 'usage.reasoning', 'request.cancel.abort-signal'] },
]

export function listProviderDescriptorsV1(): ProviderDescriptorV1[] {
  return PROVIDER_DESCRIPTOR_CATALOG_V1.map((descriptor) => ({ ...descriptor, capabilities: [...descriptor.capabilities] }))
}

export function validateModelDescriptorV1(value: unknown): ModelDescriptorV1 {
  const input = record(value)
  exactKeys(input, ['schemaVersion', 'providerId', 'modelId', 'displayName', 'capabilities', 'maxOutputTokens', 'status'])
  if (input.schemaVersion !== 1 || (input.status !== 'available' && input.status !== 'unavailable')) fail()
  return {
    schemaVersion: 1,
    providerId: providerId(input.providerId),
    modelId: modelId(input.modelId),
    displayName: input.displayName === null ? null : text(input.displayName, 256),
    capabilities: capabilities(input.capabilities),
    maxOutputTokens: input.maxOutputTokens === null ? null : positiveInteger(input.maxOutputTokens, MAX_OUTPUT_TOKENS),
    status: input.status,
  }
}

export function validateProviderModelListRequestV1(value: unknown): ProviderModelListRequestV1 {
  const input = record(value)
  exactKeys(input, ['schemaVersion', 'requestId', 'providerId'])
  if (input.schemaVersion !== 1) fail()
  return {
    schemaVersion: 1,
    requestId: id(input.requestId),
    providerId: providerId(input.providerId),
  }
}

export function validateProviderModelListOutcomeV1(value: unknown): ProviderModelListOutcomeV1 {
  const input = record(value)
  if (input.schemaVersion !== 1 || typeof input.status !== 'string') fail()
  if (input.status === 'failed') {
    exactKeys(input, ['schemaVersion', 'status', 'requestId', 'code', 'retryable'])
    if (typeof input.retryable !== 'boolean') fail()
    return {
      schemaVersion: 1,
      status: 'failed',
      requestId: id(input.requestId),
      code: failureCode(input.code),
      retryable: input.retryable,
    }
  }
  if (input.status === 'completed') {
    exactKeys(input, ['schemaVersion', 'status', 'requestId', 'providerId', 'models'])
    if (!Array.isArray(input.models) || input.models.length > 256) fail()
    const parsedProviderId = providerId(input.providerId)
    const models = input.models.map(validateModelDescriptorV1)
    if (models.some((model) => model.providerId !== parsedProviderId)
      || new Set(models.map((model) => model.modelId)).size !== models.length) fail()
    return {
      schemaVersion: 1,
      status: 'completed',
      requestId: id(input.requestId),
      providerId: parsedProviderId,
      models,
    }
  }
  fail()
}

export function validateProviderInferenceRequestV1(value: unknown): ProviderInferenceRequestV1 {
  const input = record(value)
  exactKeys(input, ['schemaVersion', 'requestId', 'idempotencyKey', 'providerId', 'modelId', 'messages', 'maxOutputTokens', 'requiredCapabilities'])
  if (input.schemaVersion !== 1 || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGES) fail()
  const messages = input.messages.map(message)
  if (new TextEncoder().encode(JSON.stringify(messages)).byteLength > 128 * 1024) fail()
  const requiredCapabilities = capabilities(input.requiredCapabilities)
  if (!requiredCapabilities.includes('text.generate')) fail()
  return {
    schemaVersion: 1,
    requestId: id(input.requestId),
    idempotencyKey: id(input.idempotencyKey),
    providerId: providerId(input.providerId),
    modelId: modelId(input.modelId),
    messages,
    maxOutputTokens: positiveInteger(input.maxOutputTokens, MAX_OUTPUT_TOKENS),
    requiredCapabilities,
  }
}

export function validateProviderUsageV1(value: unknown): ProviderUsageV1 {
  const input = record(value)
  exactKeys(input, ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'source'])
  if (input.source !== 'reported' && input.source !== 'estimated') fail()
  const inputTokens = nonNegativeInteger(input.inputTokens)
  const outputTokens = nonNegativeInteger(input.outputTokens)
  const reasoningTokens = nonNegativeInteger(input.reasoningTokens)
  const totalTokens = nonNegativeInteger(input.totalTokens)
  if (!Number.isSafeInteger(inputTokens + outputTokens + reasoningTokens) || totalTokens < inputTokens + outputTokens + reasoningTokens) fail()
  if (input.source === 'estimated' && reasoningTokens !== 0) fail()
  return { inputTokens, outputTokens, reasoningTokens, totalTokens, source: input.source }
}

export function validateProviderInferenceOutcomeV1(value: unknown): ProviderInferenceOutcomeV1 {
  const input = record(value)
  if (input.schemaVersion !== 1 || typeof input.status !== 'string') fail()
  if (input.status === 'cancelled') {
    exactKeys(input, ['schemaVersion', 'status', 'requestId'])
    return { schemaVersion: 1, status: 'cancelled', requestId: id(input.requestId) }
  }
  if (input.status === 'failed') {
    exactKeys(input, ['schemaVersion', 'status', 'requestId', 'code', 'retryable'])
    if (typeof input.retryable !== 'boolean') fail()
    return { schemaVersion: 1, status: 'failed', requestId: id(input.requestId), code: failureCode(input.code), retryable: input.retryable }
  }
  if (input.status === 'completed') {
    exactKeys(input, ['schemaVersion', 'status', 'requestId', 'providerId', 'modelId', 'outputText', 'usage'])
    return {
      schemaVersion: 1,
      status: 'completed',
      requestId: id(input.requestId),
      providerId: providerId(input.providerId),
      modelId: modelId(input.modelId),
      outputText: text(input.outputText, 32 * 1024),
      usage: validateProviderUsageV1(input.usage),
    }
  }
  fail()
}

export function supportsProviderCapabilitiesV1(
  available: readonly ProviderCapabilityIdV1[],
  required: readonly ProviderCapabilityIdV1[],
): boolean {
  const availableSet = new Set(capabilities([...available]))
  return capabilities([...required]).every((entry) => availableSet.has(entry))
}
