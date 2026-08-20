import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Browser } from 'playwright'

import type { SwarmAuthConfig } from '../../../../xyva-swarms/src/contracts/auth.js'
import { PlaywrightAuthSessionAdapter } from '../../../../xyva-swarms/src/adapters/browser/playwright-auth-session.js'
import { SecurityGuard } from '../../utils/SecurityGuard.js'
import { getAgentDataRoot } from '../../utils/platform.js'
import { isSealedSecret, sealSecret, unsealSecret, writePrivateFile } from '../../secure-store.js'

interface StoredSwarmCredentials {
  version: 1 | 2
  projectPath: string
  username: string
  password: string
  savedAt: string
}

function getProjectHash(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex')
}

export class AgentSwarmCredentialStore {
  private readonly authSession = new PlaywrightAuthSessionAdapter()

  async save(projectPath: string, credentials: { username: string; password: string }): Promise<{ ok: boolean; error?: string }> {
    this.ensureProjectPath(projectPath)

    const payload: StoredSwarmCredentials = {
      version: 2,
      projectPath: path.resolve(projectPath),
      username: credentials.username,
      password: sealSecret(credentials.password, this.getSecretContext(projectPath)),
      savedAt: new Date().toISOString(),
    }

    writePrivateFile(this.getCredentialsPath(projectPath), JSON.stringify(payload, null, 2))
    return { ok: true }
  }

  async has(projectPath: string): Promise<{ ok: boolean; hasCredentials: boolean; error?: string }> {
    this.ensureProjectPath(projectPath)

    try {
      const parsed = await this.readCredentials(projectPath)
      return {
        ok: true,
        hasCredentials: typeof parsed?.password === 'string' && parsed.password.trim().length > 0,
      }
    } catch {
      return { ok: true, hasCredentials: false }
    }
  }

  async clear(projectPath: string): Promise<{ ok: boolean; error?: string }> {
    this.ensureProjectPath(projectPath)
    await fs.rm(this.getCredentialsPath(projectPath), { force: true })
    return { ok: true }
  }

  async loadPassword(projectPath: string): Promise<string | null> {
    this.ensureProjectPath(projectPath)

    try {
      const parsed = await this.readCredentials(projectPath)
      return typeof parsed?.password === 'string' && parsed.password.trim().length > 0 ? parsed.password : null
    } catch {
      return null
    }
  }

  async createStorageState(browser: Browser, auth: SwarmAuthConfig, projectPath: string): Promise<unknown> {
    const password = auth.password?.trim() || await this.loadPassword(projectPath)
    if (!password) {
      throw new Error('SWARM_AUTH_PASSWORD_MISSING')
    }

    return this.authSession.createStorageState(browser, auth, password)
  }

  private getCredentialsPath(projectPath: string): string {
    const root = path.join(getAgentDataRoot(), 'swarm-credentials')
    return path.join(root, `${getProjectHash(projectPath)}.json`)
  }

  private getSecretContext(projectPath: string): string {
    return `swarm-credentials:${getProjectHash(projectPath)}`
  }

  private async readCredentials(projectPath: string): Promise<StoredSwarmCredentials | null> {
    const filePath = this.getCredentialsPath(projectPath)
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoredSwarmCredentials>
    if (
      typeof parsed.projectPath !== 'string'
      || path.resolve(parsed.projectPath) !== path.resolve(projectPath)
      || typeof parsed.username !== 'string'
      || typeof parsed.password !== 'string'
      || typeof parsed.savedAt !== 'string'
    ) {
      return null
    }

    const password = isSealedSecret(parsed.password)
      ? unsealSecret(parsed.password, this.getSecretContext(projectPath))
      : parsed.password
    if (password === null) {
      return null
    }

    const credentials: StoredSwarmCredentials = {
      version: 2,
      projectPath: path.resolve(projectPath),
      username: parsed.username,
      password,
      savedAt: parsed.savedAt,
    }

    if (parsed.version !== 2 || !isSealedSecret(parsed.password)) {
      await this.save(projectPath, { username: credentials.username, password })
    } else {
      await fs.chmod(filePath, 0o600).catch(() => undefined)
    }

    return credentials
  }

  private ensureProjectPath(projectPath: string): void {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      throw new Error('Unauthorized project path')
    }
  }
}

export function sanitizeAuthForRun(auth?: SwarmAuthConfig): SwarmAuthConfig | undefined {
  if (!auth) {
    return undefined
  }

  return {
    ...auth,
    password: undefined,
  }
}
