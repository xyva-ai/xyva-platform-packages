import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type {
  AgentReadinessAction,
  AgentReadinessCheck,
  AgentReadinessReport,
  AgentReadinessSource,
} from '@xyva/bridge-types'
import { BRIDGE_PROTOCOL_VERSION } from '@xyva/bridge-types'

import {
  getAgentDataRoot,
  getGitBinary,
  getNpmCommand,
  getPlaywrightBrowsersPath,
  getPlaywrightModulePath,
  getRuntimeBase,
  getRuntimeEnv,
  isWin,
} from './utils/platform.js'
import { AGENT_VERSION } from './version.js'

const MIN_NODE_MAJOR = 22

type VersionProbe = {
  ready: boolean
  version: string | null
  path: string | null
  source: AgentReadinessSource
  message: string
}

export interface AgentReadinessOptions {
  projectPath?: string | null
}

export function getAgentReadiness(options: AgentReadinessOptions = {}): AgentReadinessReport {
  const checks = [
    checkNode(),
    checkNpm(),
    checkGit(),
    checkPlaywright(options.projectPath || null),
    checkBrowsers(),
    checkProject(options.projectPath || null),
  ]

  const requiredReady = checks.filter((check) => check.required).every((check) => check.ready)
  const allReady = checks.every((check) => check.ready)
  const canUseGit = checks.find((check) => check.id === 'git')?.ready ?? false
  const status = requiredReady ? (allReady ? 'ready' : 'degraded') : 'blocked'

  return {
    status,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    checkedAt: new Date().toISOString(),
    portableMode: isPortableMode(),
    canRunTests: requiredReady,
    canUseGit,
    agent: {
      version: AGENT_VERSION,
      platform: process.platform,
      node: process.version,
    },
    checks,
    nextAction: buildNextAction(checks),
  }
}

function checkNode(): AgentReadinessCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] || '0', 10)
  const ready = Number.isFinite(major) && major >= MIN_NODE_MAJOR

  return {
    id: 'node',
    label: 'Node.js runtime',
    ready,
    required: true,
    source: getNodeSource(),
    version: process.version,
    path: process.execPath,
    message: ready
      ? `Node.js ${process.version} ist fuer den Agent bereit.`
      : `Node.js ${MIN_NODE_MAJOR}+ wird benoetigt, gefunden wurde ${process.version}.`,
    remediation: ready ? undefined : nodeInstallAction(),
  }
}

function checkNpm(): AgentReadinessCheck {
  const npm = getNpmCommand()
  const probe = probeVersion(npm, ['--version'])

  return {
    id: 'npm',
    label: 'npm/npx runtime',
    ready: probe.ready,
    required: true,
    source: probe.source,
    version: probe.version,
    path: probe.path,
    message: probe.ready
      ? `npm ${probe.version} ist erreichbar.`
      : 'npm/npx ist nicht erreichbar. Installiere Node.js 22 oder neuer inklusive npm.',
    remediation: probe.ready ? undefined : nodeInstallAction(),
  }
}

function checkGit(): AgentReadinessCheck {
  const git = getGitBinary()
  const probe = probeVersion(git, ['--version'])
  const version = probe.version?.replace(/^git version\s+/i, '') || null

  return {
    id: 'git',
    label: 'Git',
    ready: probe.ready,
    required: false,
    source: probe.source,
    version,
    path: probe.path,
    message: probe.ready
      ? `Git ${version} ist erreichbar.`
      : 'Git ist nicht erreichbar. Runs koennen funktionieren, aber Clone/Pull/Branch-Features sind blockiert.',
    remediation: probe.ready
      ? undefined
      : {
          label: 'Git installieren (optional)',
          kind: 'open-docs',
          href: 'https://git-scm.com/downloads',
        },
  }
}

function checkPlaywright(projectPath: string | null): AgentReadinessCheck {
  const projectPackage = projectPath ? path.join(projectPath, 'node_modules', 'playwright', 'package.json') : null
  const packagePath = resolvePlaywrightPackagePath(projectPath)

  if (packagePath) {
    const version = readPackageVersion(packagePath)
    return {
      id: 'playwright',
      label: 'Playwright package',
      ready: true,
      required: true,
      source: packagePath === projectPackage ? 'project' : 'bundled',
      version,
      path: path.dirname(packagePath),
      message: `Playwright ${version || ''} ist verfuegbar.`.trim(),
    }
  }

  return {
    id: 'playwright',
    label: 'Playwright package',
    ready: false,
    required: true,
    source: 'missing',
    version: null,
    path: null,
    message: 'Playwright ist weder im Agent-Runtime-Bundle noch im Projekt gefunden worden.',
    remediation: {
      label: 'Playwright im Agent-Runtime-Bundle nachladen',
      command: 'npx playwright install chromium',
      kind: 'run-command',
    },
  }
}

