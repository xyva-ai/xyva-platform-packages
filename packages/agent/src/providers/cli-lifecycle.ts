import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { CliIntegrityStatus, CliProviderId, CliUpdateStatus } from './cli-types.js'

export type CliLifecyclePlatform = 'darwin' | 'linux' | 'win32'

export interface CliReleaseEntry {
  providerId: CliProviderId
  platform: CliLifecyclePlatform
  architecture: string
  version: string
  artifactUrl: string
  sha256: string
  signature: string
  publicKeyId: string
}

export interface CliReleaseManifest {
  schemaVersion: 1
  generatedAt: string
  expiresAt: string
  entries: readonly CliReleaseEntry[]
}

export interface CliLifecycleStatus {
  providerId: CliProviderId
  currentVersion: string | null
  latestSupportedVersion: string | null
  updateStatus: CliUpdateStatus
  integrityStatus: CliIntegrityStatus
  rollbackAvailable: boolean
  installationPath: string | null
}

export interface CliLifecycleOptions {
  rootDir: string
  platform?: CliLifecyclePlatform
  architecture?: string
  now?: () => Date
  verifyManifestSignature?: (manifest: CliReleaseManifest) => boolean | Promise<boolean>
  hasActiveTasks?: (providerId: CliProviderId) => boolean
  requireConsent?: (entry: CliReleaseEntry) => boolean | Promise<boolean>
}

type InstalledPointer = {
  providerId: CliProviderId
  version: string
  artifactPath: string
  sha256: string
  installedAt: string
}

const SHA256 = /^[a-f0-9]{64}$/u
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

function key(providerId: CliProviderId): string {
  return providerId.replace(/[^a-z0-9-]/giu, '')
}

function pointerPath(rootDir: string, providerId: CliProviderId): string {
  return path.join(rootDir, key(providerId), 'current.json')
}

function rollbackPath(rootDir: string, providerId: CliProviderId): string {
  return path.join(rootDir, key(providerId), 'rollback.json')
}

