import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

export function normalizePath(targetPath: string): string {
  return targetPath.replace(/\\/g, '/')
}

export function getUserHome(): string {
  const configuredHome = process.platform === 'win32'
    ? process.env.USERPROFILE || process.env.HOME
    : process.env.HOME || process.env.USERPROFILE
  return configuredHome ? path.resolve(configuredHome) : os.homedir()
}

export function isPackaged(): boolean {
  return process.env.XYVA_AGENT_PACKAGED === '1' || !!process.env.XYVA_RUNTIME_BASE
}

export function getRuntimeBase(): string {
  const explicit = process.env.XYVA_RUNTIME_BASE
  if (explicit && explicit.trim()) {
    return path.resolve(explicit)
  }

  return path.join(process.cwd(), 'resources', 'runtime')
}

export function getNodeDir(): string {
  const platformDir = isWin ? 'win32' : 'darwin'
  return path.join(getRuntimeBase(), 'node', platformDir)
}

export function getNodeBinary(): string {
  const dir = getNodeDir()
  const bin = path.join(dir, isWin ? 'node.exe' : 'bin/node')
  if (fs.existsSync(bin)) {
    return bin
  }

  return 'node'
}

export function getNpmCommand(): string {
  const dir = getNodeDir()
  if (isWin) {
    const cmd = path.join(dir, 'npm.cmd')
    if (fs.existsSync(cmd)) {
      return cmd
    }

    return 'npm.cmd'
  }

  const bin = path.join(dir, 'bin/npm')
  if (fs.existsSync(bin)) {
    return bin
  }

  return 'npm'
}

export function getNpxCommand(): string {
  const dir = getNodeDir()
  if (isWin) {
    const cmd = path.join(dir, 'npx.cmd')
    if (fs.existsSync(cmd)) {
      return cmd
    }

    return 'npx.cmd'
  }

  const bin = path.join(dir, 'bin/npx')
  if (fs.existsSync(bin)) {
    return bin
  }

  return 'npx'
}

export function getNpxInvocation(): { command: string; argsPrefix: string[] } {
  const npx = getNpxCommand()
  if (!isWin || !/\.cmd$/i.test(npx)) {
    return { command: npx, argsPrefix: [] }
  }

  const candidates = [
    path.join(path.dirname(npx), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    process.env.npm_execpath ? path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js') : '',
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].filter(Boolean)
  const npxCli = candidates.find((candidate) => fs.existsSync(candidate))
  if (!npxCli) {
    throw new Error('Secure npx CLI entrypoint not found. Reinstall Node.js/npm or the xyva runtime.')
  }

  return {
    command: getNodeBinary() === 'node' ? process.execPath : getNodeBinary(),
    argsPrefix: [npxCli],
  }
}

export function getGitBinary(): string {
  if (isWin) {
    const bin = path.join(getRuntimeBase(), 'git', 'win32', 'cmd', 'git.exe')
    if (fs.existsSync(bin)) {
      return bin
    }
  }

  return 'git'
}

export function getPlaywrightModulePath(): string {
  return path.join(getRuntimeBase(), 'playwright', 'node_modules')
}

export function getAgentDataRoot(): string {
  const explicitStateDir = process.env.XYVA_AGENT_STATE_DIR?.trim()
  if (explicitStateDir) {
    if (!path.isAbsolute(explicitStateDir)) {
      throw new Error('XYVA_AGENT_STATE_DIR must be an absolute path')
    }

    const resolvedStateDir = path.resolve(explicitStateDir)
    const filesystemRoot = path.parse(resolvedStateDir).root
    if (resolvedStateDir === filesystemRoot || resolvedStateDir === path.resolve(getUserHome())) {
      throw new Error('XYVA_AGENT_STATE_DIR must not target a filesystem root or the user home')
    }
    return resolvedStateDir
  }

  return path.join(getUserHome(), '.xyva')
}

export function getPlaywrightBrowsersPath(): string {
  return path.join(getAgentDataRoot(), 'playwright-browsers')
}

export function getRuntimeEnv(extra?: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>), ...extra }
  const pathDirs: string[] = []

  const nodeDir = getNodeDir()
  if (fs.existsSync(nodeDir)) {
    pathDirs.push(nodeDir)
  }

  const gitDir = path.join(getRuntimeBase(), 'git', 'win32', 'cmd')
  if (isWin && fs.existsSync(gitDir)) {
    pathDirs.push(gitDir)
  }

  if (pathDirs.length > 0) {
    const sep = isWin ? ';' : ':'
    const existingPath = env.PATH || env.Path || ''
    env.PATH = `${pathDirs.join(sep)}${sep}${existingPath}`
    if (isWin && env.Path) {
      env.Path = env.PATH
    }
  }

  env.PLAYWRIGHT_BROWSERS_PATH = getPlaywrightBrowsersPath()

  const pwModules = getPlaywrightModulePath()
  if (fs.existsSync(pwModules)) {
    const sep = isWin ? ';' : ':'
    env.NODE_PATH = `${pwModules}${env.NODE_PATH ? `${sep}${env.NODE_PATH}` : ''}`
  }

  return env
}

export function getShellCommand(command: string): string {
  switch (command) {
    case 'npx':
      return getNpxCommand()
    case 'npm':
      return getNpmCommand()
    case 'node':
      return getNodeBinary()
    case 'git':
      return getGitBinary()
    default:
      return command
  }
}