export function resolvePlaywrightPackagePath(
  projectPath: string | null,
  moduleUrl = import.meta.url,
): string | null {
  let installedPackage: string | null = null
  try {
    installedPackage = createRequire(moduleUrl).resolve('playwright/package.json')
  } catch {
    // Continue with portable runtime and project-local fallbacks.
  }

  const bundledPackage = path.join(getPlaywrightModulePath(), 'playwright', 'package.json')
  const projectPackage = projectPath ? path.join(projectPath, 'node_modules', 'playwright', 'package.json') : null
  return [installedPackage, bundledPackage, projectPackage]
    .find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) ?? null
}

function checkBrowsers(): AgentReadinessCheck {
  const browsersPath = getPlaywrightBrowsersPath()
  const installed = hasChromiumBrowser(browsersPath)

  return {
    id: 'browsers',
    label: 'Playwright browser',
    ready: installed,
    required: true,
    source: installed ? 'portable' : 'missing',
    version: null,
    path: browsersPath,
    message: installed
      ? 'Chromium Browser-Binaries sind im lokalen xyva Cache vorhanden.'
      : 'Playwright Chromium fehlt. Ohne Browser-Binaries laufen Runner und Swarm nicht.',
    remediation: installed
      ? undefined
      : {
          label: 'Browser ueber den Agent nachladen',
          command: 'npx playwright install chromium',
          kind: 'run-command',
        },
  }
}

function checkProject(projectPath: string | null): AgentReadinessCheck {
  if (!projectPath) {
    return {
      id: 'project',
      label: 'Projektpfad',
      ready: false,
      required: false,
      source: 'unknown',
      version: null,
      path: null,
      message: 'Noch kein lokales Projekt ausgewaehlt. Das ist fuer den Agent-Start okay.',
    }
  }

  const exists = fs.existsSync(projectPath)
  return {
    id: 'project',
    label: 'Projektpfad',
    ready: exists,
    required: true,
    source: exists ? 'project' : 'missing',
    version: null,
    path: projectPath,
    message: exists
      ? 'Der Projektpfad ist lokal erreichbar.'
      : 'Der ausgewaehlte Projektpfad ist auf diesem Rechner nicht erreichbar.',
    remediation: exists
      ? undefined
      : {
          label: 'Projekt neu auswaehlen oder klonen',
          kind: 'open-docs',
          href: 'https://docs.xyva.ai/guide/portal-agent-setup',
        },
  }
}

function probeVersion(command: string, args: string[]): VersionProbe {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      env: getRuntimeEnv(),
      shell: isWin && /\.cmd$/i.test(command),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim()

    return {
      ready: true,
      version: output.split(/\r?\n/)[0] || null,
      path: command,
      source: sourceForPath(command),
      message: output,
    }
  } catch {
    return {
      ready: false,
      version: null,
      path: command,
      source: 'missing',
      message: `${command} not reachable`,
    }
  }
}

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function hasChromiumBrowser(browsersPath: string): boolean {
  try {
    return fs.existsSync(browsersPath)
      && fs.readdirSync(browsersPath).some((entry) => entry.toLowerCase().startsWith('chromium'))
  } catch {
    return false
  }
}

function buildNextAction(checks: AgentReadinessCheck[]): string {
  const blocking = checks.find((check) => check.required && !check.ready)
  if (blocking) {
    return blocking.message
  }

  const degraded = checks.find((check) => !check.ready)
  if (degraded) {
    return degraded.message
  }

  return 'Lokaler Agent, Runtime und Browser sind bereit.'
}

function sourceForPath(commandPath: string): AgentReadinessSource {
  if (!commandPath || commandPath === 'node' || commandPath === 'npm' || commandPath === 'npm.cmd' || commandPath === 'git') {
    return 'system'
  }

  const normalized = path.resolve(commandPath).toLowerCase()
  const runtimeBase = path.resolve(getRuntimeBase()).toLowerCase()
  const agentDataRoot = path.resolve(getAgentDataRoot()).toLowerCase()

  if (normalized.startsWith(runtimeBase)) {
    return process.env.XYVA_RUNTIME_BASE ? 'portable' : 'bundled'
  }

  if (normalized.startsWith(agentDataRoot)) {
    return 'portable'
  }

  return 'system'
}

function getNodeSource(): AgentReadinessSource {
  return sourceForPath(process.execPath)
}

function isPortableMode(): boolean {
  return Boolean(process.env.XYVA_RUNTIME_BASE || process.env.XYVA_AGENT_PACKAGED === '1')
}

function nodeInstallAction(): AgentReadinessAction {
  return {
    label: 'Node.js 22+ installieren',
    kind: 'open-docs',
    href: 'https://nodejs.org/en/download',
  }
}
