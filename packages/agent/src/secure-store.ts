import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getAgentDataRoot } from './utils/platform.js'
import { loadWindowsSecureStore, type WindowsSecureStoreAddon, type WindowsSecureStoreRoot } from './windows-secure-store.js'

const SEALED_PREFIX = 'sealed:v1:'
const MASTER_KEY_BYTES = 32

export type SecureStoreErrorCode =
  | 'XYVA_MASTER_KEY_INVALID'
  | 'XYVA_MASTER_KEY_UNREADABLE'
  | 'XYVA_SECRET_INVALID'
  | 'XYVA_SECRET_UNSEAL_FAILED'
  | 'XYVA_PRIVATE_PATH_UNSAFE'

export class SecureStoreError extends Error {
  readonly code: SecureStoreErrorCode

  constructor(code: SecureStoreErrorCode, message: string) {
    super(message)
    this.name = 'SecureStoreError'
    this.code = code
  }
}

function getMasterKeyPath(): string {
  return path.join(getSecureDataRoot(), 'secret-store.key')
}

function getSecureDataRoot(): string {
  return getAgentDataRoot()
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function windowsRootFor(filePath: string): { addon: WindowsSecureStoreAddon; root: WindowsSecureStoreRoot; leaf: string } {
  const dataRoot = path.resolve(getSecureDataRoot())
  const target = path.resolve(filePath)
  const relative = path.relative(dataRoot, target)
  const components = relative.split(path.sep).filter(Boolean)
  if (path.isAbsolute(relative) || components.length < 1 || components.length > 2 || components.some((component) => component === '.' || component === '..')) {
    throw new SecureStoreError('XYVA_PRIVATE_PATH_UNSAFE', 'Windows private path is outside the secure data root.')
  }
  const leaf = components.at(-1)!
  if (!leaf || leaf === '.' || leaf === '..') {
    throw new SecureStoreError('XYVA_PRIVATE_PATH_UNSAFE', 'Windows private file name is invalid.')
  }
  const addon = loadWindowsSecureStore()
  let root = addon.ensureTrustedRoot(dataRoot)
  if (components.length === 2) {
    const directory = components[0]
    try {
      root = addon.openPrivateDirectory(root, directory)
    } catch (error) {
      if (nativeErrorCode(error) !== 'XYVA_NOT_FOUND') throw error
      addon.createPrivateDirectory(root, directory)
      root = addon.openPrivateDirectory(root, directory)
    }
  }
  return { addon, root, leaf }
}

function enforcePrivatePermissions(filePath: string): void {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ACLs are enforced by the current user profile; chmod is best-effort there.
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function assertPrivatePath(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new SecureStoreError('XYVA_PRIVATE_PATH_UNSAFE', 'Private store path must not be a symbolic link.')
    }
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

function readMasterKey(): Buffer | null {
  const filePath = getMasterKeyPath()
  if (process.platform === 'win32') {
    const { addon, root, leaf } = windowsRootFor(filePath)
    let raw: string
    try {
      raw = addon.readPrivateFile(root, leaf).toString('utf8').trim()
    } catch (error) {
      if (nativeErrorCode(error) === 'XYVA_NOT_FOUND') return null
      throw new SecureStoreError('XYVA_MASTER_KEY_UNREADABLE', 'The xyva secret-store key cannot be read.')
    }
    const decoded = Buffer.from(raw, 'base64url')
    if (decoded.length !== MASTER_KEY_BYTES || decoded.toString('base64url') !== raw) {
      throw new SecureStoreError('XYVA_MASTER_KEY_INVALID', 'The xyva secret-store key is invalid.')
    }
    return decoded
  }
  assertPrivatePath(filePath)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8').trim()
  } catch (error) {
    if (isNotFound(error)) return null
    throw new SecureStoreError('XYVA_MASTER_KEY_UNREADABLE', 'The xyva secret-store key cannot be read.')
  }

  const decoded = Buffer.from(raw, 'base64url')
  if (decoded.length !== MASTER_KEY_BYTES || decoded.toString('base64url') !== raw) {
    throw new SecureStoreError('XYVA_MASTER_KEY_INVALID', 'The xyva secret-store key is invalid.')
  }
  return decoded
}

function createMasterKey(): Buffer {
  const directory = getSecureDataRoot()
  const filePath = getMasterKeyPath()
  if (process.platform === 'win32') {
    const { addon, root, leaf } = windowsRootFor(filePath)
    const key = crypto.randomBytes(MASTER_KEY_BYTES)
    try {
      addon.createPrivateFile(root, leaf, Buffer.from(key.toString('base64url'), 'utf8'))
      return key
    } catch (error) {
      if (nativeErrorCode(error) !== 'XYVA_ALREADY_EXISTS') throw error
      return readMasterKey() || (() => { throw new SecureStoreError('XYVA_MASTER_KEY_UNREADABLE', 'The xyva secret-store key disappeared during creation.') })()
    }
  }
  assertPrivatePath(directory)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivatePath(directory)

  const key = crypto.randomBytes(MASTER_KEY_BYTES)
  try {
    fs.writeFileSync(filePath, key.toString('base64url'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    enforcePrivatePermissions(filePath)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }

    return readMasterKey() || (() => { throw new SecureStoreError('XYVA_MASTER_KEY_UNREADABLE', 'The xyva secret-store key disappeared during creation.') })()
  }
}

function getMasterKey(): Buffer {
  const existing = readMasterKey()
  if (existing) {
    enforcePrivatePermissions(getMasterKeyPath())
    return existing
  }

  return createMasterKey()
}

export function isSealedSecret(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

export function sealSecret(value: string, context: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${SEALED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

export function unsealSecret(value: string, context: string): string | null {
  if (!isSealedSecret(value)) {
    return null
  }

  const parts = value.slice(SEALED_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new SecureStoreError('XYVA_SECRET_INVALID', 'Stored secret format is invalid.')
  }

  try {
    const [iv, tag, encrypted] = parts
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    if (error instanceof SecureStoreError) throw error
    throw new SecureStoreError('XYVA_SECRET_UNSEAL_FAILED', 'Stored secret cannot be decrypted.')
  }
}

export function writePrivateFile(filePath: string, content: string): void {
  if (process.platform === 'win32') {
    const { addon, root, leaf } = windowsRootFor(filePath)
    const temporaryLeaf = `.xyva-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`
    try {
      addon.createPrivateFile(root, temporaryLeaf, Buffer.from(content, 'utf8'))
      addon.replacePrivateFile(root, temporaryLeaf, leaf)
    } catch (error) {
      try { addon.deletePrivateFile(root, temporaryLeaf) } catch { /* temporary file may already have been renamed or never created */ }
      throw error
    }
    return
  }
  const directory = path.dirname(filePath)
  assertPrivatePath(directory)
  assertPrivatePath(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivatePath(directory)
  assertPrivatePath(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    enforcePrivatePermissions(temporaryPath)
    fs.renameSync(temporaryPath, filePath)
    enforcePrivatePermissions(filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true })
    }
  }
}

export function readPrivateFile(filePath: string): string | null {
  if (process.platform === 'win32') {
    const { addon, root, leaf } = windowsRootFor(filePath)
    try {
      return addon.readPrivateFile(root, leaf).toString('utf8')
    } catch (error) {
      if (nativeErrorCode(error) === 'XYVA_NOT_FOUND') return null
      throw new SecureStoreError('XYVA_SECRET_INVALID', 'Private file cannot be read safely.')
    }
  }
  assertPrivatePath(filePath)
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw new SecureStoreError('XYVA_SECRET_INVALID', 'Private file cannot be read safely.')
  }
}

export function deletePrivateFile(filePath: string): void {
  if (process.platform === 'win32') {
    const { addon, root, leaf } = windowsRootFor(filePath)
    try { addon.deletePrivateFile(root, leaf) } catch (error) {
      if (nativeErrorCode(error) !== 'XYVA_NOT_FOUND') throw error
    }
    return
  }
  assertPrivatePath(filePath)
  try { fs.rmSync(filePath, { force: true }) } catch (error) {
    throw new SecureStoreError('XYVA_SECRET_INVALID', `Private file cannot be removed safely: ${(error as Error).message}`)
  }
}
