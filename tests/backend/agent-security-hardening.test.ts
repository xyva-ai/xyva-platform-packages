// @vitest-environment node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadCredentials, saveCredentials } from '../../packages/agent/src/auth'
import { loadConfig, saveConfig, updateConfig } from '../../packages/agent/src/config'
import { checkLicenseGuard, createMachineId, validateLicense } from '../../packages/agent/src/license'
import { AgentSwarmCredentialStore } from '../../packages/agent/src/services/swarm/credential-store'
import { AgentFsService } from '../../packages/agent/src/services/fs-service'
import { AgentGitService } from '../../packages/agent/src/services/git-service'
import { AgentProjectRegistryService } from '../../packages/agent/src/services/project-registry-service'
import { AgentReportService } from '../../packages/agent/src/services/report-service'
import { AgentRunnerService, runnerSecurityInternals } from '../../packages/agent/src/services/runner-service'
import { readPrivateFile, writePrivateFile } from '../../packages/agent/src/secure-store'
import { SecurityGuard } from '../../packages/agent/src/utils/SecurityGuard'
import { getAgentDataRoot } from '../../packages/agent/src/utils/platform'

const { privateKey: testPrivateKey, publicKey: testPublicKey } = crypto.generateKeyPairSync('ed25519')

const originalEnvironment = {
  home: process.env.HOME,
  nodeEnv: process.env.NODE_ENV,
  publicKey: process.env.XYVA_LICENSE_TEST_PUBLIC_KEY,
  stateDir: process.env.XYVA_AGENT_STATE_DIR,
  userProfile: process.env.USERPROFILE,
}

let temporaryHome = ''

function xyvaPath(...parts: string[]) {
  return path.join(temporaryHome, '.xyva', ...parts)
}

function fileMode(filePath: string) {
  return fs.statSync(filePath).mode & 0o777
}

function expectPrivateFileProtection(filePath: string): void {
  if (process.platform === 'win32') {
    expect(() => readPrivateFile(filePath)).not.toThrow()
    return
  }
  expect(fileMode(filePath)).toBe(0o600)
}

function signLicense(machineId: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'xyva-test', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    aud: 'xyva-agent',
    iss: 'http://localhost:3000',
    sub: 'user-test',
    tier: 'solo',
    machineId,
    seats: 1,
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
    ...overrides,
  })).toString('base64url')
  const unsigned = `${header}.${claims}`
  const signature = crypto.sign(null, Buffer.from(unsigned), testPrivateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

function writeLicense(token: string, machineId: string, overrides: Record<string, unknown> = {}) {
  writePrivateFile(xyvaPath('license.json'), JSON.stringify({
    version: 2,
    source: 'jwt',
    token,
    tier: 'enterprise',
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    lastValidated: Date.now(),
    offlineSince: null,
    machineId,
    portalUrl: 'http://localhost:3000',
    ...overrides,
  }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true })
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-agent-security-'))
  process.env.HOME = temporaryHome
  process.env.USERPROFILE = temporaryHome
  process.env.NODE_ENV = 'test'
  process.env.XYVA_LICENSE_TEST_PUBLIC_KEY = testPublicKey.export({ type: 'spki', format: 'pem' }).toString()
  delete process.env.XYVA_AGENT_STATE_DIR
  SecurityGuard.resetApprovedProjectRoots()
})

