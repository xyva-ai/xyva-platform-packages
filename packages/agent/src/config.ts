import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  AgentConfigSummary,
  AgentConfigUpdate,
  AgentProviderConfigurationSaveRequest,
  AgentProviderConfigurationStatus,
} from '@xyva/bridge-types'
import { PROVIDER_IDS_V1, type ProviderIdV1 } from '@xyva/contracts'

import { getXyvaDir } from './auth.js'
import { isSealedSecret, sealSecret, unsealSecret, writePrivateFile } from './secure-store.js'

export interface AgentConfig {
  aiProvider: ProviderIdV1 | null
  aiApiKeys: Record<string, string>
  aiDefaultModels: Partial<Record<ProviderIdV1, string>>
  flowProviderGrants: ProviderIdV1[]
  gitlabToken: string | null
  githubToken: string | null
  youtrackToken: string | null
  port: number
}

type StoredAgentConfig = {
  aiProvider: ProviderIdV1 | null
  aiApiKeys: Record<string, string>
  aiDefaultModels: Partial<Record<ProviderIdV1, string>>
  flowProviderGrants: ProviderIdV1[]
  gitlabToken: string | null
  githubToken: string | null
  youtrackToken: string | null
  port: number
}

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  aiProvider: null,
  aiApiKeys: {},
  aiDefaultModels: {},
  flowProviderGrants: [],
  gitlabToken: null,
  githubToken: null,
  youtrackToken: null,
  port: 7900,
}

function defaultAgentConfig(): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, aiApiKeys: {}, aiDefaultModels: {}, flowProviderGrants: [] }
}

function getConfigPath() {
  return path.join(getXyvaDir(), 'config.json')
}

function configSecretContext(field: string) {
  return `agent-config:${field}`
}

const CLOUD_PROVIDERS = new Set<ProviderIdV1>(['openai', 'claude', 'gemini'])
const PROVIDER_ALIASES: Record<string, ProviderIdV1> = {
  codex: 'openai', openai: 'openai', anthropic: 'claude', claude: 'claude', google: 'gemini', gemini: 'gemini', ollama: 'ollama', lmstudio: 'lmstudio',
}

export type AgentProviderConfigurationStatusWithFlowGrant = AgentProviderConfigurationStatus & {
  flowGranted: boolean
}

export function canonicalProviderId(value: unknown): ProviderIdV1 | null {
  return typeof value === 'string' ? PROVIDER_ALIASES[value.trim().toLowerCase()] || null : null
}

export function isCloudProvider(providerId: ProviderIdV1): boolean {
  return CLOUD_PROVIDERS.has(providerId)
}

function validModel(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/u.test(value) ? value : null
}

function normalizeDefaultModels(value: unknown): Partial<Record<ProviderIdV1, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Partial<Record<ProviderIdV1, string>> = {}
  for (const [provider, model] of Object.entries(value as Record<string, unknown>)) {
    const canonical = canonicalProviderId(provider)
    const normalizedModel = validModel(model)
    if (canonical && normalizedModel) result[canonical] = normalizedModel
  }
  return result
}

function normalizeApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [provider, key] of Object.entries(value as Record<string, unknown>)) {
    const canonical = canonicalProviderId(provider)
    if (canonical && isCloudProvider(canonical) && typeof key === 'string' && key.trim()) result[canonical] = key.trim()
  }
  return result
}

function normalizeProviderGrants(value: unknown): ProviderIdV1[] {
  if (!Array.isArray(value)) return []
  return PROVIDER_IDS_V1.filter((providerId) => value.includes(providerId))
}

function encryptValue(value: string, field: string) {
  return sealSecret(value, configSecretContext(field))
}

