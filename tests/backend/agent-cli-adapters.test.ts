// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createCliAdapters } from '../../packages/agent/src/providers/cli-adapters.js'
import { TrustedCliCommandResolver } from '../../packages/agent/src/providers/cli-command-resolver.js'
import { CliProcessManager } from '../../packages/agent/src/providers/cli-process-manager.js'
import { SpawnCliProcessRunner } from '../../packages/agent/src/providers/cli-process-runner.js'
import { CliAdapterRegistry } from '../../packages/agent/src/providers/cli-registry.js'
import type { CliCommandResolver, CliProcessRunner } from '../../packages/agent/src/providers/cli-types.js'

const originalTestMode = process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE
const originalProviderTestMode = process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_TEST_MODE

afterEach(() => {
  if (originalTestMode === undefined) delete process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE
  else process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = originalTestMode
  if (originalProviderTestMode === undefined) delete process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_TEST_MODE
  else process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_TEST_MODE = originalProviderTestMode
})

function fakeRunner(handler: (input: Parameters<CliProcessRunner['run']>[0]) => Awaited<ReturnType<CliProcessRunner['run']>>): CliProcessRunner {
  return { run: handler }
}

const trustedResolver: CliCommandResolver = {
  async resolve(command) { return { command, executablePath: command, installationKind: 'npm-global', trusted: true, detail: 'test fixture' } },
}

function adapters(runner: CliProcessRunner, processes = new CliProcessManager()) {
  return createCliAdapters(runner, { resolver: trustedResolver, processes })
}

function readyDiscoveryResult(input: Parameters<CliProcessRunner['run']>[0]) {
  if (input.args.length === 1 && input.args[0] === '--version') {
    return { exitCode: 0, stdout: input.command === 'claude' ? 'claude 2.1.259' : 'codex-cli 0.162.1', stderr: '', timedOut: false, cancelled: false }
  }
  if (input.args.join(' ') === 'login status' || input.args.join(' ') === 'auth status --json') {
    return { exitCode: 0, stdout: 'logged in', stderr: '', timedOut: false, cancelled: false }
  }
  return null
}