afterAll(() => {
  if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true })
  for (const [name, value] of Object.entries({
    HOME: originalEnvironment.home,
    NODE_ENV: originalEnvironment.nodeEnv,
    USERPROFILE: originalEnvironment.userProfile,
    XYVA_AGENT_STATE_DIR: originalEnvironment.stateDir,
    XYVA_LICENSE_TEST_PUBLIC_KEY: originalEnvironment.publicKey,
  })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('agent secret storage', () => {
  it('isolates disposable agent state without changing HOME and rejects broad overrides', () => {
    const isolatedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-agent-state-'))
    const isolatedState = path.join(isolatedParent, 'state')
    process.env.XYVA_AGENT_STATE_DIR = isolatedState

    saveCredentials({
      token: 'isolated-portal-secret',
      email: 'isolated@example.test',
      expiresAt: Date.now() + 60_000,
      portalUrl: 'https://xyva.ai',
    })

    expect(getAgentDataRoot()).toBe(isolatedState)
    expect(fs.existsSync(path.join(isolatedState, 'credentials.json'))).toBe(true)
    expect(fs.existsSync(xyvaPath('credentials.json'))).toBe(false)
    const homeFixture = xyvaPath('fixture.json')
    delete process.env.XYVA_AGENT_STATE_DIR
    writePrivateFile(homeFixture, 'synthetic')
    fs.rmSync(homeFixture)
    process.env.XYVA_AGENT_STATE_DIR = isolatedState
    expect(() => SecurityGuard.approveProjectRoot(xyvaPath())).toThrow(/protected/i)
    expect(SecurityGuard.isPathSafe(xyvaPath('credentials.json'))).toBe(false)

    process.env.XYVA_AGENT_STATE_DIR = path.parse(isolatedState).root
    expect(() => getAgentDataRoot()).toThrow(/must not target/i)
    process.env.XYVA_AGENT_STATE_DIR = temporaryHome
    expect(() => getAgentDataRoot()).toThrow(/must not target/i)
    fs.rmSync(isolatedParent, { recursive: true, force: true })
  })

  it('seals config and portal credentials with private file permissions', () => {
    saveConfig({
      aiProvider: 'gemini',
      aiApiKeys: { gemini: 'ai-secret-value' },
      aiDefaultModels: { gemini: 'gemini-2.5-flash' },
      flowProviderGrants: [],
      gitlabToken: 'gitlab-secret-value',
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })
    saveCredentials({
      token: 'portal-bearer-secret',
      email: 'qa@example.test',
      expiresAt: Date.now() + 60_000,
      portalUrl: 'https://xyva.ai',
    })

    const rawConfig = fs.readFileSync(xyvaPath('config.json'), 'utf8')
    const rawCredentials = fs.readFileSync(xyvaPath('credentials.json'), 'utf8')
    expect(rawConfig).not.toContain('ai-secret-value')
    expect(rawConfig).not.toContain('gitlab-secret-value')
    expect(rawCredentials).not.toContain('portal-bearer-secret')
    expect(loadConfig().aiApiKeys.gemini).toBe('ai-secret-value')
    expect(loadCredentials()?.token).toBe('portal-bearer-secret')
    expectPrivateFileProtection(xyvaPath('config.json'))
    expectPrivateFileProtection(xyvaPath('credentials.json'))
    expectPrivateFileProtection(xyvaPath('secret-store.key'))
  })

  it('encrypts swarm passwords and migrates plaintext v1 files', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-project-'))
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    SecurityGuard.approveProjectRoot(projectPath)
    const store = new AgentSwarmCredentialStore()
    await store.save(projectPath, { username: 'qa-user', password: 'swarm-secret-value' })

    const credentialsDirectory = xyvaPath('swarm-credentials')
    const filePath = path.join(credentialsDirectory, fs.readdirSync(credentialsDirectory)[0])
    const encrypted = fs.readFileSync(filePath, 'utf8')
    expect(encrypted).not.toContain('swarm-secret-value')
    expect(await store.loadPassword(projectPath)).toBe('swarm-secret-value')
    expectPrivateFileProtection(filePath)

    const legacy = JSON.parse(encrypted)
    writePrivateFile(filePath, JSON.stringify({
      ...legacy,
      version: 1,
      password: 'legacy-plaintext-password',
    }))
    expect(await store.loadPassword(projectPath)).toBe('legacy-plaintext-password')
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('legacy-plaintext-password')
    expectPrivateFileProtection(filePath)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  it('never overwrites sealed swarm credentials when the master key is missing', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-project-'))
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    SecurityGuard.approveProjectRoot(projectPath)
    const store = new AgentSwarmCredentialStore()
    await store.save(projectPath, { username: 'qa-user', password: 'first-synthetic-password' })

    const credentialsDirectory = xyvaPath('swarm-credentials')
    const filePath = path.join(credentialsDirectory, fs.readdirSync(credentialsDirectory)[0])
    const before = fs.readFileSync(filePath, 'utf8')
    fs.rmSync(xyvaPath('secret-store.key'))

    await expect(store.save(projectPath, { username: 'qa-user', password: 'second-synthetic-password' }))
      .rejects.toThrow(/key is missing/i)
    expect(fs.existsSync(xyvaPath('secret-store.key'))).toBe(false)
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  it('does not create a new master key when only swarm data remains', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-project-'))
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    SecurityGuard.approveProjectRoot(projectPath)
    const store = new AgentSwarmCredentialStore()
    await store.save(projectPath, { username: 'qa-user', password: 'swarm-only-password' })

    const swarmDirectory = xyvaPath('swarm-credentials')
    const swarmPath = path.join(swarmDirectory, fs.readdirSync(swarmDirectory)[0])
    const before = fs.readFileSync(swarmPath, 'utf8')
    fs.rmSync(xyvaPath('secret-store.key'))

    expect(() => saveConfig({
      aiProvider: 'openai',
      aiApiKeys: { openai: 'new-synthetic-api-key' },
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: [],
      gitlabToken: null,
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })).toThrow(/swarm data|sealed data|key is missing/i)
    expect(fs.existsSync(xyvaPath('secret-store.key'))).toBe(false)
    expect(fs.readFileSync(swarmPath, 'utf8')).toBe(before)
    expect(fs.existsSync(xyvaPath('config.json'))).toBe(false)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  it('never replaces an invalid existing master key', () => {
    const keyPath = xyvaPath('secret-store.key')
    writePrivateFile(keyPath, 'not-a-valid-master-key')

    expect(() => saveCredentials({
      token: 'synthetic-token',
      email: 'qa@example.test',
      expiresAt: Date.now() + 60_000,
      portalUrl: 'https://xyva.ai',
    })).toThrow(/key is invalid/i)
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('not-a-valid-master-key')
    expect(fs.existsSync(xyvaPath('credentials.json'))).toBe(false)
  })

  it('enforces the platform-specific private-key protection without repairing it', () => {
    saveCredentials({
      token: 'first-synthetic-token',
      email: 'qa@example.test',
      expiresAt: Date.now() + 60_000,
      portalUrl: 'https://xyva.ai',
    })
    const keyPath = xyvaPath('secret-store.key')
    const before = fs.readFileSync(keyPath, 'utf8')
    if (process.platform === 'win32') {
      // Native DACL-rejection is exercised by agent-windows-secure-store.test.ts
      // in this same Windows workflow. Here the generic key lifecycle must not
      // rely on meaningless POSIX mode bits.
      expectPrivateFileProtection(keyPath)
      expect(fs.readFileSync(keyPath, 'utf8')).toBe(before)
      return
    }
    fs.chmodSync(keyPath, 0o644)

    expect(() => saveCredentials({
      token: 'second-synthetic-token',
      email: 'qa@example.test',
      expiresAt: Date.now() + 60_000,
      portalUrl: 'https://xyva.ai',
    })).toThrow(/permissions are not restrictive/i)
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(before)
    expect(fileMode(keyPath)).toBe(0o644)
  })

  it('refuses corrupt sealed configuration without replacing it with defaults', () => {
    saveConfig({
      aiProvider: 'openai',
      aiApiKeys: { openai: 'synthetic-api-key' },
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: [],
      gitlabToken: null,
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })
    const configPath = xyvaPath('config.json')
    const corrupted = JSON.stringify({
      ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
      aiApiKeys: { openai: 'sealed:v1:invalid.invalid.invalid' },
    })
    writePrivateFile(configPath, corrupted)

    expect(() => loadConfig()).toThrow(/cannot be decrypted/i)
    expect(() => updateConfig({ port: 7901 })).toThrow(/cannot be decrypted/i)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(corrupted)
  })

  it('never creates a replacement master key for existing sealed data', () => {
    saveConfig({
      aiProvider: 'openai',
      aiApiKeys: { openai: 'synthetic-api-key' },
      aiDefaultModels: { openai: 'gpt-5' },
      flowProviderGrants: [],
      gitlabToken: null,
      githubToken: null,
      youtrackToken: null,
      port: 7900,
    })
    const keyPath = xyvaPath('secret-store.key')
    const configPath = xyvaPath('config.json')
    const before = fs.readFileSync(configPath, 'utf8')
    fs.rmSync(keyPath)

    expect(() => loadConfig()).toThrow(/key is missing/i)
    expect(fs.existsSync(keyPath)).toBe(false)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })
})

describe('agent license integrity', () => {
  it('uses a persisted installation id instead of volatile network interfaces', () => {
    const first = createMachineId()
    const second = createMachineId()
    expect(second).toBe(first)
    expect(JSON.parse(fs.readFileSync(xyvaPath('machine-id.json'), 'utf8')).machineId).toBe(first)
    expectPrivateFileProtection(xyvaPath('machine-id.json'))
  })

  it('trusts signed claims rather than editable license metadata', () => {
    const machineId = createMachineId()
    writeLicense(signLicense(machineId), machineId)

    expect(checkLicenseGuard()).toMatchObject({
      allowed: true,
      source: 'jwt',
      tier: 'solo',
    })
  })

  it('fails closed when the signed token is modified or the heartbeat is overdue', () => {
    const machineId = createMachineId()
    const token = signLicense(machineId)
    const [header, payload, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, tier: 'enterprise' })).toString('base64url')
    writeLicense(`${header}.${tamperedPayload}.${signature}`, machineId)
    expect(checkLicenseGuard()).toMatchObject({ allowed: false, source: 'jwt' })

    writeLicense(token, machineId, {
      lastValidated: Date.now() - 73 * 60 * 60 * 1000,
      offlineSince: null,
    })
    expect(checkLicenseGuard()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('heartbeat overdue'),
    })
  })

  it('fails closed on an explicit portal denial instead of entering offline grace', async () => {
    const machineId = createMachineId()
    writeLicense(signLicense(machineId), machineId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Subscription revoked' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )))

    const state = await validateLicense({ portalUrl: 'http://localhost:3000', token: 'agent-api-token' })
    expect(state).toMatchObject({ tier: null, expiresAt: 0, offlineSince: null })
    expect(checkLicenseGuard()).toMatchObject({ allowed: false, source: 'missing' })
  })

  it('uses bounded offline grace only for transport failures', async () => {
    const machineId = createMachineId()
    writeLicense(signLicense(machineId), machineId)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))

    const state = await validateLicense({ portalUrl: 'http://localhost:3000', token: 'agent-api-token' })
    expect(state.tier).toBe('solo')
    expect(state.offlineSince).toEqual(expect.any(Number))
    expect(checkLicenseGuard()).toMatchObject({ allowed: true, tier: 'solo' })
  })

  it('migrates an unverifiable v1 JWT only through a verified online refresh', async () => {
    const machineId = createMachineId()
    writePrivateFile(xyvaPath('license.json'), JSON.stringify({
      version: 1,
      source: 'jwt',
      token: 'legacy.hmac.token',
      tier: 'enterprise',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      lastValidated: Date.now(),
      offlineSince: null,
      machineId,
    }))

    expect(checkLicenseGuard()).toMatchObject({ allowed: false })
    const refreshedToken = signLicense(machineId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ token: refreshedToken, expiresAt: Date.now() + 60_000 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    const migrated = await validateLicense({ portalUrl: 'http://localhost:3000', token: 'agent-api-token' })
    expect(migrated.tier).toBe('solo')
    expect(checkLicenseGuard()).toMatchObject({ allowed: true, tier: 'solo' })
    expect(JSON.parse(fs.readFileSync(xyvaPath('license.json'), 'utf8'))).toMatchObject({
      version: 2,
      portalUrl: 'http://localhost:3000',
      token: refreshedToken,
    })
  })

  it('never accepts a locally forged legacy key even when NODE_ENV is unset', () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousSecret = process.env.LICENSE_SECRET
    delete process.env.NODE_ENV
    process.env.LICENSE_SECRET = 'attacker-controlled-secret'
    try {
      const data = Buffer.from(JSON.stringify({
        tier: 'enterprise',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })).toString('base64url')
      const signature = crypto.createHmac('sha256', 'attacker-controlled-secret').update(data).digest('base64url')
      writePrivateFile(xyvaPath('license.json'), JSON.stringify(`XYVA-${data}.${signature}`))

      expect(checkLicenseGuard()).toMatchObject({
        allowed: false,
        source: 'legacy',
        reason: expect.stringContaining('online migration'),
      })
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousSecret === undefined) delete process.env.LICENSE_SECRET
      else process.env.LICENSE_SECRET = previousSecret
    }
  })
})