function decryptLegacyValue(value: string) {
  const parts = value.slice(4).split('.')
  if (parts.length !== 3) {
    return null
  }

  try {
    const keyMaterial = `${os.hostname()}::${os.userInfo().username}`
    const salt = crypto.createHash('sha256').update(keyMaterial).digest()
    const key = crypto.pbkdf2Sync(keyMaterial, salt, 120_000, 32, 'sha256')
    const [iv, tag, encrypted] = parts
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

function decryptValue(value: string, field: string) {
  if (!isSealedSecret(value)) {
    return value.startsWith('aes:') ? decryptLegacyValue(value) : value
  }

  return unsealSecret(value, configSecretContext(field))
}

function toStoredConfig(config: AgentConfig): StoredAgentConfig {
  return {
    aiProvider: config.aiProvider,
    aiApiKeys: Object.fromEntries(
      Object.entries(normalizeApiKeys(config.aiApiKeys)).map(([provider, value]) => [provider, encryptValue(value, `ai:${provider}`)]),
    ),
    aiDefaultModels: normalizeDefaultModels(config.aiDefaultModels),
    flowProviderGrants: normalizeProviderGrants(config.flowProviderGrants),
    gitlabToken: config.gitlabToken ? encryptValue(config.gitlabToken, 'gitlab') : null,
    githubToken: config.githubToken ? encryptValue(config.githubToken, 'github') : null,
    youtrackToken: config.youtrackToken ? encryptValue(config.youtrackToken, 'youtrack') : null,
    port: Number.isFinite(config.port) ? Math.max(1, Math.min(65535, Math.trunc(config.port))) : 7900,
  }
}

function fromStoredConfig(config: Partial<StoredAgentConfig> | null | undefined): AgentConfig {
  return {
    aiProvider: config?.aiProvider === null
      ? null
      : canonicalProviderId(config?.aiProvider) || DEFAULT_AGENT_CONFIG.aiProvider,
    aiApiKeys: normalizeApiKeys(config?.aiApiKeys && typeof config.aiApiKeys === 'object'
      ? Object.fromEntries(Object.entries(config.aiApiKeys).flatMap(([provider, value]) => {
        const canonical = canonicalProviderId(provider)
        if (!canonical || !isCloudProvider(canonical) || typeof value !== 'string') return []
        const decrypted = decryptValue(value, `ai:${provider}`)
          || (provider === canonical ? null : decryptValue(value, `ai:${canonical}`))
        return decrypted ? [[canonical, decrypted]] : []
      }))
      : {}),
    aiDefaultModels: normalizeDefaultModels(config?.aiDefaultModels),
    flowProviderGrants: normalizeProviderGrants(config?.flowProviderGrants),
    gitlabToken: typeof config?.gitlabToken === 'string' ? decryptValue(config.gitlabToken, 'gitlab') : null,
    githubToken: typeof config?.githubToken === 'string' ? decryptValue(config.githubToken, 'github') : null,
    youtrackToken: typeof config?.youtrackToken === 'string' ? decryptValue(config.youtrackToken, 'youtrack') : null,
    port:
      typeof config?.port === 'number' && Number.isFinite(config.port)
        ? Math.max(1, Math.min(65535, Math.trunc(config.port)))
        : DEFAULT_AGENT_CONFIG.port,
  }
}

export function loadConfig(): AgentConfig {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) {
      return defaultAgentConfig()
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<StoredAgentConfig>
    const config = fromStoredConfig(parsed)
    const containsLegacySecrets = [
      ...Object.values(parsed.aiApiKeys || {}),
      parsed.gitlabToken,
      parsed.githubToken,
      parsed.youtrackToken,
    ].some((value) => typeof value === 'string' && !isSealedSecret(value))

    const containsNonCanonicalProviderKeys = Object.keys(parsed.aiApiKeys || {})
      .some((provider) => canonicalProviderId(provider) !== provider)

    if (containsLegacySecrets || containsNonCanonicalProviderKeys) {
      writePrivateFile(configPath, JSON.stringify(toStoredConfig(config), null, 2))
    } else {
      try {
        fs.chmodSync(configPath, 0o600)
      } catch {
        // Best-effort on platforms where POSIX modes are not available.
      }
    }

    return config
  } catch {
    return defaultAgentConfig()
  }
}

function loadConfigForMutation(): AgentConfig {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) return defaultAgentConfig()

  let parsed: Partial<StoredAgentConfig>
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('invalid')
    }
    parsed = value as Partial<StoredAgentConfig>
    if (parsed.aiProvider !== undefined && parsed.aiProvider !== null && !canonicalProviderId(parsed.aiProvider)) throw new Error('invalid')
    if (parsed.port !== undefined && (typeof parsed.port !== 'number' || !Number.isFinite(parsed.port))) throw new Error('invalid')
    if (parsed.aiDefaultModels !== undefined) {
      if (!parsed.aiDefaultModels || typeof parsed.aiDefaultModels !== 'object' || Array.isArray(parsed.aiDefaultModels)) throw new Error('invalid')
      for (const [provider, model] of Object.entries(parsed.aiDefaultModels)) {
        if (canonicalProviderId(provider) !== provider || !validModel(model)) throw new Error('invalid')
      }
    }
    if (parsed.aiApiKeys !== undefined) {
      if (!parsed.aiApiKeys || typeof parsed.aiApiKeys !== 'object' || Array.isArray(parsed.aiApiKeys)) throw new Error('invalid')
      for (const [provider, value] of Object.entries(parsed.aiApiKeys)) {
        if (canonicalProviderId(provider) !== provider || !isCloudProvider(provider as ProviderIdV1)
          || typeof value !== 'string' || !value || decryptValue(value, `ai:${provider}`) === null) throw new Error('invalid')
      }
    }
    if (parsed.flowProviderGrants !== undefined) {
      if (!Array.isArray(parsed.flowProviderGrants)
        || parsed.flowProviderGrants.some((provider) => typeof provider !== 'string'
          || !PROVIDER_IDS_V1.includes(provider as ProviderIdV1))
        || new Set(parsed.flowProviderGrants).size !== parsed.flowProviderGrants.length) throw new Error('invalid')
    }
    for (const [field, value] of [
      ['gitlab', parsed.gitlabToken],
      ['github', parsed.githubToken],
      ['youtrack', parsed.youtrackToken],
    ] as const) {
      if (value !== undefined && value !== null
        && (typeof value !== 'string' || decryptValue(value, field) === null)) throw new Error('invalid')
    }
  } catch {
    throw new Error('Stored agent configuration is unreadable; refusing to overwrite it')
  }
  return fromStoredConfig(parsed)
}