async function waitForRecordedPid(pidFile: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch { /* The parent process has not recorded its child yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for child PID at ${pidFile}`)
}

async function expectProcessToStop(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Process ${pid} remained alive after cleanup deadline`)
}

describe('official CLI adapter discovery', () => {
  it('discovers each supported CLI without prompts, model calls, or credential reads', async () => {
    const calls: Parameters<CliProcessRunner['run']>[0][] = []
    const adapterMap = adapters(fakeRunner(async (input) => {
      calls.push(input)
      if (input.command === 'codex' && input.args.join(' ') === '--version') return { exitCode: 0, stdout: 'codex-cli 0.162.1', stderr: '', timedOut: false, cancelled: false }
      if (input.command === 'codex') return { exitCode: 0, stdout: 'Logged in', stderr: '', timedOut: false, cancelled: false }
      if (input.command === 'gemini') return { exitCode: 0, stdout: '0.64.0', stderr: '', timedOut: false, cancelled: false }
      return { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false, cancelled: false }
    }))

    const status = await new CliAdapterRegistry(adapterMap).status()
    expect(status).toMatchObject([
      { providerId: 'codex', installed: true, executable: true, version: { installedVersion: '0.162.1', supported: true }, authentication: 'authenticated' },
      { providerId: 'claude', installed: false, readiness: 'unavailable' },
      { providerId: 'gemini', installed: true, executable: true, version: { installedVersion: '0.64.0', supported: true } },
    ])
    expect(calls.every((call) => call.args.join(' ') === '--version' || call.args.join(' ') === 'login status')).toBe(true)
    expect(calls.every((call) => call.stdin === undefined)).toBe(true)
  })

  it('marks an unreadable or obsolete version unsupported without exposing stderr', async () => {
    const adapter = adapters(fakeRunner(async () => ({
      exitCode: 0, stdout: 'codex-cli dev-build', stderr: 'sensitive-session-value', timedOut: false, cancelled: false,
    }))).get('codex')!
    const status = await adapter.discover()
    expect(status.version.supported).toBe(false)
    expect(JSON.stringify(status)).not.toContain('sensitive-session-value')
  })
})

describe('Codex CLI pilot execution policy', () => {
  it('rejects every inference until the explicit internal test-mode gate is enabled', async () => {
    delete process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE
    const adapter = adapters(fakeRunner(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false }))).get('codex')!
    await expect(adapter.infer({ prompt: 'hello' })).rejects.toThrow('disabled pending compliance approval')
  })

  it('uses fixed, shell-free Codex arguments, stdin prompt input, a disposable directory and read-only sandbox', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    let observed: Parameters<CliProcessRunner['run']>[0] | undefined
    const adapter = adapters(fakeRunner(async (input) => {
      const discovery = readyDiscoveryResult(input)
      if (discovery) return discovery
      observed = input
      return {
        exitCode: 0,
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}\n',
        stderr: 'never surface this', timedOut: false, cancelled: false,
      }
    })).get('codex')!
    await expect(adapter.infer({ requestId: 'safe-request', prompt: '$(do-not-execute) --dangerously-bypass-approvals-and-sandbox' })).resolves.toEqual({ outputText: 'OK', inputTokens: 2, outputTokens: 1 })
    expect(observed).toBeDefined()
    expect(observed!.args).toEqual(['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-C', observed!.cwd, '-'])
    expect(observed!.stdin).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(observed!.stdin).not.toBe(observed!.args.join(' '))
    expect(observed!.env).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('propagates cancellation to the process runner and normalizes the error', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    const controller = new AbortController()
    const adapter = adapters(fakeRunner(async (input) => {
      const discovery = readyDiscoveryResult(input)
      if (discovery) return discovery
      controller.abort()
      expect(input.signal?.aborted).toBe(true)
      return { exitCode: 1, stdout: '', stderr: 'sensitive', timedOut: false, cancelled: true }
    })).get('codex')!
    await expect(adapter.infer({ requestId: 'cancel-request', prompt: 'cancel', signal: controller.signal })).rejects.toThrow('CLI inference cancelled')
  })

  it('never starts provider execution when cancellation arrives during discovery', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    let releaseVersion: (() => void) | undefined
    let discoveryStarted: (() => void) | undefined
    let executionCalled = false
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve })
    const adapter = adapters(fakeRunner(async (input) => {
      if (input.args.join(' ') === '--version') {
        discoveryStarted!()
        await new Promise<void>((resolve) => { releaseVersion = resolve })
        return { exitCode: 0, stdout: 'codex-cli 0.162.1', stderr: '', timedOut: false, cancelled: false }
      }
      if (input.args.join(' ') === 'login status') return { exitCode: 0, stdout: 'logged in', stderr: '', timedOut: false, cancelled: false }
      executionCalled = true
      return { exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"unexpected"}}', stderr: '', timedOut: false, cancelled: false }
    })).get('codex')!
    const pending = adapter.infer({ requestId: 'cancel-during-discovery', prompt: 'synthetic' })
    await started
    expect(adapter.cancel('cancel-during-discovery')).toBe(true)
    releaseVersion!()
    await expect(pending).rejects.toThrow('CLI inference cancelled')
    expect(executionCalled).toBe(false)
  })
})

describe('provider-specific official CLI execution profiles', () => {
  it('runs Claude only behind the explicit local test gate with fixed no-tool arguments and an isolated home', async () => {
    process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_TEST_MODE = '1'
    let observed: Parameters<CliProcessRunner['run']>[0] | undefined
    const adapter = adapters(fakeRunner(async (input) => {
      const discovery = readyDiscoveryResult(input)
      if (discovery) return discovery
      observed = input
      return { exitCode: 0, stdout: JSON.stringify({ result: 'Claude OK', usage: { input_tokens: 2, output_tokens: 1 } }), stderr: 'never surface this', timedOut: false, cancelled: false }
    })).get('claude')!
    await expect(adapter.infer({ requestId: 'claude-safe-request', prompt: '$(do-not-execute) never put this in argv' })).resolves.toEqual({ outputText: 'Claude OK', inputTokens: 2, outputTokens: 1 })
    expect(observed).toBeDefined()
    expect(observed!.args).toEqual(['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--disallowedTools', 'mcp__*', '--restricted', '--permission-prompts', 'none'])
    expect(observed!.stdin).toContain('never put this in argv')
    expect(observed!.args.join(' ')).not.toContain('never put this in argv')
    expect(observed!.env.HOME).toBe(observed!.cwd)
    expect(observed!.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('keeps Gemini task execution fail-closed even when the generic local test gate is set', async () => {
    process.env.XYVA_AGENT_ENABLE_PROVIDER_CLI_TEST_MODE = '1'
    let called = false
    const adapter = adapters(fakeRunner(async () => { called = true; return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false } })).get('gemini')!
    await expect(adapter.infer({ requestId: 'gemini-denied', prompt: 'synthetic' })).rejects.toThrow('disabled pending sandbox and compliance approval')
    expect(called).toBe(false)
  })

  it('reports a documented Claude login-status failure as login_required without reflecting diagnostics', async () => {
    const adapter = adapters(fakeRunner(async (input) => input.args[0] === '--version'
      ? { exitCode: 0, stdout: 'claude 2.1.259', stderr: '', timedOut: false, cancelled: false }
      : { exitCode: 1, stdout: '', stderr: 'credential=/private/value', timedOut: false, cancelled: false }
    )).get('claude')!
    const status = await adapter.discover()
    expect(status).toMatchObject({ authentication: 'not_authenticated', readiness: 'login_required' })
    expect(JSON.stringify(status)).not.toContain('/private/value')
  })
})

describe('trusted command and request lifecycle policy', () => {
  it('rejects PATH hijacking from a temporary directory before the runner is called', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xyva-cli-hijack-'))
    try {
      const fake = path.join(temporary, 'codex')
      await fs.writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const resolver = new TrustedCliCommandResolver({ env: { PATH: temporary }, cwd: process.cwd(), homeDir: os.homedir(), platform: process.platform })
      const resolution = await resolver.resolve('codex')
      expect(resolution.trusted).toBe(false)
      let called = false
      const adapter = createCliAdapters(fakeRunner(async () => { called = true; return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false } }), { resolver }).get('codex')!
      await expect(adapter.infer({ requestId: 'hijack-request', prompt: 'safe' })).rejects.toThrow('unavailable or untrusted')
      expect(called).toBe(false)
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'win32')('rejects a PATH-prepended npm .cmd launcher instead of falling back to a shell', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xyva-cli-cmd-'))
    try {
      await fs.writeFile(path.join(temporary, 'codex.cmd'), '@echo off\r\necho unsafe\r\n')
      const resolver = new TrustedCliCommandResolver({ env: { PATH: temporary }, cwd: process.cwd(), homeDir: os.homedir(), platform: 'win32' })
      const resolution = await resolver.resolve('codex')
      expect(resolution.trusted).toBe(false)
      expect(resolution.executablePath).toBeNull()
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  })

  it('cancels only the addressed request and cleans up completed leases', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    const manager = new CliProcessManager(2, 2)
    const adapter = adapters(fakeRunner(async (input) => {
      const discovery = readyDiscoveryResult(input)
      if (discovery) return discovery
      return await new Promise((resolve) => {
      if (input.signal?.aborted) { resolve({ exitCode: 1, stdout: '', stderr: 'never expose', timedOut: false, cancelled: true }); return }
      input.signal?.addEventListener('abort', () => resolve({ exitCode: 1, stdout: '', stderr: 'never expose', timedOut: false, cancelled: true }), { once: true })
      if (input.stdin === 'second') setTimeout(() => resolve({ exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}', stderr: '', timedOut: false, cancelled: false }), 5)
      })
    }), manager).get('codex')!
    const first = adapter.infer({ requestId: 'request-one', prompt: 'first' })
    const second = adapter.infer({ requestId: 'request-two', prompt: 'second' })
    expect(adapter.cancel('request-one')).toBe(true)
    expect(adapter.cancel('request-one')).toBe(false)
    await expect(first).rejects.toThrow('cancelled')
    await expect(second).resolves.toMatchObject({ outputText: 'second' })
    expect(manager.hasActiveRequests()).toBe(false)
  })

  it('returns busy without queueing when the provider limit is reached and releases after a crash', async () => {
    process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE = '1'
    let release: (() => void) | undefined
    const manager = new CliProcessManager(1, 2)
    const adapter = adapters(fakeRunner(async (input) => {
      const discovery = readyDiscoveryResult(input)
      if (discovery) return discovery
      return await new Promise((resolve) => { release = () => resolve({ exitCode: 37, stdout: '', stderr: 'secret', timedOut: false, cancelled: false }) })
    }), manager).get('codex')!
    const first = adapter.infer({ requestId: 'crash-one', prompt: 'first' })
    await expect(adapter.infer({ requestId: 'crash-two', prompt: 'second' })).rejects.toThrow('busy')
    release!()
    await expect(first).rejects.toThrow('failed')
    expect(manager.hasActiveRequests('codex')).toBe(false)
  })
})

describe('spawn process boundary', () => {
  it('terminates a timed-out child without invoking a shell', async () => {
    const result = await new SpawnCliProcessRunner().run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 20, maxOutputBytes: 1024,
    })
    expect(result.timedOut).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('terminates the POSIX process group created by a timed-out parent', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xyva-cli-process-group-'))
    try {
      const pidFile = path.join(temporary, 'child.pid')
      const childCode = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)']); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 10000);`
      const result = await new SpawnCliProcessRunner().run({
        command: process.execPath, args: ['-e', childCode], cwd: temporary, env: { PATH: process.env.PATH }, timeoutMs: 250, maxOutputBytes: 1024,
      })
      expect(result.timedOut).toBe(true)
      const pid = await waitForRecordedPid(pidFile)
      await expectProcessToStop(pid)
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'win32')('terminates a Windows parent and its test child through taskkill', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xyva-cli-process-tree-'))
    try {
      const pidFile = path.join(temporary, 'child.pid')
      const childCode = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)']); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 10000);`
      const result = await new SpawnCliProcessRunner().run({
        command: process.execPath, args: ['-e', childCode], cwd: temporary, env: { PATH: process.env.PATH }, timeoutMs: 250, maxOutputBytes: 1024,
      })
      expect(result.timedOut).toBe(true)
      const pid = await waitForRecordedPid(pidFile)
      await expectProcessToStop(pid)
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  })

  it('terminates a child when stdout or stderr exceeds its independent limit', async () => {
    const result = await new SpawnCliProcessRunner().run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(4096)); process.stderr.write("b".repeat(4096)); setTimeout(() => {}, 5000)'],
      cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 2_000, maxStdoutBytes: 128, maxStderrBytes: 128,
    })
    expect(result.outputLimitExceeded).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128)
  })
})
