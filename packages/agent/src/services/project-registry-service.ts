import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { AgentFsService } from './fs-service.js'
import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getAgentDataRoot } from '../utils/platform.js'
import { writePrivateFile } from '../secure-store.js'

export interface AgentProjectInfo {
  name: string
  path: string
  hasPlaywrightConfig: boolean
  testFileCount: number
  lastUsedAt: number | null
}

interface StoredProjectEntry {
  path: string
  lastUsedAt: number | null
}

interface ProjectsRegistryFile {
  version: 1
  projects: StoredProjectEntry[]
}

const REGISTRY_VERSION = 1

export class AgentProjectRegistryService {
  private readonly fsService = new AgentFsService()

  constructor() {
    this.hydrateApprovedProjects()
  }

  async listProjects(): Promise<AgentProjectInfo[]> {
    const registry = await this.readRegistry()
    const projects = await Promise.all(registry.projects.map(async (entry) => {
      try {
        return await this.getProjectInfo(entry.path, registry.projects)
      } catch {
        return null
      }
    }))

    return projects
      .filter((project): project is AgentProjectInfo => Boolean(project?.hasPlaywrightConfig))
      .sort((left, right) => {
        const leftLastUsed = left.lastUsedAt ?? 0
        const rightLastUsed = right.lastUsedAt ?? 0
        if (leftLastUsed !== rightLastUsed) {
          return rightLastUsed - leftLastUsed
        }

        return left.name.localeCompare(right.name)
      })
  }

  async addProject(projectPath: string): Promise<AgentProjectInfo> {
    const canonicalPath = SecurityGuard.canonicalizePath(projectPath)
    const stats = await fs.stat(canonicalPath).catch(() => null)
    if (!stats?.isDirectory()) {
      throw new Error(`Project path does not exist: ${projectPath}`)
    }

    if (!await this.hasPlaywrightConfig(canonicalPath)) {
      throw new Error('No Playwright config found in the selected directory.')
    }
    const approvedPath = SecurityGuard.approveProjectRoot(canonicalPath)
    const info = await this.getProjectInfo(approvedPath)

    await this.writeRegistry((current) => {
      const nextProjects = current.projects.filter((entry) => entry.path !== approvedPath)
      nextProjects.unshift({ path: approvedPath, lastUsedAt: Date.now() })
      return { version: REGISTRY_VERSION, projects: nextProjects.slice(0, 50) }
    })

    return {
      ...info,
      lastUsedAt: Date.now(),
    }
  }

  async getProjectInfo(projectPath: string, knownProjects?: StoredProjectEntry[]): Promise<AgentProjectInfo> {
    const normalizedPath = SecurityGuard.canonicalizePath(projectPath)
    if (!SecurityGuard.isApprovedProjectRoot(normalizedPath)) {
      throw new Error(`Project path is not approved: ${projectPath}`)
    }

    const hasPlaywrightConfig = await this.hasPlaywrightConfig(normalizedPath)
    const knownEntry = knownProjects?.find((entry) => entry.path === normalizedPath) || null
    const testFileCount = hasPlaywrightConfig
      ? (await this.fsService.listTestFiles(normalizedPath, 'playwright')).length
      : 0

    return {
      name: path.basename(normalizedPath),
      path: normalizedPath,
      hasPlaywrightConfig,
      testFileCount,
      lastUsedAt: knownEntry?.lastUsedAt ?? null,
    }
  }

  async touchProject(projectPath: string): Promise<void> {
    const normalizedPath = SecurityGuard.canonicalizePath(projectPath)
    if (!SecurityGuard.isApprovedProjectRoot(normalizedPath)) {
      throw new Error(`Project path is not approved: ${projectPath}`)
    }
    const stats = await fs.stat(normalizedPath).catch(() => null)
    if (!stats?.isDirectory()) {
      return
    }

    await this.writeRegistry((current) => {
      const nextProjects = current.projects.filter((entry) => entry.path !== normalizedPath)
      nextProjects.unshift({ path: normalizedPath, lastUsedAt: Date.now() })
      return { version: REGISTRY_VERSION, projects: nextProjects.slice(0, 50) }
    })
  }

  private getRegistryPath(): string {
    return path.join(getAgentDataRoot(), 'projects.json')
  }

  private async ensureRegistryDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.getRegistryPath()), { recursive: true })
  }

  private async readRegistry(): Promise<ProjectsRegistryFile> {
    try {
      const raw = await fs.readFile(this.getRegistryPath(), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ProjectsRegistryFile>
      if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.projects)) {
        return { version: REGISTRY_VERSION, projects: [] }
      }

      return {
        version: REGISTRY_VERSION,
        projects: parsed.projects.flatMap((entry) => {
          if (!entry || typeof entry.path !== 'string') return []
          try {
            const canonical = SecurityGuard.canonicalizePath(entry.path)
            if (!SecurityGuard.isApprovedProjectRoot(canonical) || !this.hasPlaywrightConfigSync(canonical)) return []
            return [{
              path: canonical,
              lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : null,
            }]
          } catch {
            return []
          }
        }),
      }
    } catch {
      return { version: REGISTRY_VERSION, projects: [] }
    }
  }

  private async writeRegistry(update: (current: ProjectsRegistryFile) => ProjectsRegistryFile): Promise<void> {
    await this.ensureRegistryDir()
    const current = await this.readRegistry()
    const next = update(current)
    writePrivateFile(this.getRegistryPath(), JSON.stringify(next, null, 2))
  }

  private async hasPlaywrightConfig(projectPath: string): Promise<boolean> {
    const configNames = [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ]

    for (const fileName of configNames) {
      try {
        const candidate = SecurityGuard.canonicalizePath(path.join(projectPath, fileName))
        const stats = await fs.stat(candidate)
        if (stats.isFile() && SecurityGuard.isPathWithinRoot(projectPath, candidate)) return true
      } catch {
        // keep searching
      }
    }

    return false
  }

  private hasPlaywrightConfigSync(projectPath: string): boolean {
    return [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ].some((fileName) => {
      try {
        const candidate = SecurityGuard.canonicalizePath(path.join(projectPath, fileName))
        return SecurityGuard.isPathWithinRoot(projectPath, candidate) && fsSync.statSync(candidate).isFile()
      } catch {
        return false
      }
    })
  }

  private hydrateApprovedProjects(): void {
    try {
      const raw = fsSync.readFileSync(this.getRegistryPath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<ProjectsRegistryFile>
      if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.projects)) return

      for (const entry of parsed.projects) {
        if (!entry || typeof entry.path !== 'string') continue
        try {
          const canonical = SecurityGuard.canonicalizePath(entry.path)
          if (this.hasPlaywrightConfigSync(canonical)) SecurityGuard.approveProjectRoot(canonical)
        } catch {
          // Invalid or protected registry entries are never approved.
        }
      }
    } catch {
      // No prior approvals is the secure default.
    }
  }
}
