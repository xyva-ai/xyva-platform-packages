// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  deleteProviderConfiguration,
  getConfigSummary,
  getProviderConfigurationStatuses,
  getProviderConfigurationStatusesWithFlowGrants,
  loadConfig,
  resolveProviderRuntime,
  saveProviderConfiguration,
  setFlowProviderGrant,
} from '../../packages/agent/src/config.js'

const stateDirectories: string[] = []
const previousStateDirectory = process.env.XYVA_AGENT_STATE_DIR

function useIsolatedState(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-config-'))
  stateDirectories.push(directory)
  process.env.XYVA_AGENT_STATE_DIR = directory
  return directory
}

afterEach(() => {
  process.env.XYVA_AGENT_STATE_DIR = previousStateDirectory
  for (const directory of stateDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('agent provider configuration', () => {
  it('starts without a provider bias and reports readiness only for a complete selection', () => {
    useIsolatedState()
    expect(loadConfig().aiProvider).toBeNull()
    expect(getConfigSummary()).toMatchObject({ aiProvider: null, aiConfigured: false })
    saveProviderConfiguration({ providerId: 'ollama', defaultModel: 'gemma3:4b' })
    expect(getConfigSummary()).toMatchObject({ aiProvider: 'ollama', aiConfigured: true })
  })

  it('canonicalizes cloud aliases, seals keys and never exposes them in status', () => {
    const directory = useIsolatedState()
    const status = saveProviderConfiguration({ providerId: 'openai', defaultModel: 'gpt-5', apiKey: 'openai-secret' })
    expect(status).toMatchObject({ providerId: 'openai', defaultModel: 'gpt-5', keyConfigured: true, transport: 'cloud' })
    expect(status.selected).toBe(true)
    expect(resolveProviderRuntime('codex')).toEqual({ providerId: 'openai', model: 'gpt-5', key: 'openai-secret' })
    expect(JSON.stringify(getProviderConfigurationStatuses())).not.toContain('openai-secret')
    expect(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).not.toContain('openai-secret')
    expect(getConfigSummary().aiConfigured).toBe(true)
  })

  it('never stores keys for loopback providers and deletes cloud credentials on request', () => {
    useIsolatedState()
    expect(() => saveProviderConfiguration({ providerId: 'ollama', apiKey: 'must-not-store' })).toThrow(/invalid/i)
    saveProviderConfiguration({ providerId: 'gemini', defaultModel: 'gemini-2.5-flash', apiKey: 'gemini-secret' })
    const deleted = deleteProviderConfiguration('gemini')
    expect(deleted).toMatchObject({ providerId: 'gemini', selected: false, defaultModel: null, keyConfigured: false })
    expect(loadConfig().aiApiKeys.gemini).toBeUndefined()
    expect(loadConfig().aiProvider).toBeNull()
  })

  it('rejects extra fields at the untrusted provider configuration boundary', () => {
    useIsolatedState()
    expect(() => saveProviderConfiguration({
      providerId: 'openai',
      defaultModel: 'gpt-5',
      apiKey: 'secret',
      baseUrl: 'https://attacker.invalid',
    })).toThrow(/invalid/i)
    expect(loadConfig().aiApiKeys.openai).toBeUndefined()
    expect(resolveProviderRuntime('not-a-provider')).toBeNull()
  })

  it('keeps Flow denied by default and grants only complete canonical providers explicitly', () => {
    useIsolatedState()
    expect(getProviderConfigurationStatusesWithFlowGrants().every((status) => status.flowGranted === false)).toBe(true)
    expect(() => setFlowProviderGrant('ollama', true)).toThrow(/configured before/i)
    expect(() => setFlowProviderGrant('anthropic', true)).toThrow(/invalid provider grant/i)

    saveProviderConfiguration({ providerId: 'ollama', defaultModel: 'gemma3:4b' })
    expect(getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === 'ollama'))
      .toMatchObject({ flowGranted: false })
    expect(setFlowProviderGrant('ollama', true)).toMatchObject({ flowGranted: true })
    expect(setFlowProviderGrant('ollama', false)).toMatchObject({ flowGranted: false })

    saveProviderConfiguration({ providerId: 'openai', defaultModel: 'gpt-5' })
    expect(() => setFlowProviderGrant('openai', true)).toThrow(/configured before/i)
    saveProviderConfiguration({ providerId: 'openai', apiKey: 'openai-secret' })
    expect(setFlowProviderGrant('openai', true)).toMatchObject({ flowGranted: true, keyConfigured: true })
    saveProviderConfiguration({ providerId: 'openai', defaultModel: 'gpt-5.1' })
    expect(getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === 'openai'))
      .toMatchObject({ flowGranted: true, defaultModel: 'gpt-5.1' })
    saveProviderConfiguration({ providerId: 'openai', apiKey: 'replacement-secret' })
    expect(getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === 'openai'))
      .toMatchObject({ flowGranted: false, keyConfigured: true })
  })

  it('atomically clears Flow consent when a provider is deleted and never revives it on reconfigure', () => {
    useIsolatedState()
    saveProviderConfiguration({ providerId: 'gemini', defaultModel: 'gemini-2.5-flash', apiKey: 'gemini-secret' })
    setFlowProviderGrant('gemini', true)
    expect(deleteProviderConfiguration('gemini')).toMatchObject({ keyConfigured: false })
    expect(getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === 'gemini'))
      .toMatchObject({ flowGranted: false, keyConfigured: false })
    saveProviderConfiguration({ providerId: 'gemini', defaultModel: 'gemini-2.5-flash', apiKey: 'replacement-secret' })
    expect(getProviderConfigurationStatusesWithFlowGrants().find((status) => status.providerId === 'gemini'))
      .toMatchObject({ flowGranted: false, keyConfigured: true })
  })

  it('refuses every provider mutation without changing malformed stored configuration', () => {
    const directory = useIsolatedState()
    const configPath = path.join(directory, 'config.json')
    const malformed = JSON.stringify({
      aiProvider: 'openai',
      aiApiKeys: {},
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: ['anthropic'],
      gitlabToken: null,
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })
    fs.writeFileSync(configPath, malformed, { mode: 0o600 })

    expect(() => saveProviderConfiguration({ providerId: 'ollama', defaultModel: 'gemma3:4b' })).toThrow(/refusing to overwrite/i)
    expect(() => setFlowProviderGrant('openai', true)).toThrow(/refusing to overwrite/i)
    expect(() => setFlowProviderGrant('openai', false)).toThrow(/refusing to overwrite/i)
    expect(() => deleteProviderConfiguration('openai')).toThrow(/refusing to overwrite/i)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(malformed)
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  })
})
