import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { RunnerCallbacks, RunnerRunRequest, RunnerStartResult } from '@xyva/bridge-types'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getNpxInvocation, getRuntimeEnv, normalizePath } from '../utils/platform.js'

type PlaywrightConfigResolution = {
  path: string
  source: 'project' | 'workspace'
}

type EnvFileCandidate = {
  envName: string | null
  fullPath: string
}

export interface RunnerWorkspaceInfo {
  root: string
}

export interface RunnerWorkspaceResolver {
  resolve(projectPath: string): Promise<RunnerWorkspaceInfo>
}

export interface AgentRunnerServiceOptions {
  workspaceResolver?: RunnerWorkspaceResolver
}

const RUNNER_INVALID_CONFIGURATION_EXIT_CODE = 2
const SAFE_ENVIRONMENT_NAMES = ['qa', 'dev', 'qaApi', 'devApi', 'test', 'local']
const SAFE_RUN_MODES = new Set(['all', 'file', 'name'])
const SAFE_TRACE_MODES = new Set(['on', 'off', 'retain-on-failure', 'retain-on-first-failure'])
const DANGEROUS_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'COMSPEC', 'SHELL', 'HOME',
  'USERPROFILE', 'INIT_CWD', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG',
  'BASH_ENV', 'ENV', 'IFS', 'CDPATH', 'PYTHONPATH',
])

function isDangerousEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return DANGEROUS_ENV_KEYS.has(upper)
    || upper.startsWith('NPM_')
    || upper.startsWith('LD_')
    || upper.startsWith('DYLD_')
}

function isSafeTestName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && !/[\r\n\0]/.test(value)
}

function sanitizeRequestedEnvOverrides(input: unknown, allowedNames: string[]): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const allowed = new Set(allowedNames)
  const result: Record<string, string> = {}

  for (const [key, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || isDangerousEnvKey(key) || !allowed.has(key)) continue
    if (typeof rawValue !== 'string' || !rawValue.trim() || rawValue.length > 16_384 || rawValue.includes('\0')) continue
    result[key] = rawValue
  }
  return result
}

export const runnerSecurityInternals = {
  isDangerousEnvKey,
  isSafeTestName,
  sanitizeRequestedEnvOverrides,
}

export class AgentRunnerService {
  private currentProcess: ChildProcessWithoutNullStreams | null = null
  private currentCallbacks: RunnerCallbacks | null = null
  private readonly workspaceResolver?: RunnerWorkspaceResolver

  constructor(options: AgentRunnerServiceOptions = {}) {
    this.workspaceResolver = options.workspaceResolver
  }

  async runTests(req: RunnerRunRequest, callbacks: RunnerCallbacks = {}): Promise<RunnerStartResult> {
    if (this.currentProcess) {
      callbacks.onLog?.('A run is already in progress.')
      return { ok: false, error: 'A run is already in progress.' }
    }

    this.currentCallbacks = callbacks

    const {
      projectPath,
      workspacePath,
      projectType,
      runMode,
      testFile,
      testFiles,
      testName,
      headless,
      debug,
      parallel,
      browser,
      trace,
      resolvedData,
      requiredEnvVars,
      envOverrides,
      environment,
      runtimeEnvironment,
    } = req

    if (!SecurityGuard.isApprovedProjectRoot(projectPath)) {
      callbacks.onLog?.('CRITICAL ERROR: Unauthorized project path')
      callbacks.onFinished?.(1)
      this.currentCallbacks = null
      return { ok: false, error: 'Unauthorized project path' }
    }

    const canonicalProjectPath = SecurityGuard.canonicalizePath(projectPath)
    if (projectType !== 'playwright') {
      return this.blockInvalidConfiguration(callbacks, 'Unsupported test engine')
    }
    if (!SAFE_RUN_MODES.has(String(runMode))) {
      return this.blockInvalidConfiguration(callbacks, 'Invalid Playwright run mode.')
    }
    if (typeof headless !== 'boolean' || typeof debug !== 'boolean') {
      return this.blockInvalidConfiguration(callbacks, 'Headless and debug flags must be boolean values.')
    }
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) {
      return this.blockInvalidConfiguration(callbacks, 'Worker count must be an integer between 1 and 32.')
    }
    if (trace != null && !SAFE_TRACE_MODES.has(String(trace))) {
      return this.blockInvalidConfiguration(callbacks, 'Invalid Playwright trace mode.')
    }
    if (browser != null && (!/^[A-Za-z0-9._-]{1,64}$/.test(String(browser)))) {
      return this.blockInvalidConfiguration(callbacks, 'Invalid Playwright browser project name.')
    }
    if (testName != null && !isSafeTestName(testName)) {
      return this.blockInvalidConfiguration(callbacks, 'Invalid Playwright test name filter.')
    }
    const requestedEnvironmentInput = runtimeEnvironment || environment
    const normalizedRequestedEnvironment = this.normalizeEnvironmentName(requestedEnvironmentInput)
    if (String(requestedEnvironmentInput || '').trim() && !normalizedRequestedEnvironment) {
      return this.blockInvalidConfiguration(callbacks, 'Unknown runtime environment.')
    }

