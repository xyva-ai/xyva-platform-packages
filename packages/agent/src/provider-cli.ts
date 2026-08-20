import { Buffer } from 'node:buffer'
import { emitKeypressEvents } from 'node:readline'
import type { ReadStream, WriteStream } from 'node:tty'

import { PROVIDER_IDS_V1, type ProviderIdV1 } from '@xyva/contracts'
import type { AgentProviderConfigurationStatus } from '@xyva/bridge-types'

import {
  deleteProviderConfiguration,
  getProviderConfigurationStatusesWithFlowGrants,
  isCloudProvider,
  saveProviderConfiguration,
  setFlowProviderGrant,
  type AgentProviderConfigurationStatusWithFlowGrant,
} from './config.js'
import { AgentAiFacade } from './services/ai-facade.js'

const MAX_API_KEY_BYTES = 16_384
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/u

export interface ProviderCliStore {
  statuses(): AgentProviderConfigurationStatusWithFlowGrant[]
  configure(value: unknown): AgentProviderConfigurationStatus
  delete(providerId: ProviderIdV1): AgentProviderConfigurationStatus
  setFlowGrant(providerId: ProviderIdV1, granted: boolean): AgentProviderConfigurationStatusWithFlowGrant
}

export interface ProviderCliDependencies {
  readSecret(prompt: string): Promise<string>
  store: ProviderCliStore
  verify(providerId: ProviderIdV1, apiKey: string): Promise<boolean>
}

const defaultStore: ProviderCliStore = {
  statuses: getProviderConfigurationStatusesWithFlowGrants,
  configure: saveProviderConfiguration,
  delete: deleteProviderConfiguration,
  setFlowGrant: setFlowProviderGrant,
}

async function verifyCloudCredential(providerId: ProviderIdV1, apiKey: string): Promise<boolean> {
  const result = await new AgentAiFacade({ maxConcurrentRequests: 1, cloudRequestsPerMinute: 1 })
    .listModels({ provider: providerId, key: apiKey })
  return result.ok
}

export function exactProviderId(value: unknown): ProviderIdV1 {
  if (typeof value !== 'string' || !PROVIDER_IDS_V1.includes(value as ProviderIdV1)) {
    throw new Error('Invalid provider configuration')
  }
  return value as ProviderIdV1
}

export function providerStatusesForCli(store: ProviderCliStore = defaultStore): AgentProviderConfigurationStatusWithFlowGrant[] {
  return store.statuses().map((status) => ({ ...status }))
}

export async function configureProviderFromCli(
  input: { providerId: unknown; defaultModel: unknown; replaceKey?: unknown },
  dependencies: ProviderCliDependencies = {
    readSecret: (prompt) => readMaskedSecret(prompt),
    store: defaultStore,
    verify: verifyCloudCredential,
  },
): Promise<AgentProviderConfigurationStatus> {
  const providerId = exactProviderId(input.providerId)
  if (typeof input.defaultModel !== 'string' || !MODEL_ID.test(input.defaultModel)) {
    throw new Error('Invalid provider configuration')
  }
  if (input.replaceKey !== undefined && typeof input.replaceKey !== 'boolean') {
    throw new Error('Invalid provider configuration')
  }
  if (!isCloudProvider(providerId) && input.replaceKey) {
    throw new Error('Invalid provider configuration')
  }

  const status = dependencies.store.statuses().find((entry) => entry.providerId === providerId)
  if (!status) throw new Error('Invalid provider configuration')
  const needsKey = isCloudProvider(providerId) && (!status.keyConfigured || input.replaceKey === true)
  let apiKey: string | undefined
  if (needsKey) {
    const secret = await dependencies.readSecret(`API key for ${providerId}: `)
    if (!secret
      || secret !== secret.trim()
      || /[\u0000-\u001f\u007f-\u009f]/u.test(secret)
      || Buffer.byteLength(secret, 'utf8') > MAX_API_KEY_BYTES) {
      throw new Error('Provider configuration failed')
    }
    apiKey = secret
    if (!await dependencies.verify(providerId, apiKey)) {
      throw new Error('Provider verification failed')
    }
  }

  try {
    return dependencies.store.configure({
      providerId,
      defaultModel: input.defaultModel,
      ...(apiKey ? { apiKey } : {}),
    })
  } catch {
    throw new Error('Provider configuration failed')
  } finally {
    apiKey = undefined
  }
}

export function deleteProviderFromCli(
  providerValue: unknown,
  confirmed: unknown,
  store: ProviderCliStore = defaultStore,
): AgentProviderConfigurationStatus {
  const providerId = exactProviderId(providerValue)
  if (confirmed !== true) throw new Error('Provider deletion requires --yes')
  try {
    return store.delete(providerId)
  } catch {
    throw new Error('Provider deletion failed')
  }
}

export function setFlowProviderGrantFromCli(
  providerValue: unknown,
  grantedValue: unknown,
  confirmed: unknown,
  store: ProviderCliStore = defaultStore,
): AgentProviderConfigurationStatusWithFlowGrant {
  const providerId = exactProviderId(providerValue)
  if (typeof grantedValue !== 'boolean') throw new Error('Invalid provider grant')
  if (confirmed !== true) throw new Error(`Flow provider ${grantedValue ? 'grant' : 'revocation'} requires --yes`)
  try {
    return store.setFlowGrant(providerId, grantedValue)
  } catch {
    throw new Error(`Flow provider ${grantedValue ? 'grant' : 'revocation'} failed`)
  }
}

export async function readMaskedSecret(
  prompt: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Cloud provider configuration requires an interactive terminal')
  }

  emitKeypressEvents(input)
  const previousRawMode = Boolean(input.isRaw)
  const wasPaused = input.isPaused()
  output.write(prompt)
  try {
    input.setRawMode(true)
    input.resume()
  } catch {
    try { input.setRawMode(previousRawMode) } catch { /* best-effort terminal restoration */ }
    throw new Error('Cloud provider configuration requires an interactive terminal')
  }

  return new Promise<string>((resolve, reject) => {
    let secret = ''
    let settled = false

    const cleanup = () => {
      input.off('keypress', onKeypress)
      input.off('end', onEnd)
      input.off('error', onError)
      process.off('SIGTERM', onSignal)
      process.off('SIGHUP', onSignal)
      try { input.setRawMode(previousRawMode) } catch { /* best-effort terminal restoration */ }
      if (wasPaused) input.pause()
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      try { output.write('\n') } finally { cleanup() }
      if (error) reject(error)
      else resolve(secret)
    }
    const onEnd = () => finish(new Error('Provider configuration cancelled'))
    const onError = () => finish(new Error('Provider configuration cancelled'))
    const onSignal = () => finish(new Error('Provider configuration cancelled'))
    const onKeypress = (value: string | undefined, key: { ctrl?: boolean; meta?: boolean; name?: string } = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        finish(new Error('Provider configuration cancelled'))
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish()
        return
      }
      if (key.name === 'backspace') {
        if (secret.length > 0) secret = secret.slice(0, -1)
        return
      }
      if (!value || key.ctrl || key.meta || /[\r\n]/u.test(value)) return
      const next = `${secret}${value}`
      if (Buffer.byteLength(next, 'utf8') > MAX_API_KEY_BYTES) {
        finish(new Error('Provider configuration failed'))
        return
      }
      secret = next
    }

    input.on('keypress', onKeypress)
    input.once('end', onEnd)
    input.once('error', onError)
    process.once('SIGTERM', onSignal)
    process.once('SIGHUP', onSignal)
  })
}