export function saveConfig(config: AgentConfig): AgentConfig {
  writePrivateFile(getConfigPath(), JSON.stringify(toStoredConfig(config), null, 2))
  return loadConfig()
}

export function getConfigValue(key: keyof AgentConfig) {
  return loadConfig()[key]
}

export function setConfigValue(key: keyof AgentConfig, value: AgentConfig[keyof AgentConfig]) {
  const config = loadConfig()
  return saveConfig({
    ...config,
    [key]: value,
  })
}

export function updateConfig(update: AgentConfigUpdate): AgentConfig {
  const current = loadConfig()
  return saveConfig({
    ...current,
    aiProvider:
      update.aiProvider === null
        ? null
        : canonicalProviderId(update.aiProvider)
          ? canonicalProviderId(update.aiProvider)
        : current.aiProvider,
    port:
      typeof update.port === 'number' && Number.isFinite(update.port)
        ? Math.max(1, Math.min(65535, Math.trunc(update.port)))
        : current.port,
  })
}

export function getProviderConfigurationStatuses(): AgentProviderConfigurationStatus[] {
  const config = loadConfig()
  return PROVIDER_IDS_V1.map((providerId) => ({
    providerId,
    selected: config.aiProvider === providerId,
    defaultModel: config.aiDefaultModels[providerId] || null,
    keyConfigured: isCloudProvider(providerId) && Boolean(config.aiApiKeys[providerId]),
    transport: isCloudProvider(providerId) ? 'cloud' : 'local-loopback',
  }))
}

export function getProviderConfigurationStatusesWithFlowGrants(): AgentProviderConfigurationStatusWithFlowGrant[] {
  const config = loadConfig()
  return getProviderConfigurationStatuses().map((status) => ({
    ...status,
    flowGranted: config.flowProviderGrants.includes(status.providerId),
  }))
}

export function isProviderGrantedToFlow(providerId: ProviderIdV1): boolean {
  return loadConfig().flowProviderGrants.includes(providerId)
}

export function setFlowProviderGrant(providerIdValue: unknown, grantedValue: unknown): AgentProviderConfigurationStatusWithFlowGrant {
  const providerId = typeof providerIdValue === 'string' && PROVIDER_IDS_V1.includes(providerIdValue as ProviderIdV1)
    ? providerIdValue as ProviderIdV1
    : null
  if (!providerId || typeof grantedValue !== 'boolean') throw new Error('Invalid provider grant')
  const current = loadConfigForMutation()
  if (grantedValue) {
    const configured = Boolean(current.aiDefaultModels[providerId])
      && (!isCloudProvider(providerId) || Boolean(current.aiApiKeys[providerId]))
    if (!configured) throw new Error('Provider must be configured before it can be granted to Flow')
  }
  const grants = new Set(current.flowProviderGrants)
  if (grantedValue) grants.add(providerId)
  else grants.delete(providerId)
  saveConfig({ ...current, flowProviderGrants: PROVIDER_IDS_V1.filter((candidate) => grants.has(candidate)) })
  return getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === providerId)!
}

