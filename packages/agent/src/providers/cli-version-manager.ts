import type { CliProviderId, CliVersionStatus } from './cli-types.js'

export interface CliCompatibilityEntry {
  minimumVersion: string | null
  updateCommand: string | null
}

/**
 * The matrix is deliberately local and conservative. It records the minimum
 * version accepted by XYVA, not a remote "latest" claim. Remote update checks
 * and mutation belong to a later, consented update workflow.
 */
export const DEFAULT_CLI_COMPATIBILITY_MATRIX: Readonly<Record<CliProviderId, CliCompatibilityEntry>> = {
  codex: { minimumVersion: '0.162.0', updateCommand: 'npm install -g @openai/codex' },
  claude: { minimumVersion: null, updateCommand: 'npm install -g @anthropic-ai/claude-code' },
  gemini: { minimumVersion: '0.64.0', updateCommand: 'npm install -g @google/gemini-cli' },
}

function parseVersion(value: string): number[] | null {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/u)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
}

function atLeast(installed: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (installed[index]! > minimum[index]!) return true
    if (installed[index]! < minimum[index]!) return false
  }
  return true
}

export class CliVersionManager {
  public constructor(private readonly matrix: Readonly<Record<CliProviderId, CliCompatibilityEntry>> = DEFAULT_CLI_COMPATIBILITY_MATRIX) {}

  public status(providerId: CliProviderId, installedVersion: string | null): CliVersionStatus {
    const entry = this.matrix[providerId]
    const parsedInstalled = installedVersion ? parseVersion(installedVersion) : null
    const parsedMinimum = entry.minimumVersion ? parseVersion(entry.minimumVersion) : null
    const supported = Boolean(parsedInstalled) && (!parsedMinimum || atLeast(parsedInstalled!, parsedMinimum))
    return {
      installedVersion,
      supported,
      minimumVersion: entry.minimumVersion,
      updateStatus: !installedVersion ? 'not_checked' : supported ? 'unknown' : 'unsupported',
      updateCommand: entry.updateCommand,
    }
  }
}