describe('approved project filesystem boundary', () => {
  it('does not approve or inspect arbitrary system paths', async () => {
    const registry = new AgentProjectRegistryService()
    await expect(registry.getProjectInfo('/etc')).rejects.toThrow(/not approved/i)
    await expect(registry.addProject('/etc')).rejects.toThrow()
    expect(SecurityGuard.isPathSafe('/etc/passwd')).toBe(false)
    expect(() => SecurityGuard.approveProjectRoot(os.tmpdir())).toThrow(/broad|protected/i)
  })

  it('approves only validated canonical projects and blocks symlink escapes and agent secrets', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-approved-project-'))
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-approved-outside-'))
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    fs.writeFileSync(path.join(projectPath, 'safe.txt'), 'safe-project-content')
    fs.writeFileSync(path.join(outsidePath, 'outside.txt'), 'outside-project-content')
    fs.symlinkSync(outsidePath, path.join(projectPath, 'escape'))

    const registry = new AgentProjectRegistryService()
    const approved = await registry.addProject(projectPath)
    expect(approved.path).toBe(SecurityGuard.canonicalizePath(projectPath))

    const fsService = new AgentFsService()
    await expect(fsService.readFile(path.join(projectPath, 'safe.txt'))).resolves.toBe('safe-project-content')
    await expect(fsService.readFile(path.join(projectPath, 'escape', 'outside.txt'))).rejects.toThrow(/Invalid path|Unauthorized/i)

    writePrivateFile(xyvaPath('credentials.json'), 'agent-secret')
    await expect(fsService.readFile(xyvaPath('credentials.json'))).rejects.toThrow(/Invalid path|Unauthorized/i)
    fs.rmSync(outsidePath, { recursive: true, force: true })
  })

  it('rejects a project whose Playwright config is a symlink outside the candidate root', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-symlink-project-'))
    const outsidePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-symlink-outside-')), 'playwright.config.ts')
    fs.writeFileSync(outsidePath, 'export default {}')
    fs.symlinkSync(outsidePath, path.join(projectPath, 'playwright.config.ts'))
    const registry = new AgentProjectRegistryService()

    await expect(registry.addProject(projectPath)).rejects.toThrow(/No Playwright config/i)
    expect(SecurityGuard.isApprovedProjectRoot(projectPath)).toBe(false)
  })

  it('rejects report ingestion through a symlink outside the approved project', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-report-project-'))
    const outsidePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-report-outside-')), 'report.json')
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    fs.writeFileSync(outsidePath, '{}')
    fs.symlinkSync(outsidePath, path.join(projectPath, 'report.json'))
    SecurityGuard.approveProjectRoot(projectPath)

    const service = new AgentReportService({ historyPath: path.join(temporaryHome, 'report-history.json') })
    await expect(service.ingest(projectPath, 'report.json')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/escapes root|escapes project root/i),
    })
  })
})

