import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CliVersionManager } from './cli-version-manager.js'
import { TrustedCliCommandResolver } from './cli-command-resolver.js'
import { CliProcessManager } from './cli-process-manager.js'
import { SpawnCliProcessRunner } from './cli-process-runner.js'
import type {
  CliCommandResolver,
  CliDiscoveryStatus,
  CliInferenceRequest,
  CliInferenceResult,
  CliProcessRunner,
  CliProviderAdapter,
  CliProviderId,
  CliVersionStatus,
} from './cli-types.js'

const MAX_PROMPT_BYTES = 32 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const DISCOVERY_TIMEOUT_MS = 5_000
const INFERENCE_TIMEOUT_MS = 60_000

type AdapterDefinition = {
  providerId: CliProviderId
  displayName: string
  command: string
  installCommand: string
  loginArgs: readonly string[] | null
  authenticationArgs: readonly string[] | null
}

const DEFINITIONS: readonly AdapterDefinition[] = [
  { providerId: 'codex', displayName: 'Codex CLI', command: 'codex', installCommand: 'npm install -g @openai/codex', loginArgs: ['login', '--device-auth'], authenticationArgs: ['login', 'status'] },
  { providerId: 'claude', displayName: 'Claude Code CLI', command: 'claude', installCommand: 'npm install -g @anthropic-ai/claude-code', loginArgs: null, authenticationArgs: null },
  { providerId: 'gemini', displayName: 'Gemini CLI', command: 'gemini', installCommand: 'npm install -g @google/gemini-cli', loginArgs: null, authenticationArgs: null },
]

function safeEnvironment(): NodeJS.ProcessEnv {
  const keys = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG']
  return Object.fromEntries(keys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []))
}

function versionFromOutput(value: string): string | null {
  const match = value.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)
  return match?.[0] || null
}

function codeFailure(result: { timedOut: boolean; cancelled: boolean; outputLimitExceeded?: boolean; exitCode: number | null }): string {
  if (result.cancelled) return 'cancelled'
  if (result.timedOut) return 'timed out'
  if (result.outputLimitExceeded) return 'exceeded output limit'
  return result.exitCode === null ? 'unavailable' : 'failed'
}

export class GenericCliAdapter implements CliProviderAdapter {
  public constructor(
    private readonly definition: AdapterDefinition,
    private readonly runner: CliProcessRunner = new SpawnCliProcessRunner(),
    private readonly versions: CliVersionManager = new CliVersionManager(),
    private readonly resolver: CliCommandResolver = new TrustedCliCommandResolver(),
    private readonly processes: CliProcessManager = new CliProcessManager(),
  ) {}

  public get providerId(): CliProviderId { return this.definition.providerId }

  public async discover(): Promise<CliDiscoveryStatus> {
    const resolved = await this.resolver.resolve(this.definition.command)
    if (!resolved.trusted || !resolved.executablePath) {
      return this.status(this.versions.status(this.providerId, null), false, 'unavailable', resolved.detail, null)
    }
    const result = await this.runner.run({
      command: resolved.executablePath,
      args: ['--version'], cwd: os.tmpdir(), env: safeEnvironment(), timeoutMs: DISCOVERY_TIMEOUT_MS, maxOutputBytes: 4_096,
    })
    const installedVersion = result.exitCode === 0 && !result.timedOut && !result.cancelled
      ? versionFromOutput(`${result.stdout}\n${result.stderr}`)
      : null
    const version = this.versions.status(this.providerId, installedVersion)
    if (!installedVersion) return this.status(version, false, 'unavailable', 'Trusted CLI could not be executed.', resolved.installationKind)
    if (!version.supported) return this.status(version, true, 'unsupported_version', 'Installed CLI version is outside the supported matrix.', resolved.installationKind)
    const authentication = await this.authenticationStatus(resolved.executablePath)
    return {
      ...this.status(version, true, authentication === 'not_checked' ? 'authentication_unknown' : 'ready', authentication === 'authenticated' ? 'CLI is installed and authenticated.' : 'CLI is installed; authentication was not confirmed.', resolved.installationKind),
      authentication,
    }
  }

  public async getReadiness(): Promise<CliDiscoveryStatus> { return this.discover() }

  public async beginLogin(): Promise<{ started: boolean; detail: string }> {
    // Device authentication is interactive; a non-TTY agent must never start or alter a user session.
    return { started: false, detail: 'Interactive CLI login is disabled pending a separately approved TTY/device-code flow.' }
  }

