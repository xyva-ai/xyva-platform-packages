/** Transport-safe contract for the separately authorized local CLI gateway. */

/**
 * Official CLIs that the transport can describe. Listing a provider here is
 * not an execution grant: calls still need product capability, a local grant,
 * and the explicit test-mode gate.
 */
export const CLI_PROVIDER_IDS_V1 = ['codex', 'claude', 'gemini'] as const
export type CliProviderIdV1 = (typeof CLI_PROVIDER_IDS_V1)[number]
export const CLI_EXECUTION_MODES_V1 = ['read_only'] as const
export type CliExecutionModeV1 = (typeof CLI_EXECUTION_MODES_V1)[number]
export const CLI_FAILURE_CODES_V1 = [
  'invalid_request', 'unsupported_provider', 'product_not_authorized',
  'feature_disabled', 'cli_not_installed', 'cli_not_authenticated',
  'provider_unavailable', 'process_start_failed', 'timeout', 'cancelled',
  'busy', 'conflict', 'adapter_error',
] as const
export type CliFailureCodeV1 = (typeof CLI_FAILURE_CODES_V1)[number]

export interface ProviderCliCapabilitiesRequestV1 { schemaVersion: 1; requestId: string }
export interface ProviderCliCapabilityV1 {
  schemaVersion: 1
  providerId: CliProviderIdV1
  installed: boolean
  authenticated: boolean | null
  enabled: boolean
  modes: CliExecutionModeV1[]
}
export type ProviderCliCapabilitiesOutcomeV1 =
  | { schemaVersion: 1; status: 'completed'; requestId: string; capabilities: ProviderCliCapabilityV1[] }
  | { schemaVersion: 1; status: 'failed'; requestId: string; code: CliFailureCodeV1; retryable: boolean }

export interface ProviderCliInferenceRequestV1 {
  schemaVersion: 1
  requestId: string
  providerId: CliProviderIdV1
  mode: CliExecutionModeV1
  prompt: string
}
export type ProviderCliInferenceOutcomeV1 =
  | { schemaVersion: 1; status: 'completed'; requestId: string; providerId: CliProviderIdV1; outputText: string; inputTokens: number | null; outputTokens: number | null }
  | { schemaVersion: 1; status: 'cancelled'; requestId: string }
  | { schemaVersion: 1; status: 'failed'; requestId: string; code: CliFailureCodeV1; retryable: boolean }

export interface ProviderCliCancellationRequestV1 { schemaVersion: 1; requestId: string }
export type ProviderCliCancellationOutcomeV1 =
  | { schemaVersion: 1; status: 'completed'; requestId: string; cancellationRequested: true }
  | { schemaVersion: 1; status: 'failed'; requestId: string; code: 'invalid_request' | 'product_not_authorized' | 'conflict'; retryable: false }

export class ProviderCliContractValidationError extends Error {
  public constructor() { super('Invalid provider CLI contract'); this.name = 'ProviderCliContractValidationError' }
}

type RecordValue = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_PROMPT_BYTES = 32 * 1024
function fail(): never { throw new ProviderCliContractValidationError() }
function record(value: unknown): RecordValue { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(); return value as RecordValue }
function exact(value: RecordValue, keys: readonly string[]): void { const actual = Object.keys(value).sort(); const wanted = [...keys].sort(); if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) fail() }
function requestId(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail(); return value }
function schema(value: unknown): 1 { if (value !== 1) fail(); return 1 }
function provider(value: unknown): CliProviderIdV1 { if (typeof value !== 'string' || !CLI_PROVIDER_IDS_V1.includes(value as CliProviderIdV1)) fail(); return value as CliProviderIdV1 }
function mode(value: unknown): CliExecutionModeV1 { if (typeof value !== 'string' || !CLI_EXECUTION_MODES_V1.includes(value as CliExecutionModeV1)) fail(); return value as CliExecutionModeV1 }
function prompt(value: unknown): string { if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > MAX_PROMPT_BYTES) fail(); return value }

