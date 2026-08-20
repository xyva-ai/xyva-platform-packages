// @vitest-environment node

import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureProviderFromCli,
  deleteProviderFromCli,
  readMaskedSecret,
  setFlowProviderGrantFromCli,
  type ProviderCliStore,
} from '../../packages/agent/src/provider-cli.js'

const repoRoot = path.resolve(__dirname, '..', '..')
const agentDist = path.join(repoRoot, 'packages', 'agent', 'dist', 'cli.js')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function providerStatus(providerId: 'ollama' | 'lmstudio' | 'openai' | 'claude' | 'gemini', keyConfigured = false) {
  return {
    providerId,
    selected: false,
    defaultModel: null,
    keyConfigured,
    transport: providerId === 'ollama' || providerId === 'lmstudio' ? 'local-loopback' as const : 'cloud' as const,
    flowGranted: false,
  }
}

describe('agent provider CLI orchestration', () => {
  it('prompts for a new cloud key without accepting it as an input field', async () => {
    const configure = vi.fn((value: unknown) => ({
      ...providerStatus('openai', true),
      selected: true,
      defaultModel: 'gpt-5',
    }))
    const store: ProviderCliStore = {
      statuses: () => [providerStatus('openai')],
      configure,
      delete: vi.fn(),
      setFlowGrant: vi.fn(),
    }
    const readSecret = vi.fn().mockResolvedValue('cloud-secret-value')
    const verify = vi.fn().mockResolvedValue(true)

    const result = await configureProviderFromCli({
      providerId: 'openai',
      defaultModel: 'gpt-5',
    }, { readSecret, store, verify })

    expect(readSecret).toHaveBeenCalledWith('API key for openai: ')
    expect(verify).toHaveBeenCalledWith('openai', 'cloud-secret-value')
    expect(configure).toHaveBeenCalledWith({
      providerId: 'openai',
      defaultModel: 'gpt-5',
      apiKey: 'cloud-secret-value',
    })
    expect(JSON.stringify(result)).not.toContain('cloud-secret-value')
  })

  it('keeps local providers keyless and preserves an existing cloud key unless replacement is explicit', async () => {
    const configure = vi.fn((value: unknown) => {
      const input = value as { providerId: 'ollama' | 'gemini'; defaultModel: string }
      return { ...providerStatus(input.providerId, input.providerId === 'gemini'), selected: true, defaultModel: input.defaultModel }
    })
    const store: ProviderCliStore = {
      statuses: () => [providerStatus('ollama'), providerStatus('gemini', true)],
      configure,
      delete: vi.fn(),
      setFlowGrant: vi.fn(),
    }
    const readSecret = vi.fn().mockRejectedValue(new Error('must not be called'))
    const verify = vi.fn().mockRejectedValue(new Error('must not be called'))

    await configureProviderFromCli({ providerId: 'ollama', defaultModel: 'gemma3:4b' }, { readSecret, store, verify })
    await configureProviderFromCli({ providerId: 'gemini', defaultModel: 'gemini-2.5-flash' }, { readSecret, store, verify })

    expect(readSecret).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(configure).toHaveBeenNthCalledWith(1, { providerId: 'ollama', defaultModel: 'gemma3:4b' })
    expect(configure).toHaveBeenNthCalledWith(2, { providerId: 'gemini', defaultModel: 'gemini-2.5-flash' })
    await expect(configureProviderFromCli({
      providerId: 'ollama',
      defaultModel: 'gemma3:4b',
      replaceKey: true,
    }, { readSecret, store, verify })).rejects.toThrow('Invalid provider configuration')
  })

  it('does not persist whitespace-padded or unverified cloud credentials', async () => {
    const configure = vi.fn()
    const store: ProviderCliStore = {
      statuses: () => [providerStatus('claude')],
      configure,
      delete: vi.fn(),
      setFlowGrant: vi.fn(),
    }
    const verify = vi.fn().mockResolvedValue(false)

    await expect(configureProviderFromCli({ providerId: 'claude', defaultModel: 'claude-sonnet' }, {
      readSecret: vi.fn().mockResolvedValue(' padded-secret '),
      store,
      verify,
    })).rejects.toThrow('Provider configuration failed')
    expect(verify).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()

    await expect(configureProviderFromCli({ providerId: 'claude', defaultModel: 'claude-sonnet' }, {
      readSecret: vi.fn().mockResolvedValue('unverified-secret'),
      store,
      verify,
    })).rejects.toThrow('Provider verification failed')
    expect(verify).toHaveBeenCalledWith('claude', 'unverified-secret')
    expect(configure).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation before deleting an exact canonical provider', () => {
    const deleteConfiguration = vi.fn(() => providerStatus('claude'))
    const store: ProviderCliStore = {
      statuses: () => [providerStatus('claude', true)],
      configure: vi.fn(),
      delete: deleteConfiguration,
      setFlowGrant: vi.fn(),
    }
    expect(() => deleteProviderFromCli('anthropic', true, store)).toThrow('Invalid provider configuration')
    expect(() => deleteProviderFromCli('claude', false, store)).toThrow('requires --yes')
    expect(deleteProviderFromCli('claude', true, store)).toMatchObject({ providerId: 'claude', keyConfigured: false })
    expect(deleteConfiguration).toHaveBeenCalledOnce()
  })

  it('requires exact provider, product-owner confirmation and a separate Flow grant mutation', () => {
    const setFlowGrant = vi.fn((providerId: 'ollama', granted: boolean) => ({
      ...providerStatus(providerId),
      defaultModel: 'gemma3:4b',
      flowGranted: granted,
    }))
    const store: ProviderCliStore = {
      statuses: () => [providerStatus('ollama')],
      configure: vi.fn(),
      delete: vi.fn(),
      setFlowGrant,
    }

    expect(() => setFlowProviderGrantFromCli('anthropic', true, true, store)).toThrow('Invalid provider configuration')
    expect(() => setFlowProviderGrantFromCli('ollama', true, false, store)).toThrow('requires --yes')
    expect(setFlowProviderGrantFromCli('ollama', true, true, store)).toMatchObject({ flowGranted: true })
    expect(setFlowProviderGrantFromCli('ollama', false, true, store)).toMatchObject({ flowGranted: false })
    expect(setFlowGrant).toHaveBeenNthCalledWith(1, 'ollama', true)
    expect(setFlowGrant).toHaveBeenNthCalledWith(2, 'ollama', false)
  })
})