function parseProviderConfigurationSaveRequest(value: unknown): AgentProviderConfigurationSaveRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Invalid provider configuration')
  }
  const input = value as Record<string, unknown>
  const allowedKeys = new Set(['providerId', 'defaultModel', 'apiKey'])
  if (!Object.hasOwn(input, 'providerId') || Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('Invalid provider configuration')
  }
  const providerId = typeof input.providerId === 'string' && PROVIDER_IDS_V1.includes(input.providerId as ProviderIdV1)
    ? input.providerId as ProviderIdV1
    : null
  if (!providerId) throw new Error('Invalid provider configuration')
  if (input.defaultModel !== undefined && input.defaultModel !== null && !validModel(input.defaultModel)) {
    throw new Error('Invalid provider configuration')
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    throw new Error('Invalid provider configuration')
  }
  return {
    providerId,
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel as string | null } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey as string | null } : {}),
  }
}

export function saveProviderConfiguration(requestValue: unknown): AgentProviderConfigurationStatus {
  const request = parseProviderConfigurationSaveRequest(requestValue)
  const { providerId } = request
  const current = loadConfigForMutation()
  const nextKeys = { ...current.aiApiKeys }
  const nextModels = { ...current.aiDefaultModels }
  let nextFlowProviderGrants = [...current.flowProviderGrants]
  if (request.defaultModel !== undefined) {
    if (request.defaultModel === null) delete nextModels[providerId]
    else {
      const model = validModel(request.defaultModel)
      if (!model) throw new Error('Invalid provider configuration')
      nextModels[providerId] = model
    }
  }
  if (isCloudProvider(providerId)) {
    if (request.apiKey !== undefined) {
      nextFlowProviderGrants = nextFlowProviderGrants.filter((candidate) => candidate !== providerId)
    }
    if (request.apiKey === null) delete nextKeys[providerId]
    else if (request.apiKey !== undefined) {
      if (typeof request.apiKey !== 'string' || !request.apiKey.trim() || request.apiKey.length > 16_384) throw new Error('Invalid provider configuration')
      nextKeys[providerId] = request.apiKey.trim()
    }
  } else {
    if (request.apiKey !== undefined && request.apiKey !== null) throw new Error('Invalid provider configuration')
    delete nextKeys[providerId]
  }
  saveConfig({
    ...current,
    aiProvider: providerId,
    aiApiKeys: nextKeys,
    aiDefaultModels: nextModels,
    flowProviderGrants: nextFlowProviderGrants,
  })
  return getProviderConfigurationStatuses().find((status) => status.providerId === providerId)!
}

export function deleteProviderConfiguration(providerIdValue: unknown): AgentProviderConfigurationStatus {
  const providerId = canonicalProviderId(providerIdValue)
  if (!providerId) throw new Error('Invalid provider configuration')
  const current = loadConfigForMutation()
  const nextKeys = { ...current.aiApiKeys }
  const nextModels = { ...current.aiDefaultModels }
  const nextFlowProviderGrants = current.flowProviderGrants.filter((candidate) => candidate !== providerId)
  delete nextKeys[providerId]
  delete nextModels[providerId]
  saveConfig({
    ...current,
    aiProvider: current.aiProvider === providerId ? null : current.aiProvider,
    aiApiKeys: nextKeys,
    aiDefaultModels: nextModels,
    flowProviderGrants: nextFlowProviderGrants,
  })
  return getProviderConfigurationStatuses().find((status) => status.providerId === providerId)!
}

export function resolveProviderConnection(providerValue: unknown): { providerId: ProviderIdV1; key?: string } | null {
  const config = loadConfig()
  const providerId = providerValue === undefined || providerValue === null
    ? config.aiProvider
    : canonicalProviderId(providerValue)
  if (!providerId) return null
  const key = config.aiApiKeys[providerId]
  if (isCloudProvider(providerId) && !key) return null
  return { providerId, ...(key ? { key } : {}) }
}

export function resolveProviderRuntime(providerValue: unknown): { providerId: ProviderIdV1; model: string; key?: string } | null {
  const connection = resolveProviderConnection(providerValue)
  if (!connection) return null
  const model = loadConfig().aiDefaultModels[connection.providerId]
  return model ? { ...connection, model } : null
}

export function getConfigSummary(): AgentConfigSummary {
  const config = loadConfig()
  const selectedProvider = config.aiProvider
  const selectedModel = selectedProvider ? config.aiDefaultModels[selectedProvider] : null
  const selectedCredentialReady = selectedProvider
    ? !isCloudProvider(selectedProvider) || Boolean(config.aiApiKeys[selectedProvider])
    : false
  return {
    aiProvider: config.aiProvider,
    aiConfigured: Boolean(selectedProvider && selectedModel && selectedCredentialReady),
    integrations: {
      gitlab: Boolean(config.gitlabToken),
      github: Boolean(config.githubToken),
      youtrack: Boolean(config.youtrackToken),
    },
    port: config.port,
  }
}
