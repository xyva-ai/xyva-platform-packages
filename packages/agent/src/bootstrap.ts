import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { getRuntimeEnv } from './utils/platform.js'
import { getXyvaDir } from './auth.js'

export async function checkRuntime(options: { repairPlaywright?: boolean; projectPath?: string } = {}): Promise<void> {
  const nodeVersion = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (nodeVersion < 22) {
    throw new Error(`Node.js 22+ required, found ${process.version}`)
  }

  ensureXyvaDir()

  if (options.repairPlaywright !== false) {
    ensurePlaywrightRuntime(options.projectPath)
  }
}

export function ensureXyvaDir(): string {
  const xyvaDir = getXyvaDir()
  const subDirs = ['cache', 'logs']

  fs.mkdirSync(xyvaDir, { recursive: true })
  for (const dirName of subDirs) {
    fs.mkdirSync(path.join(xyvaDir, dirName), { recursive: true })
  }

  return xyvaDir
}

function ensurePlaywrightRuntime(projectPath?: string): void {
  const env = getRuntimeEnv()
  const agentPlaywrightCli = resolvePlaywrightCli()
  if (!agentPlaywrightCli) {
    throw new Error('Playwright runtime is missing. Reinstall @xyva/agent and retry.')
  }

  try {
    execFileSync(process.execPath, [agentPlaywrightCli, '--version'], {
      stdio: 'pipe',
      env,
      shell: false,
    })
  } catch {
    console.log('Playwright package is not available through npx.')
    throw new Error('Playwright runtime is missing. Reinstall @xyva/agent and retry.')
  }

  console.log('Ensuring Playwright Chromium runtime...')
  execFileSync(process.execPath, [agentPlaywrightCli, 'install', 'chromium'], {
    stdio: 'inherit',
    env,
    shell: false,
  })

  const projectPlaywrightCli = projectPath ? resolvePlaywrightCli(projectPath) : null
  if (projectPlaywrightCli && projectPlaywrightCli !== agentPlaywrightCli) {
    console.log('Ensuring Playwright Chromium runtime for the selected project...')
    execFileSync(process.execPath, [projectPlaywrightCli, 'install', 'chromium'], {
      cwd: projectPath,
      stdio: 'inherit',
      env,
      shell: false,
    })
  }
}

/**
 * Uses the Playwright CLI owned by the relevant package instead of `npx
 * playwright`. The latter can resolve a newer package in an arbitrary cwd,
 * downloading browser revisions that a project-local Playwright cannot run.
 */
export function resolvePlaywrightCli(projectPath?: string): string | null {
  try {
    const requireFrom = projectPath
      ? createRequire(path.join(projectPath, 'package.json'))
      : createRequire(import.meta.url)
    // Playwright intentionally does not export its internal cli.js subpath.
    // Resolve its public package entry first, then locate the sibling CLI file.
    const entryPoint = requireFrom.resolve('playwright')
    const cliPath = path.join(path.dirname(entryPoint), 'cli.js')
    return fs.existsSync(cliPath) ? cliPath : null
  } catch {
    return null
  }
}

export function installPlaywrightChromium(): { ok: boolean; error?: string } {
  try {
    ensurePlaywrightRuntime()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'Failed to install Playwright Chromium runtime' }
  }
}
