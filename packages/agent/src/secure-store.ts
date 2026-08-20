import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getAgentDataRoot } from './utils/platform.js'

const SEALED_PREFIX = 'sealed:v1:'
const MASTER_KEY_BYTES = 32

function getMasterKeyPath(): string {
  return path.join(getSecureDataRoot(), 'secret-store.key')
}

function getSecureDataRoot(): string {
  return getAgentDataRoot()
}

function enforcePrivatePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ACLs are enforced by the current user profile; chmod is best-effort there.
  }
}

function readMasterKey(): Buffer | null {
  try {
    const raw = fs.readFileSync(getMasterKeyPath(), 'utf8').trim()
    const decoded = Buffer.from(raw, 'base64url')
    return decoded.length === MASTER_KEY_BYTES ? decoded : null
  } catch {
    return null
  }
}

function createMasterKey(): Buffer {
  const directory = getSecureDataRoot()
  const filePath = getMasterKeyPath()
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

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

    const existing = readMasterKey()
    if (!existing) {
      throw new Error('The xyva secret-store key is unreadable or invalid.')
    }
    return existing
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
    return null
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
  } catch {
    return null
  }
}

export function writePrivateFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
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
