import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

type LockPackage = {
  version?: string
  resolved?: string
  integrity?: string
}

type PackageLock = {
  packages: Record<string, LockPackage>
}

const repoRoot = process.cwd()
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { overrides?: Record<string, string> }
const lockfile = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
) as PackageLock

describe('agent production dependency security contract', () => {
  it('pins the patched body parser used by the local Express server', () => {
    expect(manifest.overrides?.['body-parser']).toBe('2.3.0')
    expect(lockfile.packages['node_modules/body-parser']).toMatchObject({
      version: '2.3.0',
      resolved: 'https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz',
      integrity: 'sha512-2cGmJupaNgg+QUwVLAucDuWuoMZ6EX9iHDRswZ5lsNYEmwPaRknMPCLZz07yTzVq/83p4o/wzbDZbBrTvGGTIw==',
    })
  })
})