    const target = runMode === 'all' ? 'Full Suite' : runMode === 'file' ? testFile || 'Selected files' : testName || 'Named test'
    callbacks.onLog?.(`Running: ${target}`)
    callbacks.onLog?.(`Mode: ${headless ? 'Headless' : 'Headed'} | ${parallel} worker${parallel > 1 ? 's' : ''}`)

    let effectiveWorkspacePath = typeof workspacePath === 'string' && workspacePath.trim() && SecurityGuard.isPathSafe(workspacePath)
      ? workspacePath
      : null

    if (!effectiveWorkspacePath && this.workspaceResolver) {
      try {
        const workspaceInfo = await this.workspaceResolver.resolve(projectPath)
        if (workspaceInfo.root && SecurityGuard.isPathSafe(workspaceInfo.root)) {
          effectiveWorkspacePath = workspaceInfo.root
        }
      } catch {
        // workspace resolution is optional in foundation mode
      }
    }

    const env: Record<string, string> = getRuntimeEnv({ FORCE_COLOR: '1' })
    env.XYVA_PROJECT_PATH = canonicalProjectPath
    if (effectiveWorkspacePath) {
      env.XYVA_WORKSPACE_PATH = effectiveWorkspacePath
    }

    if (resolvedData && typeof resolvedData === 'object' && !Array.isArray(resolvedData)) {
      try {
        const serializedTestData = JSON.stringify(resolvedData)
        if (serializedTestData.length > 262_144 || serializedTestData.includes('\0')) {
          return this.blockInvalidConfiguration(callbacks, 'Resolved test data exceeds the safe runtime limit.')
        }
        env.XYVA_TEST_DATA = serializedTestData
        callbacks.onLog?.(`INFO: Test data context attached (${Object.keys(resolvedData).length} keys)`)
      } catch {
        callbacks.onLog?.('WARN: Failed to attach test data context')
      }
    }

    let args: string[] = []

