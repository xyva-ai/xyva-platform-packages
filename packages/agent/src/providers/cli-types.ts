export const CLI_PROVIDER_IDS = ['codex', 'claude', 'gemini'] as const
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number]

export type CliAuthenticationStatus = 'not_checked' | 'authenticated' | 'not_authenticated' | 'unavailable'
export type CliUpdateStatus = 'not_checked' | 'current' | 'update_available' | 'unsupported' | 'unknown'

export interface CliVersionStatus {
  installedVersion: string | null
  supported: boolean
  minimumVersion: string | null
  updateStatus: CliUpdateStatus
  updateCommand: string | null
}

export interface CliDiscoveryStatus {
  providerId: CliProviderId
  displayName: string
  command: string
  installed: boolean
  executable: boolean
  installationKind: 'npm-global' | 'path' | 'unknown' | null
  authentication: CliAuthenticationStatus
  readiness: 'ready' | 'not_installed' | 'unsupported_version' | 'authentication_unknown' | 'disabled' | 'unavailable'
  version: CliVersionStatus
  loginCommand: string | null
  installCommand: string
  detail: string
}

export interface CliInferenceRequest {
  prompt: string
  signal?: AbortSignal
}

export interface CliInferenceResult {
  outputText: string
  inputTokens: number | null
  outputTokens: number | null
}

export interface CliProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
}

export interface CliProcessRunner {
  run(input: {
    command: string
    args: readonly string[]
    cwd: string
    env: NodeJS.ProcessEnv
    stdin?: string
    signal?: AbortSignal
    timeoutMs: number
    maxOutputBytes: number
  }): Promise<CliProcessResult>
}

export interface CliProviderAdapter {
  readonly providerId: CliProviderId
  discover(): Promise<CliDiscoveryStatus>
  getReadiness(): Promise<CliDiscoveryStatus>
  beginLogin(): Promise<{ started: boolean; detail: string }>
  listModels(): Promise<string[]>
  infer(request: CliInferenceRequest): Promise<CliInferenceResult>
  cancel(): boolean
  getVersionStatus(): Promise<CliVersionStatus>
}