export function validateProviderCliCapabilitiesRequestV1(value: unknown): ProviderCliCapabilitiesRequestV1 { const input = record(value); exact(input, ['schemaVersion', 'requestId']); return { schemaVersion: schema(input.schemaVersion), requestId: requestId(input.requestId) } }
export function validateProviderCliInferenceRequestV1(value: unknown): ProviderCliInferenceRequestV1 { const input = record(value); exact(input, ['schemaVersion', 'requestId', 'providerId', 'mode', 'prompt']); return { schemaVersion: schema(input.schemaVersion), requestId: requestId(input.requestId), providerId: provider(input.providerId), mode: mode(input.mode), prompt: prompt(input.prompt) } }
export function validateProviderCliCancellationRequestV1(value: unknown): ProviderCliCancellationRequestV1 { const input = record(value); exact(input, ['schemaVersion', 'requestId']); return { schemaVersion: schema(input.schemaVersion), requestId: requestId(input.requestId) } }

function failureCode(value: unknown): CliFailureCodeV1 { if (typeof value !== 'string' || !CLI_FAILURE_CODES_V1.includes(value as CliFailureCodeV1)) fail(); return value as CliFailureCodeV1 }
function nullableTokens(value: unknown): number | null { if (value === null) return null; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); return value }
function outcomeText(value: unknown): string { if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 256 * 1024) fail(); return value }

export function validateProviderCliInferenceOutcomeV1(value: unknown): ProviderCliInferenceOutcomeV1 {
  const input = record(value); schema(input.schemaVersion); const status = input.status
  if (status === 'completed') { exact(input, ['schemaVersion', 'status', 'requestId', 'providerId', 'outputText', 'inputTokens', 'outputTokens']); return { schemaVersion: 1, status, requestId: requestId(input.requestId), providerId: provider(input.providerId), outputText: outcomeText(input.outputText), inputTokens: nullableTokens(input.inputTokens), outputTokens: nullableTokens(input.outputTokens) } }
  if (status === 'cancelled') { exact(input, ['schemaVersion', 'status', 'requestId']); return { schemaVersion: 1, status, requestId: requestId(input.requestId) } }
  if (status === 'failed') { exact(input, ['schemaVersion', 'status', 'requestId', 'code', 'retryable']); if (typeof input.retryable !== 'boolean') fail(); return { schemaVersion: 1, status, requestId: requestId(input.requestId), code: failureCode(input.code), retryable: input.retryable } }
  fail()
}

export function validateProviderCliCapabilitiesOutcomeV1(value: unknown): ProviderCliCapabilitiesOutcomeV1 {
  const input = record(value); schema(input.schemaVersion)
  if (input.status === 'failed') { exact(input, ['schemaVersion', 'status', 'requestId', 'code', 'retryable']); if (typeof input.retryable !== 'boolean') fail(); return { schemaVersion: 1, status: 'failed', requestId: requestId(input.requestId), code: failureCode(input.code), retryable: input.retryable } }
  if (input.status !== 'completed') fail(); exact(input, ['schemaVersion', 'status', 'requestId', 'capabilities']); if (!Array.isArray(input.capabilities)) fail()
  const capabilities = input.capabilities.map((value) => { const item = record(value); exact(item, ['schemaVersion', 'providerId', 'installed', 'authenticated', 'enabled', 'modes']); if (schema(item.schemaVersion) !== 1 || typeof item.installed !== 'boolean' || (item.authenticated !== null && typeof item.authenticated !== 'boolean') || typeof item.enabled !== 'boolean' || !Array.isArray(item.modes) || item.modes.some((candidate) => !CLI_EXECUTION_MODES_V1.includes(candidate as CliExecutionModeV1))) fail(); return { schemaVersion: 1 as const, providerId: provider(item.providerId), installed: item.installed, authenticated: item.authenticated, enabled: item.enabled, modes: [...item.modes] as CliExecutionModeV1[] } })
  return { schemaVersion: 1, status: 'completed', requestId: requestId(input.requestId), capabilities }
}

export function validateProviderCliCancellationOutcomeV1(value: unknown): ProviderCliCancellationOutcomeV1 {
  const input = record(value); schema(input.schemaVersion)
  if (input.status === 'completed') { exact(input, ['schemaVersion', 'status', 'requestId', 'cancellationRequested']); if (input.cancellationRequested !== true) fail(); return { schemaVersion: 1, status: 'completed', requestId: requestId(input.requestId), cancellationRequested: true } }
  if (input.status === 'failed') { exact(input, ['schemaVersion', 'status', 'requestId', 'code', 'retryable']); if ((input.code !== 'invalid_request' && input.code !== 'product_not_authorized' && input.code !== 'conflict') || input.retryable !== false) fail(); return { schemaVersion: 1, status: 'failed', requestId: requestId(input.requestId), code: input.code, retryable: false } }
  fail()
}