    if (projectType === 'playwright') {
      const configResolution = this.resolvePlaywrightConfig(canonicalProjectPath, effectiveWorkspacePath)
      const configPath = configResolution?.path || null
      args = ['playwright', 'test']

      const rawSelectedFiles = Array.isArray(testFiles)
        ? testFiles.filter((file): file is string => typeof file === 'string' && !!String(file).trim())
        : []
      const selectedFiles = rawSelectedFiles.flatMap((file) => {
        const normalized = this.normalizeSelectedTestFile(canonicalProjectPath, file)
        return normalized ? [normalized] : []
      })
      if (selectedFiles.length !== rawSelectedFiles.length) {
        return this.blockInvalidConfiguration(callbacks, 'Selected test files must be relative files inside the approved project.')
      }

      if (runMode === 'file') {
        if (selectedFiles.length > 0) {
          args.push(...selectedFiles)
        } else if (testFile) {
          const normalizedTestFile = this.normalizeSelectedTestFile(canonicalProjectPath, testFile)
          if (!normalizedTestFile) {
            return this.blockInvalidConfiguration(callbacks, 'Selected test file must be a relative file inside the approved project.')
          }
          args.push(normalizedTestFile)
        }
      }

      const effectiveSelectedFiles = runMode === 'file'
        ? selectedFiles.length > 0
          ? selectedFiles
          : typeof testFile === 'string' && testFile.trim()
            ? [this.normalizeSelectedTestFile(canonicalProjectPath, testFile)].filter((file): file is string => Boolean(file))
            : []
        : []

      if (runMode === 'file' && effectiveSelectedFiles.length === 0) {
        return this.blockInvalidConfiguration(callbacks, 'Run configuration incomplete: select at least one Playwright test file before starting.')
      }

      if (runMode === 'name' && !String(testName || '').trim()) {
        return this.blockInvalidConfiguration(callbacks, 'Run configuration incomplete: select a Playwright test name or switch to file/all mode.')
      }

      const missingFiles = effectiveSelectedFiles.filter((file) => !this.testTargetExists(canonicalProjectPath, file))
      if (missingFiles.length > 0) {
        return this.blockInvalidConfiguration(callbacks, `Selected Playwright test file does not exist: ${missingFiles.join(', ')}`)
      }

      const shouldApplyNameFilter = !!testName && (
        runMode === 'name'
        || (runMode === 'file' && selectedFiles.length > 1)
      )

      if (shouldApplyNameFilter) {
        args.push('-g', testName as string)
      }

      if (configPath) {
        args.push('--config', configPath)
        if (configResolution?.source === 'workspace') {
          callbacks.onLog?.(`Using workspace Playwright config: ${path.basename(configPath)}`)
        }
      } else {
        callbacks.onLog?.('No Playwright config found in project or workspace. Running with Playwright defaults.')
      }

      if (!headless) {
        args.push('--headed')
      }

      if (debug) {
        args.push('--debug')
      }

      args.push('--workers', String(parallel))

      if (browser && configPath) {
        if (this.configSupportsProject(canonicalProjectPath, configPath, browser)) {
          args.push('--project', browser)
        } else {
          return this.blockInvalidConfiguration(callbacks, `Playwright project "${browser}" is not defined in ${path.basename(configPath)}.`)
        }
      } else if (browser && !configPath) {
        return this.blockInvalidConfiguration(callbacks, `Cannot validate Playwright project "${browser}" because no Playwright config was found.`)
      }

      args.push('--reporter=list')
      args.push('--retries', '2')
      args.push('--trace', trace || 'retain-on-failure')

      const effectiveRequiredEnvVars = this.mergeEnvNames(
        Array.isArray(requiredEnvVars) ? requiredEnvVars : [],
        this.collectRequiredEnvVarsFromSelectedFiles(canonicalProjectPath, effectiveSelectedFiles),
      )

      const safeOverrides = sanitizeRequestedEnvOverrides(envOverrides, effectiveRequiredEnvVars)
      Object.assign(env, safeOverrides)
      if (Object.keys(safeOverrides).length > 0) {
        callbacks.onLog?.(`INFO: Injected runtime env overrides: ${Object.keys(safeOverrides).join(', ')}`)
      }

      const missingBeforeEnvFiles = effectiveRequiredEnvVars.filter((name) => !String(env[name] || '').trim())
      if (missingBeforeEnvFiles.length > 0) {
        const envFileResolution = this.resolveEnvFromFiles(canonicalProjectPath, effectiveWorkspacePath, missingBeforeEnvFiles, normalizedRequestedEnvironment)
        for (const [key, value] of Object.entries(envFileResolution.values)) {
          env[key] = value
        }

        if (Object.keys(envFileResolution.values).length > 0) {
          callbacks.onLog?.(`INFO: Derived runtime env from repo conventions: ${Object.keys(envFileResolution.values).join(', ')}`)
        }
      }

      const missingRequiredEnvVars = effectiveRequiredEnvVars.filter((name) => !String(env[name] || '').trim())
      if (missingRequiredEnvVars.length > 0) {
        const environmentHint = 'Choose the environment explicitly when multiple repo environments are possible (for example qa, dev, qaApi or devApi), or configure the matching provider credential in Settings.'
        callbacks.onLog?.(`SKIP PRECHECK: Missing required env vars: ${missingRequiredEnvVars.join(', ')}`)
        callbacks.onLog?.(`SKIP HINT: ${environmentHint}`)
        return this.blockInvalidConfiguration(callbacks, `Required environment is missing: ${missingRequiredEnvVars.join(', ')}`)
      }
    }

