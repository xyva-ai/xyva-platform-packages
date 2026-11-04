import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')

describe('published browser package hygiene', () => {
  it('ships browser-only output without embedded credentials, product methods or endpoints', () => {
    const output = readFileSync(resolve(packageRoot, 'dist/index.js'), 'utf8')
    expect(output).not.toMatch(/(?:from\s+|import\s*\()["']node:/)
    expect(output).not.toMatch(/\brequire\s*\(/)
    expect(output).not.toMatch(/@xyva\/(?:bridge-types|contracts)/)
    expect(output).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/)
    expect(output).not.toMatch(/\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})\b/)
    expect(output).not.toContain('aiChat')
    expect(output).not.toContain('aiCancel')
    expect(output).not.toContain('providerInferV1')
    expect(output).not.toMatch(/(?:127\.0\.0\.1|localhost):\d+/)
  })

  it('includes the Apache license, notice, readme and built entry in the tarball', () => {
    // Prefer npm's own node entrypoint. Directly spawning npm.cmd from Node can
    // return EINVAL on hosted Windows runners; the fallback is a fixed command
    // with no user-controlled shell input.
    const npmExecPath = process.env.npm_execpath
    const npmExecutable = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    const npmArgs = npmExecPath ? [npmExecPath, 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json']
    const result = execFileSync(npmExecutable, npmArgs, {
      cwd: packageRoot,
      encoding: 'utf8',
      ...(process.platform === 'win32' && !npmExecPath ? { shell: true } : {}),
    })
    const [pack] = JSON.parse(result) as Array<{ files: Array<{ path: string }> }>
    const files = pack.files.map((file) => file.path)
    expect(files).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE', 'README.md', 'dist/index.js', 'dist/index.d.ts']))
  })
})