  public async listModels(): Promise<string[]> { return [] }

  public async infer(request: CliInferenceRequest): Promise<CliInferenceResult> {
    if (this.providerId !== 'codex') throw new Error('CLI inference is not implemented for this provider')
    if (process.env.XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE !== '1') throw new Error('Codex CLI inference is disabled pending compliance approval')
    if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error('Invalid CLI inference request')
    }
    const lease = this.processes.acquire(this.providerId, request.requestId)
    const abort = () => this.processes.cancel(lease.requestId)
    request.signal?.addEventListener('abort', abort, { once: true })
    let taskDirectory: string | undefined
    try {
      const resolved = await this.resolver.resolve(this.definition.command)
      if (!resolved.trusted || !resolved.executablePath) throw new Error('CLI executable is unavailable or untrusted')
      taskDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-codex-task-'))
      const result = await this.runner.run({
        command: resolved.executablePath,
        args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-C', taskDirectory, '-'],
        cwd: taskDirectory, env: safeEnvironment(), stdin: request.prompt, signal: lease.signal, timeoutMs: INFERENCE_TIMEOUT_MS, maxStdoutBytes: MAX_OUTPUT_BYTES, maxStderrBytes: MAX_OUTPUT_BYTES,
      })
      if (result.cancelled) throw new Error('CLI inference cancelled')
      if (result.timedOut) throw new Error('CLI inference timed out')
      if (result.outputLimitExceeded) throw new Error('CLI inference exceeded output limit')
      if (result.exitCode !== 0) throw new Error('CLI inference failed')
      const parsed = parseCodexJsonl(result.stdout)
      if (!parsed.outputText) throw new Error('CLI inference returned no output')
      return parsed
    } finally {
      request.signal?.removeEventListener('abort', abort)
      lease.release()
      if (taskDirectory) fs.rmSync(taskDirectory, { recursive: true, force: true })
    }
  }

  public cancel(requestId: string): boolean {
    return this.processes.cancel(requestId)
  }

  public async getVersionStatus(): Promise<CliVersionStatus> { return (await this.discover()).version }

  private async authenticationStatus(command: string): Promise<CliDiscoveryStatus['authentication']> {
    if (!this.definition.authenticationArgs) return 'not_checked'
    const result = await this.runner.run({
      command, args: this.definition.authenticationArgs, cwd: os.tmpdir(), env: safeEnvironment(), timeoutMs: DISCOVERY_TIMEOUT_MS, maxOutputBytes: 4_096,
    })
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) return 'not_authenticated'
    return /not logged|not authenticated|logged out/iu.test(`${result.stdout}\n${result.stderr}`) ? 'not_authenticated' : 'authenticated'
  }

  private status(version: CliVersionStatus, executable: boolean, readiness: CliDiscoveryStatus['readiness'], detail: string, installationKind: CliDiscoveryStatus['installationKind']): CliDiscoveryStatus {
    return {
      providerId: this.providerId, displayName: this.definition.displayName, command: this.definition.command,
      installed: executable, executable, installationKind: executable ? installationKind : null,
      authentication: executable ? 'not_checked' : 'unavailable', readiness, version,
      loginCommand: this.definition.loginArgs ? `${this.definition.command} ${this.definition.loginArgs.join(' ')}` : null,
      installCommand: this.definition.installCommand, detail,
    }
  }
}

function parseCodexJsonl(stdout: string): CliInferenceResult {
  let outputText = ''
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const item = JSON.parse(line) as Record<string, unknown>
      if (item.type === 'item.completed' && item.item && typeof item.item === 'object') {
        const message = item.item as Record<string, unknown>
        if (message.type === 'agent_message' && typeof message.text === 'string') outputText = message.text
      }
      if (item.type === 'turn.completed' && item.usage && typeof item.usage === 'object') {
        const usage = item.usage as Record<string, unknown>
        inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null
        outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null
      }
    } catch { /* JSONL may contain harmless CLI notices; they are not surfaced. */ }
  }
  return { outputText, inputTokens, outputTokens }
}

export function createCliAdapters(
  runner?: CliProcessRunner,
  options: { resolver?: CliCommandResolver; processes?: CliProcessManager } = {},
): Map<CliProviderId, CliProviderAdapter> {
  const processes = options.processes || new CliProcessManager()
  return new Map(DEFINITIONS.map((definition) => [definition.providerId, new GenericCliAdapter(definition, runner, undefined, options.resolver, processes)]))
}
