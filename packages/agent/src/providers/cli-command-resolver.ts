import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { CliCommandResolution, CliCommandResolver, CliInstallationKind } from './cli-types.js'

type ResolverOptions = { env?: NodeJS.ProcessEnv; cwd?: string; homeDir?: string; platform?: NodeJS.Platform }

function inside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function rootsFor(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): { root: string; kind: CliInstallationKind }[] {
  if (platform === 'win32') {
    return [
      env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), path.join(homeDir, '.local', 'bin'), path.join(homeDir, '.npm-global'), path.join(homeDir, 'AppData', 'Roaming', 'npm'),
    ].filter((root): root is string => Boolean(root)).map((root) => ({ root, kind: root.includes('npm') ? 'npm-global' : root.includes(homeDir) ? 'user-managed' : 'system' }))
  }
  return [
    { root: '/usr/bin', kind: 'system' }, { root: '/usr/local', kind: 'system' }, { root: '/opt/homebrew', kind: 'system' }, { root: '/opt', kind: 'system' },
    { root: path.join(homeDir, '.local', 'bin'), kind: 'user-managed' }, { root: path.join(homeDir, '.npm-global'), kind: 'npm-global' },
    { root: path.join(homeDir, '.volta'), kind: 'user-managed' }, { root: path.join(homeDir, '.fnm'), kind: 'user-managed' }, { root: path.join(homeDir, '.nvm'), kind: 'user-managed' },
  ]
}

async function secureFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === 'win32') return /\.(?:exe|js)$/iu.test(file)
  const stat = await fs.stat(file)
  return stat.isFile() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0
}

/** Resolves fixed CLI names only from vetted installation roots; never from the working directory. */
export class TrustedCliCommandResolver implements CliCommandResolver {
  readonly #env: NodeJS.ProcessEnv
  readonly #cwd: string
  readonly #homeDir: string
  readonly #platform: NodeJS.Platform

  public constructor(options: ResolverOptions = {}) {
    this.#env = options.env || process.env
    this.#cwd = path.resolve(options.cwd || process.cwd())
    this.#homeDir = path.resolve(options.homeDir || os.homedir())
    this.#platform = options.platform || process.platform
  }

  public async resolve(command: string): Promise<CliCommandResolution> {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(command)) return this.rejected('Invalid CLI command name.')
    const roots = rootsFor(this.#platform, this.#homeDir, this.#env).map((entry) => ({ ...entry, root: path.resolve(entry.root) }))
    const entries = (this.#env.PATH || '').split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry))
    const names = this.#platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command]
    let sawUntrusted = false
    for (const entry of entries) {
      for (const name of names) {
        const candidate = path.resolve(entry, name)
        try {
          const canonical = await fs.realpath(candidate)
          if (inside(canonical, this.#cwd)) { sawUntrusted = true; continue }
          const root = roots.find((trustedRoot) => inside(canonical, trustedRoot.root))
          if (!root || !(await secureFile(canonical, this.#platform))) { sawUntrusted = true; continue }
          return { command, executablePath: canonical, installationKind: canonical.includes(`${path.sep}node_modules${path.sep}`) ? 'npm-global' : root.kind, trusted: true, detail: 'Trusted CLI installation resolved.' }
        } catch { /* candidate does not exist or cannot be canonicalized */ }
      }
    }
    return this.rejected(sawUntrusted ? 'CLI installation was rejected by the trusted-path policy.' : 'No trusted CLI installation was found.')
  }

  private rejected(detail: string): CliCommandResolution {
    return { command: '', executablePath: null, installationKind: null, trusted: false, detail }
  }
}