describe('masked provider secret reader', () => {
  it('requires a TTY, hides every character and restores raw mode', async () => {
    const nonTtyInput = new PassThrough() as unknown as ReadStream
    const nonTtyOutput = new PassThrough() as unknown as WriteStream
    await expect(readMaskedSecret('API key: ', nonTtyInput, nonTtyOutput))
      .rejects.toThrow('interactive terminal')

    const input = new PassThrough() as PassThrough & ReadStream
    const output = new PassThrough() as PassThrough & WriteStream
    let raw = false
    Object.defineProperties(input, {
      isTTY: { value: true },
      isRaw: { get: () => raw },
      setRawMode: { value: vi.fn((value: boolean) => { raw = value }) },
    })
    Object.defineProperty(output, 'isTTY', { value: true })
    let rendered = ''
    output.on('data', (chunk) => { rendered += chunk.toString() })

    const pending = readMaskedSecret('API key: ', input, output)
    input.write('s3cret\n')
    await expect(pending).resolves.toBe('s3cret')
    expect(rendered).toBe('API key: \n')
    expect(rendered).not.toContain('s3cret')
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(raw).toBe(false)
  })
})

describe('provider CLI process boundary', () => {
  it('configures local models, reports only safe status and rejects secret-bearing argv', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-provider-cli-'))
    temporaryDirectories.push(stateDirectory)
    const env = { XYVA_AGENT_STATE_DIR: stateDirectory }

    const configured = await runAgent(['provider', 'configure', 'ollama', '--model', 'gemma3:4b'], env)
    expect(configured.code).toBe(0)
    expect(configured.output).toContain('Configured ollama.')

    const status = await runAgent(['provider', 'status', '--json'], env)
    expect(status.code).toBe(0)
    const parsed = JSON.parse(status.output)
    expect(parsed).toHaveLength(5)
    expect(parsed.find((entry: { providerId: string }) => entry.providerId === 'ollama')).toMatchObject({
      selected: true,
      defaultModel: 'gemma3:4b',
      keyConfigured: false,
      transport: 'local-loopback',
      flowGranted: false,
    })
    expect(status.output).not.toMatch(/apiKey|secret|token/iu)

    const secret = 'must-never-enter-agent-state'
    const rejected = await runAgent([
      'provider', 'configure', 'openai', '--model', 'gpt-5', '--api-key', secret,
    ], env)
    expect(rejected.code).toBe(1)
    expect(rejected.output).not.toContain(secret)
    const rawConfig = fs.readFileSync(path.join(stateDirectory, 'config.json'), 'utf8')
    expect(rawConfig).not.toContain(secret)

    const granted = await runAgent(['provider', 'grant', 'ollama', '--product', 'flow', '--yes'], env)
    expect(granted.code).toBe(0)
    const grantedStatus = JSON.parse((await runAgent(['provider', 'status', '--json'], env)).output)
    expect(grantedStatus.find((entry: { providerId: string }) => entry.providerId === 'ollama'))
      .toMatchObject({ flowGranted: true })
    const revoked = await runAgent(['provider', 'revoke', 'ollama', '--product', 'flow', '--yes'], env)
    expect(revoked.code).toBe(0)

    const noConfirmation = await runAgent(['provider', 'delete', 'ollama'], env)
    expect(noConfirmation.code).toBe(1)
    const deleted = await runAgent(['provider', 'delete', 'ollama', '--yes'], env)
    expect(deleted.code).toBe(0)
  })
})

function runAgent(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [agentDist, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
}
