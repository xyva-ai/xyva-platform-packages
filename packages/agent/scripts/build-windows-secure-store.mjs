import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = path.join(agentRoot, 'native', 'windows-secure-store')

if (process.platform !== 'win32') process.exit(0)
if (process.arch !== 'x64') throw new Error('XYVA_WINDOWS_NATIVE_STORE_UNSUPPORTED_ARCH')

const require = createRequire(path.join(agentRoot, 'package.json'))
let nodeGyp
try {
  nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
} catch {
  throw new Error('XYVA_WINDOWS_NATIVE_STORE_BUILD_TOOL_MISSING')
}

execFileSync(process.execPath, [nodeGyp, 'rebuild', '--napi_build_version=8'], {
  cwd: nativeRoot,
  stdio: 'inherit',
})

const binary = path.join(nativeRoot, 'build', 'Release', 'xyva_windows_secure_store.node')
if (!fs.existsSync(binary)) throw new Error('XYVA_WINDOWS_NATIVE_STORE_BUILD_OUTPUT_MISSING')
const destination = path.join(agentRoot, 'dist', 'native', 'win32-x64')
fs.mkdirSync(destination, { recursive: true })
fs.copyFileSync(binary, path.join(destination, 'xyva_windows_secure_store.node'))
