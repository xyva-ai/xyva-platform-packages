import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WindowsSecureStoreRoot { readonly __nativeRoot: unique symbol }

export interface WindowsSecureStoreAddon {
  openTrustedRoot(rootPath: string): WindowsSecureStoreRoot
  ensureTrustedRoot(rootPath: string): WindowsSecureStoreRoot
  openPrivateDirectory(root: WindowsSecureStoreRoot, leaf: string): WindowsSecureStoreRoot
  createPrivateFile(root: WindowsSecureStoreRoot, leaf: string, content: Buffer): void
  createPrivateDirectory(root: WindowsSecureStoreRoot, leaf: string): void
  readPrivateFile(root: WindowsSecureStoreRoot, leaf: string): Buffer
  replacePrivateFile(root: WindowsSecureStoreRoot, temporaryLeaf: string, targetLeaf: string): void
  deletePrivateFile(root: WindowsSecureStoreRoot, leaf: string): void
}

let loaded: WindowsSecureStoreAddon | undefined

/** Load only a package-owned binary; no PATH, environment, or JS fallback exists. */
export function loadWindowsSecureStore(): WindowsSecureStoreAddon {
  if (process.platform !== 'win32') throw Object.assign(new Error('Windows native secure store is unavailable on this platform.'), { code: 'XYVA_UNSUPPORTED_PLATFORM' })
  if (process.arch !== 'x64') throw Object.assign(new Error('Windows native secure store is unsupported on this architecture.'), { code: 'XYVA_UNSUPPORTED_ARCH' })
  if (loaded) return loaded

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packagedBinary = path.join(moduleDirectory, 'native', 'win32-x64', 'xyva_windows_secure_store.node')
  const developmentBinary = path.resolve(moduleDirectory, '..', 'native', 'windows-secure-store', 'build', 'Release', 'xyva_windows_secure_store.node')
  const binary = fs.existsSync(packagedBinary) ? packagedBinary : developmentBinary
  if (!fs.existsSync(binary)) throw Object.assign(new Error('Windows native secure-store binary is missing.'), { code: 'XYVA_NATIVE_ADAPTER_MISSING' })

  const require = createRequire(import.meta.url)
  loaded = require(binary) as WindowsSecureStoreAddon
  return loaded
}
