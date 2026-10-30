// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { clearCredentials, loadCredentials, saveCredentials } from '../../packages/agent/src/auth.js'
import { loadConfig, saveConfig } from '../../packages/agent/src/config.js'
import { readPrivateFile, SecureStoreError, writePrivateFile } from '../../packages/agent/src/secure-store.js'

const temporaryDirectories: string[] = []
const previousStateDirectory = process.env.XYVA_AGENT_STATE_DIR

function isolatedState(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-agent-windows-store-'))
  temporaryDirectories.push(parent)
  const state = path.join(parent, 'state')
  process.env.XYVA_AGENT_STATE_DIR = state
  return state
}

afterEach(() => {
  process.env.XYVA_AGENT_STATE_DIR = previousStateDirectory
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe.runIf(process.platform === 'win32' && process.arch === 'x64')('Windows native secure-store integration', () => {
  it('uses the packaged native backend for sealed credentials and atomic updates', () => {
    const state = isolatedState()
    const first = { token: 'synthetic-token-one', email: 'one@example.test', expiresAt: Date.now() + 60_000, portalUrl: 'https://xyva.ai' }
    const second = { ...first, token: 'synthetic-token-two', email: 'two@example.test' }

    saveCredentials(first)
    saveCredentials(second)

    expect(loadCredentials()).toEqual(second)
    expect(readPrivateFile(path.join(state, 'credentials.json'))).not.toContain(first.token)
    expect(readPrivateFile(path.join(state, 'credentials.json'))).not.toContain(second.token)
    expect(readPrivateFile(path.join(state, 'secret-store.key'))).toMatch(/^[A-Za-z0-9_-]{43}$/)

    clearCredentials()
    expect(loadCredentials()).toBeNull()
  })

  it('preserves sealed:v1 compatibility across a restart-style reload', () => {
    const state = isolatedState()
    saveConfig({
      aiProvider: 'openai',
      aiApiKeys: { openai: 'synthetic-api-key' },
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: [],
      gitlabToken: 'synthetic-gitlab-token',
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })

    const raw = readPrivateFile(path.join(state, 'config.json'))!
    expect(raw).toContain('sealed:v1:')
    expect(raw).not.toContain('synthetic-api-key')
    expect(raw).not.toContain('synthetic-gitlab-token')
    expect(loadConfig()).toMatchObject({ aiApiKeys: { openai: 'synthetic-api-key' }, gitlabToken: 'synthetic-gitlab-token' })
  })

  it('never replaces a missing master key when sealed configuration exists', () => {
    const state = isolatedState()
    saveConfig({
      aiProvider: 'openai',
      aiApiKeys: { openai: 'synthetic-api-key' },
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: [],
      gitlabToken: null,
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })
    const keyPath = path.join(state, 'secret-store.key')
    const configPath = path.join(state, 'config.json')
    const before = fs.readFileSync(configPath, 'utf8')
    fs.rmSync(keyPath)

    expect(() => loadConfig()).toThrow(/key is missing/i)
    expect(fs.existsSync(keyPath)).toBe(false)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('rejects unsafe native leaf names without creating a stream', () => {
    const state = isolatedState()
    expect(() => writePrivateFile(path.join(state, 'unsafe:stream'), 'synthetic')).toThrow(/INVALID_INPUT|private/i)
    expect(fs.existsSync(path.join(state, 'unsafe:stream'))).toBe(false)
  })

  it('fails closed when an existing private root has an invalid ACL', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-agent-windows-root-'))
    temporaryDirectories.push(parent)
    const unsafeState = path.join(parent, 'existing-state')
    fs.mkdirSync(unsafeState)
    process.env.XYVA_AGENT_STATE_DIR = unsafeState

    expect(() => writePrivateFile(path.join(unsafeState, 'config.json'), 'synthetic')).toThrow(/INSECURE_ROOT|native secure-store/i)
  })
})
