import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const evidenceDir = path.resolve(process.env.XYVA_EVIDENCE_DIR ?? 'evidence')
fs.mkdirSync(evidenceDir, { recursive: true })

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const commitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown'
  }
})()

const files = []
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute)
    else if (entry.name !== 'staging-evidence.json') {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
      files.push({ name: path.relative(process.cwd(), absolute).replaceAll(path.sep, '/'), sha256: digest })
    }
  }
}
walk(evidenceDir)

const prior = readJson(path.join(evidenceDir, 'test-results.json'))
const manifest = {
  schemaVersion: 1,
  commitSha,
  node: process.env.XYVA_NODE_VERSION ?? process.version,
  npm: process.env.XYVA_NPM_VERSION ?? 'unknown',
  runner: process.env.RUNNER_NAME ?? process.env.RUNNER_OS ?? 'unknown',
  platform: process.env.RUNNER_OS ?? process.platform,
  jobStatus: process.env.XYVA_JOB_STATUS ?? 'unknown',
  tests: {
    build: prior.build ?? 'NOT_EXECUTED',
    typecheck: prior.typecheck ?? 'NOT_EXECUTED',
    publicRegression: prior.publicRegression ?? 'NOT_EXECUTED',
    security: prior.security ?? 'NOT_EXECUTED',
    nativeWindows: prior.nativeWindows ?? 'NOT_EXECUTED',
  },
  artifacts: files,
  promotion: 'STAGING_ONLY',
}

fs.writeFileSync(path.join(evidenceDir, 'staging-evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`)