function assertSafeEntry(entry: CliReleaseEntry): void {
  if (!VERSION.test(entry.version)) throw new Error(`Invalid CLI release version for ${entry.providerId}`)
  if (!/^https:\/\//iu.test(entry.artifactUrl)) throw new Error(`CLI release URL must use HTTPS for ${entry.providerId}`)
  if (!SHA256.test(entry.sha256)) throw new Error(`Invalid CLI release hash for ${entry.providerId}`)
  if (!entry.signature || !entry.publicKeyId) throw new Error(`CLI release signature metadata missing for ${entry.providerId}`)
}

export function validateCliReleaseManifest(manifest: CliReleaseManifest, now = new Date()): void {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('Unsupported or empty CLI release manifest')
  }
  const generated = Date.parse(manifest.generatedAt)
  const expires = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= generated || expires <= now.getTime()) {
    throw new Error('CLI release manifest is expired or has invalid timestamps')
  }
  const seen = new Set<string>()
  for (const entry of manifest.entries) {
    assertSafeEntry(entry)
    const tuple = `${entry.providerId}:${entry.platform}:${entry.architecture}:${entry.version}`
    if (seen.has(tuple)) throw new Error(`Duplicate CLI release entry: ${tuple}`)
    seen.add(tuple)
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  const handle = await fs.open(filePath, 'r')
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

export class CliLifecycleManager {
  readonly #rootDir: string
  readonly #platform: CliLifecyclePlatform
  readonly #architecture: string
  readonly #now: () => Date
  readonly #verifyManifestSignature: (manifest: CliReleaseManifest) => boolean | Promise<boolean>
  readonly #hasActiveTasks: (providerId: CliProviderId) => boolean
  readonly #requireConsent: (entry: CliReleaseEntry) => boolean | Promise<boolean>
  readonly #manifest: CliReleaseManifest

  public constructor(manifest: CliReleaseManifest, options: CliLifecycleOptions) {
    this.#manifest = manifest
    this.#rootDir = path.resolve(options.rootDir)
    this.#platform = options.platform || process.platform as CliLifecyclePlatform
    this.#architecture = options.architecture || process.arch
    this.#now = options.now || (() => new Date())
    this.#verifyManifestSignature = options.verifyManifestSignature || (() => false)
    this.#hasActiveTasks = options.hasActiveTasks || (() => false)
    this.#requireConsent = options.requireConsent || (() => false)
  }

  public async status(providerId: CliProviderId): Promise<CliLifecycleStatus> {
    validateCliReleaseManifest(this.#manifest, this.#now())
    if (!(await this.#verifyManifestSignature(this.#manifest))) throw new Error('CLI release manifest signature was not verified')
    const entry = this.entry(providerId)
    const current = await this.readPointer(pointerPath(this.#rootDir, providerId))
    const rollback = await this.readPointer(rollbackPath(this.#rootDir, providerId))
    if (!current) {
      return { providerId, currentVersion: null, latestSupportedVersion: entry.version, updateStatus: 'not_checked', integrityStatus: 'not_checked', rollbackAvailable: Boolean(rollback), installationPath: null }
    }
    let integrityStatus: CliIntegrityStatus = 'failed'
    try { integrityStatus = (await sha256File(current.artifactPath)) === current.sha256 ? 'verified' : 'failed' } catch { integrityStatus = 'unavailable' }
    return {
      providerId,
      currentVersion: current.version,
      latestSupportedVersion: entry.version,
      updateStatus: current.version === entry.version ? 'current' : 'update_available',
      integrityStatus,
      rollbackAvailable: Boolean(rollback),
      installationPath: current.artifactPath,
    }
  }

  public async install(providerId: CliProviderId, artifactPath: string): Promise<CliLifecycleStatus> {
    validateCliReleaseManifest(this.#manifest, this.#now())
    if (!(await this.#verifyManifestSignature(this.#manifest))) throw new Error('CLI release manifest signature was not verified')
    if (this.#hasActiveTasks(providerId)) throw new Error('Cannot update a CLI while provider tasks are active')
    const entry = this.entry(providerId)
    if (!(await this.#requireConsent(entry))) throw new Error('CLI update requires explicit operator consent')
    const actualHash = await sha256File(artifactPath)
    if (actualHash !== entry.sha256) throw new Error('CLI artifact integrity verification failed')

    const providerDir = path.join(this.#rootDir, key(providerId))
    const versionDir = path.join(providerDir, entry.version)
    const target = path.join(versionDir, this.#platform === 'win32' ? 'provider-cli.exe' : 'provider-cli')
    const previous = await this.readPointer(pointerPath(this.#rootDir, providerId))
    const previousRollback = await this.readPointer(rollbackPath(this.#rootDir, providerId))
    await fs.mkdir(versionDir, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.partial`
    try {
      await fs.copyFile(artifactPath, temporary)
      if ((await sha256File(temporary)) !== entry.sha256) throw new Error('CLI artifact changed during installation')
      await fs.rename(temporary, target)
      if (previous) await this.writePointer(rollbackPath(this.#rootDir, providerId), previous)
      await this.writePointer(pointerPath(this.#rootDir, providerId), {
        providerId, version: entry.version, artifactPath: target, sha256: entry.sha256, installedAt: this.#now().toISOString(),
      })
    } catch (error) {
      await fs.rm(temporary, { force: true })
      if (previousRollback) await this.writePointer(rollbackPath(this.#rootDir, providerId), previousRollback)
      else await fs.rm(rollbackPath(this.#rootDir, providerId), { force: true })
      throw error
    }
    return this.status(providerId)
  }

  public async rollback(providerId: CliProviderId): Promise<CliLifecycleStatus> {
    if (this.#hasActiveTasks(providerId)) throw new Error('Cannot roll back a CLI while provider tasks are active')
    const previous = await this.readPointer(rollbackPath(this.#rootDir, providerId))
    if (!previous) throw new Error('No verified CLI rollback slot is available')
    if ((await sha256File(previous.artifactPath)) !== previous.sha256) throw new Error('CLI rollback artifact integrity verification failed')
    await this.writePointer(pointerPath(this.#rootDir, providerId), previous)
    return this.status(providerId)
  }

  private entry(providerId: CliProviderId): CliReleaseEntry {
    const entry = this.#manifest.entries.find((candidate) => candidate.providerId === providerId && candidate.platform === this.#platform && candidate.architecture === this.#architecture)
    if (!entry) throw new Error(`No signed CLI release exists for ${providerId}/${this.#platform}/${this.#architecture}`)
    return entry
  }

  private async readPointer(filePath: string): Promise<InstalledPointer | null> {
    try {
      const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<InstalledPointer>
      if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.version !== 'string' || typeof value.artifactPath !== 'string' || !SHA256.test(value.sha256 || '') || typeof value.installedAt !== 'string') return null
      return value as InstalledPointer
    } catch { return null }
  }

  private async writePointer(filePath: string, pointer: InstalledPointer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporary = `${filePath}.${randomUUID()}.partial`
    await fs.writeFile(temporary, `${JSON.stringify(pointer)}\n`, { mode: 0o600 })
    await fs.rename(temporary, filePath)
  }
}