describe('agent runner command boundary', () => {
  function createApprovedProject() {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-runner-project-'))
    fs.mkdirSync(path.join(projectPath, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), "export default { projects: [{ name: 'chromium' }] }")
    fs.writeFileSync(path.join(projectPath, 'tests', 'safe.spec.ts'), "test('safe', async () => {})")
    SecurityGuard.approveProjectRoot(projectPath)
    return projectPath
  }

  function request(projectPath: string) {
    return {
      projectPath,
      projectType: 'playwright' as const,
      runMode: 'name' as const,
      testName: 'safe test',
      headless: true,
      debug: false,
      parallel: 1,
      browser: null,
      trace: 'retain-on-failure' as const,
    }
  }

  it.each([
    'safe & calc.exe',
    'safe | whoami',
    '%COMSPEC%',
    '"quoted command"',
  ])('treats shell metacharacters as literal argv content without breaking valid Playwright titles: %s', (testName) => {
    expect(runnerSecurityInternals.isSafeTestName(testName)).toBe(true)
  })

  it.each(['line\nbreak', 'nul\0byte', 'x'.repeat(301)])('rejects unsafe test-name log/control input before process creation', async (testName) => {
    const projectPath = createApprovedProject()
    const result = await new AgentRunnerService().runTests({ ...request(projectPath), testName })

    expect(result).toMatchObject({ ok: false, blocked: true, classification: 'invalid-configuration' })
    expect(result.reason).toMatch(/test name/i)
  })

  it.each([
    { parallel: 0 },
    { parallel: 33 },
    { parallel: 1.5 },
    { trace: 'shell-command' },
    { browser: 'chromium & calc.exe' },
    { environment: 'production; whoami' },
  ])('fails closed for invalid bounded runner options: %j', async (override) => {
    const projectPath = createApprovedProject()
    const result = await new AgentRunnerService().runTests({ ...request(projectPath), ...override } as never)

    expect(result).toMatchObject({ ok: false, blocked: true, classification: 'invalid-configuration' })
  })

  it.each(['/etc/passwd', '../outside.spec.ts', 'C:/Windows/System32/calc.spec.ts'])('rejects non-relative selected test paths: %s', async (testFile) => {
    const projectPath = createApprovedProject()
    const result = await new AgentRunnerService().runTests({
      ...request(projectPath),
      runMode: 'file',
      testName: null,
      testFile,
    })

    expect(result).toMatchObject({ ok: false, blocked: true, classification: 'invalid-configuration' })
    expect(result.reason).toMatch(/relative file/i)
  })

  it('rejects a selected test file that escapes through a symlink', async () => {
    const projectPath = createApprovedProject()
    const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-runner-outside-')), 'escape.spec.ts')
    fs.writeFileSync(outsideFile, 'export {}')
    fs.symlinkSync(outsideFile, path.join(projectPath, 'tests', 'escape.spec.ts'))

    const result = await new AgentRunnerService().runTests({
      ...request(projectPath),
      runMode: 'file',
      testName: null,
      testFile: 'tests/escape.spec.ts',
    })

    expect(result).toMatchObject({ ok: false, blocked: true, classification: 'invalid-configuration' })
  })

  it('drops process-control env overrides even when the caller claims they are required', () => {
    const requested = {
      API_TOKEN: 'secret',
      PATH: '/attacker/bin',
      Path: 'C:\\attacker',
      PATHEXT: '.EVIL',
      NODE_OPTIONS: '--require attacker.js',
      NODE_PATH: '/attacker/modules',
      COMSPEC: 'calc.exe',
      SHELL: '/tmp/evil-shell',
      HOME: '/tmp/evil-home',
      USERPROFILE: 'C:\\attacker',
      INIT_CWD: '/tmp/attacker',
      NPM_CONFIG_USERCONFIG: '/tmp/evil-npmrc',
      npm_config_prefix: '/tmp/evil-prefix',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp/evil-lib',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp/evil-lib',
      BASH_ENV: '/tmp/evil-bashrc',
      ENV: '/tmp/evil-shrc',
      IFS: '/',
      CDPATH: '/tmp',
      PYTHONPATH: '/tmp/evil-python',
    }

    expect(runnerSecurityInternals.sanitizeRequestedEnvOverrides(requested, Object.keys(requested))).toEqual({
      API_TOKEN: 'secret',
    })
  })

  it('keeps the runner spawn contract shell-free', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'packages/agent/src/services/runner-service.ts'), 'utf8')
    expect(source).toContain('shell: false')
    expect(source).not.toMatch(/spawn\([^)]*\{[^}]*shell:\s*true/s)
  })
})

