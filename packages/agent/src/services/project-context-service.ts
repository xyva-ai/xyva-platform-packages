import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getGitBinary } from '../utils/platform.js'

const FALLBACK_HASH = '00000000-0'
const HASH_CACHE_TTL_MS = 2_000
const MAX_DEPTH = 3
const TEST_FILE_RE = /\.(spec|test)\.(t|j)sx?$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.turbo'])
const hashCache = new Map<string, { value: string; expiresAt: number }>()

function getGitHeadShort(projectPath: string): string {
  try {
    const output = execFileSync(getGitBinary(), ['rev-parse', '--short=8', 'HEAD'], {
      cwd: projectPath,
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const head = String(output || '').trim()
    return /^[0-9a-f]{8}$/i.test(head) ? head : '00000000'
  } catch {
    return '00000000'
  }
}

function sumTestFileMtimes(projectPath: string): number {
  let total = 0

  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      return
    }

    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue
      }

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue
        }

        walk(fullPath, depth + 1)
      } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath)
          total += stat.mtimeMs
        } catch {
          // ignore unreadable file
        }
      }
    }
  }

  try {
    walk(projectPath, 0)
  } catch {
    return 0
  }

  return Math.floor(total)
}

async function computeProjectStateHash(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    return FALLBACK_HASH
  }

  try {
    const head = getGitHeadShort(projectPath)
    const mtimeSum = sumTestFileMtimes(projectPath)
    return `${head}-${mtimeSum}`
  } catch {
    return FALLBACK_HASH
  }
}

export const projectContextInternals = {
  computeProjectStateHash,
}

export async function getProjectStateHash(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    return FALLBACK_HASH
  }

  const now = Date.now()
  const cached = hashCache.get(projectPath)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const value = await projectContextInternals.computeProjectStateHash(projectPath)
  hashCache.set(projectPath, { value, expiresAt: now + HASH_CACHE_TTL_MS })
  return value
}

export function invalidateProjectStateHash(projectPath?: string): void {
  if (projectPath) {
    hashCache.delete(projectPath)
    return
  }

  hashCache.clear()
}

export function getProjectStateHashCacheSize(): number {
  return hashCache.size
}

export class ProjectContextService {
  async getStateHash(projectPath: string): Promise<string> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return FALLBACK_HASH
    }
    return getProjectStateHash(SecurityGuard.canonicalizePath(projectPath))
  }
}
