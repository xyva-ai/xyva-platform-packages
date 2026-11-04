// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CliLifecycleManager, sha256File, validateCliReleaseManifest, type CliReleaseManifest } from '../../packages/agent/src/providers/cli-lifecycle.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xyva-cli-lifecycle-'))
  roots.push(root)
  return root
}

function manifestFor(hash: string, version = '1.2.3'): CliReleaseManifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    entries: [{
      providerId: 'codex', platform: process.platform as 'darwin' | 'linux' | 'win32', architecture: process.arch,
      version, artifactUrl: 'https://downloads.example.invalid/codex', sha256: hash,
      signature: 'test-signature', publicKeyId: 'test-key',
    }],
  }
}

async function artifact(root: string, contents: string, name = 'artifact.bin'): Promise<{ file: string; hash: string }> {
  const file = path.join(root, name)
  await fs.writeFile(file, contents)
  const hash = createHash('sha256').update(contents).digest('hex')
  return { file, hash }
}

describe('managed CLI lifecycle', () => {
  it('fails closed for unsigned, expired, malformed, or non-HTTPS manifests', () => {
    expect(() => validateCliReleaseManifest({ schemaVersion: 1, generatedAt: '2026-01-01', expiresAt: '2025-01-01', entries: [] })).toThrow()
    expect(() => validateCliReleaseManifest({ ...manifestFor('0'.repeat(64)), entries: [{ ...manifestFor('0'.repeat(64)).entries[0], artifactUrl: 'http://bad' }] })).toThrow()
  })

  it('installs only after signature, hash, consent, and no-active-task checks, then reports verified state', async () => {
    const root = await fixtureRoot()
    const source = await artifact(root, 'synthetic-cli-v1')
    const manager = new CliLifecycleManager(manifestFor(source.hash), {
      rootDir: path.join(root, 'managed'),
      verifyManifestSignature: () => true,
      requireConsent: () => true,
    })
    await expect(manager.install('codex', source.file)).resolves.toMatchObject({ currentVersion: '1.2.3', integrityStatus: 'verified', rollbackAvailable: false })
    const status = await manager.status('codex')
    expect(status.integrityStatus).toBe('verified')
    expect(status.installationPath).toContain(path.join('managed', 'codex', '1.2.3'))
  })

  it('creates a rollback slot atomically and restores the previous verified artifact', async () => {
    const root = await fixtureRoot()
    const first = await artifact(root, 'first', 'first.bin')
    const second = await artifact(root, 'second', 'second.bin')
    const manager = new CliLifecycleManager(manifestFor(first.hash, '1.2.3'), { rootDir: path.join(root, 'managed'), verifyManifestSignature: () => true, requireConsent: () => true })
    await manager.install('codex', first.file)
    const next = new CliLifecycleManager(manifestFor(second.hash, '2.0.0'), { rootDir: path.join(root, 'managed'), verifyManifestSignature: () => true, requireConsent: () => true })
    await next.install('codex', second.file)
    expect((await next.status('codex')).rollbackAvailable).toBe(true)
    await expect(next.rollback('codex')).resolves.toMatchObject({ currentVersion: '1.2.3', integrityStatus: 'verified' })
  })

  it('rejects updates without explicit signature, consent, or with active tasks and never creates current state', async () => {
    const root = await fixtureRoot()
    const source = await artifact(root, 'synthetic')
    const unsigned = new CliLifecycleManager(manifestFor(source.hash), { rootDir: path.join(root, 'unsigned') })
    await expect(unsigned.install('codex', source.file)).rejects.toThrow('signature')
    const denied = new CliLifecycleManager(manifestFor(source.hash), { rootDir: path.join(root, 'denied'), verifyManifestSignature: () => true, requireConsent: () => false })
    await expect(denied.install('codex', source.file)).rejects.toThrow('consent')
    const busy = new CliLifecycleManager(manifestFor(source.hash), { rootDir: path.join(root, 'busy'), verifyManifestSignature: () => true, requireConsent: () => true, hasActiveTasks: () => true })
    await expect(busy.install('codex', source.file)).rejects.toThrow('active')
  })

  it('detects artifact tampering through the bound hash', async () => {
    const root = await fixtureRoot()
    const source = await artifact(root, 'original')
    await fs.writeFile(source.file, 'tampered')
    const manager = new CliLifecycleManager(manifestFor(source.hash), { rootDir: path.join(root, 'managed'), verifyManifestSignature: () => true, requireConsent: () => true })
    await expect(manager.install('codex', source.file)).rejects.toThrow('integrity')
    expect(await sha256File(source.file)).not.toBe(source.hash)
  })
})