describe('agent git argument boundary', () => {
  it.each(['--help', '-c', 'release/../main', 'topic.lock', 'topic@{1}', 'topic;whoami'])('rejects option-like or invalid branch names before invoking Git: %s', async (branchName) => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-git-project-'))
    fs.writeFileSync(path.join(projectPath, 'playwright.config.ts'), 'export default {}')
    SecurityGuard.approveProjectRoot(projectPath)

    await expect(new AgentGitService({ gitBinary: '/definitely/not/invoked' }).createBranch(projectPath, branchName)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid branch name/i),
    })
  })

  it('validates GitLab tokens only against the fixed HTTPS endpoint with bounded redirects and time', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: 'safe-user' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new AgentGitService().validateGitLabToken('stored-token')).resolves.toEqual({
      ok: true,
      user: 'safe-user',
    })
    expect(fetchMock).toHaveBeenCalledWith('https://gitlab.com/api/v4/user', expect.objectContaining({
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'stored-token' }),
    }))
  })

  it('fails closed for oversized or exceptional GitLab responses without reflecting details', async () => {
    const service = new AgentGitService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', {
      status: 200,
      headers: { 'content-length': String(64 * 1024 + 1) },
    })).mockRejectedValueOnce(new Error('sensitive upstream detail')))

    await expect(service.validateGitLabToken('stored-token')).resolves.toEqual({
      ok: false,
      error: 'GitLab token validation failed.',
    })
    await expect(service.validateGitLabToken('stored-token')).resolves.toEqual({
      ok: false,
      error: 'GitLab token validation failed.',
    })
  })
})
