import fs from 'node:fs/promises'
import path from 'node:path'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { normalizePath } from '../utils/platform.js'

const HIDDEN_ENTRIES = new Set([
  '.xyva',
  'knowledge',
  'agent.md',
  'agents.md',
  'AGENTS.md',
  'node_modules',
  '.git',
  '.github',
  '.gitlab',
  '.yarn',
  'dist',
  'dist-electron',
  '.vitepress',
  'playwright-report',
  'test-results',
])

export interface AgentFsEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface DiscoveredTestFile {
  file: string
  tests: string[]
}

export class AgentFsService {
  async readDir(dirPath: string): Promise<AgentFsEntry[]> {
    const safeDirectory = SecurityGuard.getSafePath(dirPath)
    if (!SecurityGuard.isPathSafe(safeDirectory)) {
      throw new Error(`Unauthorized access attempt: ${dirPath}`)
    }

    try {
      const entries = await fs.readdir(safeDirectory, { withFileTypes: true })
      const result = entries
        .filter((entry) => !HIDDEN_ENTRIES.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: normalizePath(path.join(safeDirectory, entry.name)),
        }))

      return result.sort((left, right) => {
        if (left.isDirectory === right.isDirectory) {
          return left.name.localeCompare(right.name)
        }

        return left.isDirectory ? -1 : 1
      })
    } catch (error) {
      throw new Error(`Failed to read directory: ${(error as Error).message}`)
    }
  }

  async readFile(filePath: string): Promise<string> {
    const safeFile = SecurityGuard.getSafePath(filePath)
    if (!SecurityGuard.isPathSafe(safeFile)) {
      throw new Error(`Unauthorized access attempt: ${filePath}`)
    }

    return fs.readFile(safeFile, 'utf-8')
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const writePolicy = SecurityGuard.isFileWriteAllowed()
    if (!writePolicy.ok) {
      SecurityGuard.recordAgentDecision('fs.writeFile', false, writePolicy.reason, { filePath })
      throw new Error(writePolicy.reason)
    }

    const safeFile = SecurityGuard.getSafePath(filePath)
    if (!SecurityGuard.isPathSafe(safeFile)) {
      throw new Error(`Unauthorized access attempt: ${filePath}`)
    }

    if (SecurityGuard.isSandboxActive() && !SecurityGuard.isAiPathAllowed(safeFile)) {
      throw new Error(`AI Sandbox: write to "${filePath}" is blocked. Only the workspace directory is allowed.`)
    }

    const workspaceRoot = SecurityGuard.getWorkspaceRoot()
    if (workspaceRoot && !SecurityGuard.isPathWithinRoot(workspaceRoot, safeFile)) {
        throw new Error(`Workspace boundary: write to "${filePath}" is blocked. Project writes must target the workspace.`)
    }

    await fs.mkdir(path.dirname(safeFile), { recursive: true })
    await fs.writeFile(safeFile, content, 'utf-8')
  }

  async listTestFiles(projectPath: string, engine: 'playwright'): Promise<string[]> {
    const safeProjectPath = SecurityGuard.getSafePath(projectPath)
    if (!SecurityGuard.isApprovedProjectRoot(safeProjectPath)) {
      throw new Error(`Unauthorized access attempt: ${projectPath}`)
    }

    const possiblePaths = [
      path.join(safeProjectPath, 'playwright', 'tests'),
      path.join(safeProjectPath, 'tests'),
      path.join(safeProjectPath, 'e2e'),
    ]

    let allFiles: string[] = []
    for (const testPath of possiblePaths) {
      try {
        const files = await fs.readdir(testPath, { recursive: true })
        const filtered = (files as string[])
          .filter((file) => (
            file.endsWith('.spec.ts')
            || file.endsWith('.spec.js')
            || file.endsWith('.test.ts')
            || file.endsWith('.test.js')
          ))
          .map((file) => normalizePath(file))

        allFiles = [...allFiles, ...filtered]
      } catch {
        // ignore missing roots
      }
    }

    return [...new Set(allFiles)]
  }

  async discoverTests(projectPath: string, engine: 'playwright'): Promise<DiscoveredTestFile[]> {
    const fileList = await this.listTestFiles(projectPath, engine)
    const results: DiscoveredTestFile[] = []

    for (const relPath of fileList) {
      let fullPath = ''
      const possibleFullPaths = [
        path.join(projectPath, 'playwright', 'tests', relPath),
        path.join(projectPath, 'tests', relPath),
        path.join(projectPath, 'e2e', relPath),
      ]

      for (const candidate of possibleFullPaths) {
        try {
          const safeCandidate = SecurityGuard.getSafePath(candidate)
          await fs.access(safeCandidate)
          fullPath = safeCandidate
          break
        } catch {
          // keep searching
        }
      }

      if (!fullPath) {
        continue
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8')
        const testMatches = content.matchAll(/(?:test|it|describe)\s*\(\s*['"`](.*?)['"`]/g)
        const tests = Array.from(testMatches).map((match) => match[1])
        results.push({ file: relPath, tests })
      } catch (error) {
        console.error(`Failed to parse ${relPath}`, error)
      }
    }

    return results
  }

  async findFiles(rootPath: string, pattern: string, limit = 50): Promise<string[]> {
    const safeRoot = SecurityGuard.getSafePath(rootPath)
    if (!SecurityGuard.isPathSafe(safeRoot)) {
      throw new Error(`Unauthorized access attempt: ${rootPath}`)
    }

    const needle = (pattern || '').toLowerCase()
    if (!needle) {
      return []
    }

    const entries = await fs.readdir(safeRoot, { recursive: true })
    return (entries as string[])
      .filter((entry) => entry.toLowerCase().includes(needle))
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map((entry) => normalizePath(path.join(safeRoot, entry)))
  }
}