    let invocation: ReturnType<typeof getNpxInvocation>
    try {
      invocation = getNpxInvocation()
    } catch (error) {
      return this.blockInvalidConfiguration(callbacks, (error as Error).message)
    }
    this.currentProcess = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
      cwd: canonicalProjectPath,
      env,
      shell: false,
    })

    this.currentProcess.stdout.on('data', (data) => {
      callbacks.onLog?.(data.toString())
    })

    this.currentProcess.stderr.on('data', (data) => {
      callbacks.onLog?.(data.toString())
    })

    this.currentProcess.on('close', (code) => {
      callbacks.onFinished?.(code ?? 0)
      this.currentProcess = null
      this.currentCallbacks = null
    })

    this.currentProcess.on('error', (error) => {
      callbacks.onLog?.(`CRITICAL ERROR: ${error.message}`)
      callbacks.onFinished?.(1)
      this.currentProcess = null
      this.currentCallbacks = null
    })

    return { ok: true, pid: this.currentProcess.pid }
  }

  async stop(): Promise<{ ok: boolean; stopped: boolean; error?: string }> {
    if (!this.currentProcess) {
      return { ok: true, stopped: false }
    }

    try {
      this.currentCallbacks?.onLog?.('WARN: Stop requested by operator.')
    } catch {
      // ignore callback issues during shutdown
    }

    try {
      const pid = this.currentProcess.pid
      if (!pid) {
        throw new Error('Runner process is missing a pid')
      }

      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          encoding: 'utf-8',
          shell: false,
        })

        if (result.status !== 0) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          const taskkillOutput = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase()
          const alreadyStopped = taskkillOutput.includes('not found')
            || taskkillOutput.includes('no running instance')
            || taskkillOutput.includes('does not exist')
            || taskkillOutput.includes('not exist')

          if (this.currentProcess.exitCode !== null || alreadyStopped) {
            return { ok: true, stopped: true }
          }

          throw new Error('Failed to stop runner process tree on Windows')
        }
      } else {
        this.currentProcess.kill('SIGTERM')
      }

      return { ok: true, stopped: true }
    } catch (error) {
      return { ok: false, stopped: false, error: (error as Error).message || 'Failed to stop runner process' }
    }
  }

  private resolvePlaywrightConfig(projectPath: string, workspacePath?: string | null): PlaywrightConfigResolution | null {
    const candidates = [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ]

    for (const file of candidates) {
      const fullPath = this.resolveSafeExistingFile(projectPath, file)
      if (fullPath) {
        return { path: file, source: 'project' }
      }
    }

    if (typeof workspacePath === 'string' && workspacePath.trim()) {
      for (const file of candidates) {
        const fullPath = this.resolveSafeExistingFile(workspacePath, file)
        if (fullPath) {
          return { path: fullPath, source: 'workspace' }
        }
      }
    }

    return null
  }

  private configSupportsProject(projectPath: string, configPath: string, projectName: string): boolean {
    try {
      const fullPath = path.isAbsolute(configPath)
        ? SecurityGuard.getSafePath(configPath)
        : SecurityGuard.resolveSafeChildPath(projectPath, configPath)
      if (!fs.statSync(fullPath).isFile()) return false
      const content = fs.readFileSync(fullPath, 'utf-8')
      const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`name\\s*:\\s*['"]${escaped}['"]`)
      return pattern.test(content)
    } catch {
      return false
    }
  }

  private blockInvalidConfiguration(callbacks: RunnerCallbacks, reason: string): RunnerStartResult {
    callbacks.onLog?.(`CONFIG INVALID: ${reason}`)
    callbacks.onFinished?.(RUNNER_INVALID_CONFIGURATION_EXIT_CODE)
    this.currentCallbacks = null
    return {
      ok: false,
      blocked: true,
      classification: 'invalid-configuration',
      reason,
    }
  }

  private mergeEnvNames(...groups: unknown[][]): string[] {
    const values = groups
      .flat()
      .map((entry) => String(entry || '').trim())
      .filter((entry) => /^[A-Z][A-Z0-9_]{0,127}$/.test(entry) && !isDangerousEnvKey(entry))

    return [...new Set(values)]
  }

  private collectRequiredEnvVarsFromSelectedFiles(projectPath: string, selectedFiles: string[]): string[] {
    const found: string[] = []

    for (const file of selectedFiles) {
      try {
        const normalized = this.normalizeSelectedTestFile(projectPath, file)
        if (!normalized) {
          continue
        }
        const target = SecurityGuard.resolveSafeChildPath(projectPath, normalized)
        const content = fs.readFileSync(target, 'utf-8')
        found.push(...[...content.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]))
      } catch {
        // ignore unreadable test files
      }
    }

    return this.mergeEnvNames(found)
  }

  private testTargetExists(projectPath: string, file: string): boolean {
    return this.normalizeSelectedTestFile(projectPath, file) !== null
  }

  private normalizeSelectedTestFile(projectPath: string, file: unknown): string | null {
    if (typeof file !== 'string' || !file.trim() || file.length > 500 || file.includes('\0')) return null
    const normalizedInput = normalizePath(file.trim())
    if (path.isAbsolute(normalizedInput) || /^[A-Za-z]:\//.test(normalizedInput)) return null

    const segments = normalizedInput.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
    if (!/\.(?:spec|test|e2e)\.(?:[cm]?[jt]sx?)$/i.test(normalizedInput)) return null

    try {
      const canonicalProject = SecurityGuard.canonicalizePath(projectPath)
      const canonicalTarget = SecurityGuard.resolveSafeChildPath(canonicalProject, normalizedInput)
      if (!SecurityGuard.isPathWithinRoot(canonicalProject, canonicalTarget) || !SecurityGuard.isPathSafe(canonicalTarget)) return null
      if (!fs.statSync(canonicalTarget).isFile()) return null
      return normalizePath(path.relative(canonicalProject, canonicalTarget))
    } catch {
      return null
    }
  }

  private resolveSafeExistingFile(rootPath: string, childPath: string): string | null {
    try {
      const canonical = SecurityGuard.resolveSafeChildPath(rootPath, childPath)
      if (!SecurityGuard.isPathSafe(canonical) || !fs.statSync(canonical).isFile()) return null
      return canonical
    } catch {
      return null
    }
  }

  private normalizeEnvironmentName(value: unknown): string | null {
    const normalized = String(value || '').trim()
    if (!normalized) {
      return null
    }

    return SAFE_ENVIRONMENT_NAMES.find((name) => name.toLowerCase() === normalized.toLowerCase()) || null
  }

  private resolveEnvFromFiles(
    projectPath: string,
    workspacePath: string | null,
    missingEnvVars: string[],
    requestedEnvironment: string | null,
  ): { values: Record<string, string> } {
    const roots = [...new Set([projectPath, workspacePath].filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()))]
    const candidates = this.buildEnvFileCandidates(roots, requestedEnvironment)
    const parsedCandidates = candidates
      .filter((candidate) => {
        try {
          return SecurityGuard.isPathSafe(candidate.fullPath) && fs.statSync(SecurityGuard.canonicalizePath(candidate.fullPath)).isFile()
        } catch {
          return false
        }
      })
      .map((candidate) => ({
        ...candidate,
        values: this.parseEnvFile(candidate.fullPath),
      }))

    const resolved: Record<string, string> = {}
    for (const envVar of missingEnvVars) {
      const genericMatches = parsedCandidates.filter((candidate) => candidate.envName === null && candidate.values[envVar])
      if (genericMatches.length > 0) {
        resolved[envVar] = genericMatches[genericMatches.length - 1].values[envVar]
        continue
      }

      const envMatches = parsedCandidates.filter((candidate) => candidate.envName !== null && candidate.values[envVar])
      const envNames = [...new Set(envMatches.map((candidate) => candidate.envName))]

      if (requestedEnvironment) {
        const requestedMatches = envMatches.filter((candidate) => candidate.envName?.toLowerCase() === requestedEnvironment.toLowerCase())
        if (requestedMatches.length > 0) {
          resolved[envVar] = requestedMatches[requestedMatches.length - 1].values[envVar]
        }
        continue
      }

      if (envNames.length === 1) {
        const uniqueMatches = envMatches.filter((candidate) => candidate.envName === envNames[0])
        resolved[envVar] = uniqueMatches[uniqueMatches.length - 1].values[envVar]
      }
    }

    const stillMissing = missingEnvVars.filter((envVar) => !resolved[envVar])
    if (stillMissing.length > 0) {
      Object.assign(resolved, this.resolveEnvFromPackageScripts(roots, stillMissing))
    }

    return { values: resolved }
  }

  private buildEnvFileCandidates(roots: string[], requestedEnvironment: string | null): EnvFileCandidate[] {
    const envNames = requestedEnvironment ? [requestedEnvironment] : SAFE_ENVIRONMENT_NAMES
    const candidates: EnvFileCandidate[] = []

    for (const root of roots) {
      candidates.push(
        { envName: null, fullPath: path.join(root, '.env') },
        { envName: null, fullPath: path.join(root, '.env.local') },
      )

      for (const envName of envNames) {
        candidates.push(
          { envName, fullPath: path.join(root, `.env.${envName}`) },
          { envName, fullPath: path.join(root, `.env.${envName}.local`) },
        )
      }
    }

    return candidates
  }

  private parseEnvFile(fullPath: string): Record<string, string> {
    try {
      const canonical = SecurityGuard.getSafePath(fullPath)
      if (!fs.statSync(canonical).isFile()) return {}
      const content = fs.readFileSync(canonical, 'utf-8')
      const parsed: Record<string, string> = {}

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) {
          continue
        }

        const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/)
        if (!match || isDangerousEnvKey(match[1])) {
          continue
        }

        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }

        if (value) {
          parsed[match[1]] = value
        }
      }

      return parsed
    } catch {
      return {}
    }
  }

  private resolveEnvFromPackageScripts(roots: string[], missingEnvVars: string[]): Record<string, string> {
    const valuesByVar = new Map<string, Set<string>>()

    for (const root of roots) {
      try {
        const packageJsonPath = this.resolveSafeExistingFile(root, 'package.json')
        if (!packageJsonPath) {
          continue
        }

        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
        const scripts = parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object'
          ? parsed.scripts as Record<string, unknown>
          : {}

        for (const script of Object.values(scripts)) {
          const text = String(script || '')
          for (const envVar of missingEnvVars) {
            const escaped = envVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const assignment = text.match(new RegExp(`(?:^|\\s|cross-env\\s+)${escaped}=([A-Za-z0-9_.:/-]+)`))
            if (!assignment?.[1]) {
              continue
            }

            const values = valuesByVar.get(envVar) || new Set<string>()
            values.add(assignment[1])
            valuesByVar.set(envVar, values)
          }
        }
      } catch {
        // ignore invalid package.json files
      }
    }

    const resolved: Record<string, string> = {}
    for (const [envVar, values] of valuesByVar.entries()) {
      if (values.size === 1) {
        resolved[envVar] = [...values][0]
      }
    }

    return resolved
  }
}
