import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { ReconCallbacks, ReconMemorySummary, ReconProfile, ReconScanUpdate, RepoMap } from '@xyva/bridge-types'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getGitBinary, normalizePath } from '../utils/platform.js'

const execFileAsync = promisify(execFile)

export interface ReconAgentMemoryDraft {
  qaMap: {
    generatedAt: string
    source: 'recon:deepScan'
    pageObjects: string[]
    tests: string[]
  }
  gitInsights: {
    generatedAt: string
    source: string
    analyzed: boolean
    commitMessages: string[]
    namingConventions: string[]
    fixPatterns: string[]
  }
  knowledgeIndex: {
    generatedAt: string
    source: string
    docsRoot: string
    files: Array<{ file: string; preview: string }>
  } | null
  repoMarkdown: string
}

export interface ReconScanOptions extends ReconCallbacks {
  profile?: ReconProfile
}

export class AgentReconService {
  async scanRepository(projectPath: string, options: ReconScanOptions = {}): Promise<RepoMap> {
    const profile = options.profile || 'deep'
    const emitUpdate = (update: ReconScanUpdate) => options.onUpdate?.(update)

    const map: RepoMap = {
      type: 'unknown',
      testFiles: [],
      pageObjects: [],
      fixtures: [],
      actions: [],
      asserts: [],
      totalFiles: 0,
      totalTestCases: 0,
    }

    if (!SecurityGuard.isApprovedProjectRoot(projectPath)) {
      throw new Error(`Unauthorized access attempt: ${projectPath}`)
    }

    projectPath = SecurityGuard.canonicalizePath(projectPath)

    try {
      await fs.access(projectPath)

      emitUpdate({ status: 'Discovering files...', currentFile: '' })
      const files = await this.recursiveReaddir(projectPath)
      map.totalFiles = files.length

      const projectRootConfigFile = await this.findConfigFile(projectPath)
      if (projectRootConfigFile) {
        if (projectRootConfigFile.includes('playwright.config')) {
          map.type = 'playwright'
        } else if (projectRootConfigFile.includes('cypress.config')) {
          map.type = 'cypress'
        }
      }

      let processedCount = 0
      for (const file of files) {
        processedCount += 1
        const relPath = normalizePath(path.relative(projectPath, file))

        if (processedCount % 10 === 0) {
          emitUpdate({
            status: `Categorizing files (${processedCount}/${files.length})...`,
            currentFile: relPath,
          })
        }

        if (relPath.includes('node_modules') || relPath.includes('.git') || relPath.includes('dist')) {
          continue
        }

        const lowerFile = file.toLowerCase()
        const lowerPath = relPath.toLowerCase()
        const pathParts = lowerPath.split('/')

        if (
          lowerFile.endsWith('.spec.ts')
          || lowerFile.endsWith('.test.ts')
          || lowerFile.endsWith('.spec.js')
          || lowerFile.endsWith('.test.js')
          || lowerFile.endsWith('.cy.ts')
          || lowerFile.endsWith('.cy.js')
        ) {
          map.testFiles.push(relPath)
        } else if (
          lowerFile.includes('.page.')
          || pathParts.includes('pages')
          || pathParts.includes('page-objects')
          || pathParts.includes('pom')
        ) {
          map.pageObjects.push(relPath)
        } else if (
          lowerFile.includes('.fixture.')
          || pathParts.includes('fixtures')
          || lowerFile.endsWith('fixtures.ts')
          || lowerFile.endsWith('fixtures.js')
        ) {
          map.fixtures.push(relPath)
        } else if (
          lowerFile.includes('.action.')
          || pathParts.includes('actions')
          || pathParts.includes('commands')
          || lowerFile.includes('.command.')
        ) {
          map.actions.push(relPath)
        } else if (
          lowerFile.includes('.assert.')
          || pathParts.includes('asserts')
          || pathParts.includes('assertions')
          || lowerFile.includes('.assertion.')
        ) {
          map.asserts.push(relPath)
        }
      }

      if (profile === 'express') {
        map.fixtures = []
        map.actions = []
        map.asserts = []
        map.totalTestCases = map.testFiles.length
      } else {
        let testFileIndex = 0
        for (const file of map.testFiles) {
          try {
            testFileIndex += 1
            emitUpdate({
              status: `Deep Scan: Analyzing scenarios (${testFileIndex}/${map.testFiles.length})...`,
              currentFile: file,
            })

            const content = await fs.readFile(path.join(projectPath, file), 'utf-8')
            const matches = content.matchAll(/(?:^|\s)(?:test|it)(?:\.only|\.skip)?\s*\(/gm)
            let count = 0
            for (const _match of matches) {
              count += 1
            }

            map.totalTestCases += count
          } catch {
            console.warn(`Failed to read ${file} for deep scan`)
          }
        }

        emitUpdate({ status: 'Collecting read-only agent memory draft...', currentFile: '.xyva/agent-memory' })
        map.memorySummary = await this.buildMemorySummary(projectPath, map)
        map.scanMessage = `Scan abgeschlossen. ${map.memorySummary.pageObjects} Page-Objects erkannt, Git-Historie analysiert, Knowledge-Base geprüft.`
      }

      return map
    } catch (error) {
      console.error('Recon failed:', error)
      return map
    }
  }

  async createAgentMemoryDraft(projectPath: string, map: RepoMap): Promise<ReconAgentMemoryDraft> {
    if (!SecurityGuard.isApprovedProjectRoot(projectPath)) {
      throw new Error(`Unauthorized access attempt: ${projectPath}`)
    }
    projectPath = SecurityGuard.canonicalizePath(projectPath)
    const gitInsights = await this.collectGitInsights(projectPath)
    const knowledgeIndex = await this.collectKnowledgeIndex(projectPath)

    return {
      qaMap: {
        generatedAt: new Date().toISOString(),
        source: 'recon:deepScan',
        pageObjects: map.pageObjects,
        tests: map.testFiles,
      },
      gitInsights,
      knowledgeIndex,
      repoMarkdown: this.renderRepoMarkdown(map),
    }
  }

  private async buildMemorySummary(projectPath: string, map: RepoMap): Promise<ReconMemorySummary> {
    const gitInsights = await this.collectGitInsights(projectPath)
    const knowledgeIndex = await this.collectKnowledgeIndex(projectPath)

    return {
      pageObjects: map.pageObjects.length,
      tests: map.testFiles.length,
      gitHistoryAnalyzed: gitInsights.analyzed,
      knowledgeBaseInitialized: knowledgeIndex !== null,
    }
  }

  private async collectGitInsights(projectPath: string) {
    let gitMessages: string[] = []
    let analyzed = false

    try {
      const { stdout } = await execFileAsync(getGitBinary(), ['log', '-n', '20', '--pretty=format:%s'], {
        cwd: projectPath,
        windowsHide: true,
      })

      gitMessages = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      analyzed = true
    } catch {
      analyzed = false
    }

    return {
      generatedAt: new Date().toISOString(),
      source: 'git log -n 20 --pretty=format:%s',
      analyzed,
      commitMessages: gitMessages,
      namingConventions: this.deriveNamingConventions(gitMessages),
      fixPatterns: this.deriveFixPatterns(gitMessages),
    }
  }

  private async collectKnowledgeIndex(projectPath: string) {
    const docsDir = path.join(projectPath, 'docs')

    try {
      await fs.access(docsDir)
      const docFiles = await this.recursiveReaddir(docsDir)
      const items: Array<{ file: string; preview: string }> = []

      for (const file of docFiles) {
        const rel = normalizePath(path.relative(projectPath, file))
        try {
          const content = await fs.readFile(file, 'utf-8')
          items.push({
            file: rel,
            preview: content.replace(/\s+/g, ' ').trim().slice(0, 100),
          })
        } catch {
          items.push({ file: rel, preview: '' })
        }
      }

      return {
        generatedAt: new Date().toISOString(),
        source: 'docs directory scan',
        docsRoot: normalizePath(path.relative(projectPath, docsDir)) || 'docs',
        files: items,
      }
    } catch {
      return null
    }
  }

  private deriveNamingConventions(messages: string[]): string[] {
    if (!messages.length) {
      return []
    }

    const counters: Record<string, number> = {
      'feat:': 0,
      'fix:': 0,
      'chore:': 0,
      'docs:': 0,
      'test:': 0,
    }

    for (const message of messages) {
      const lower = message.toLowerCase()
      for (const prefix of Object.keys(counters)) {
        if (lower.startsWith(prefix)) {
          counters[prefix] += 1
        }
      }
    }

    return Object.entries(counters)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([prefix]) => `conventional:${prefix.replace(':', '')}`)
  }

  private deriveFixPatterns(messages: string[]): string[] {
    if (!messages.length) {
      return []
    }

    const keys = [
      { needle: 'selector', pattern: 'selector-hardening' },
      { needle: 'timeout', pattern: 'timeout-stabilization' },
      { needle: 'flaky', pattern: 'flaky-test-mitigation' },
      { needle: 'retry', pattern: 'retry-policy-adjustment' },
      { needle: 'auth', pattern: 'auth-flow-repair' },
      { needle: 'scope', pattern: 'oauth-scope-fix' },
      { needle: 'pipeline', pattern: 'ci-pipeline-repair' },
    ]

    const found = new Set<string>()
    for (const message of messages) {
      const lower = message.toLowerCase()
      for (const entry of keys) {
        if (lower.includes(entry.needle)) {
          found.add(entry.pattern)
        }
      }
    }

    return Array.from(found)
  }

  private renderRepoMarkdown(map: RepoMap): string {
    return `
- **Framework:** ${map.type.toUpperCase()}
- **Tests:** ${map.testFiles.length} files (**${map.totalTestCases} Scenarios**)
- **Page Objects:** ${map.pageObjects.length} files
- **Fixtures:** ${map.fixtures.length} files
- **Actions:** ${map.actions.length} files
- **Assertions:** ${map.asserts.length} files
- **Total Project Files:** ${map.totalFiles}

### Key Test Files
${map.testFiles.slice(0, 10).map((file) => `- \`${file}\``).join('\n')}
${map.testFiles.length > 10 ? `- *...and ${map.testFiles.length - 10} more*` : ''}

### Architecture Mapping
- **Page Objects Directory:** ${this.detectCommonPath(map.pageObjects) || 'N/A'}
- **Fixtures Directory:** ${this.detectCommonPath(map.fixtures) || 'N/A'}
- **Actions Directory:** ${this.detectCommonPath(map.actions) || 'N/A'}
- **Assertions Directory:** ${this.detectCommonPath(map.asserts) || 'N/A'}
`.trim()
  }

  private detectCommonPath(files: string[]): string | null {
    if (files.length === 0) {
      return null
    }

    if (files.length === 1) {
      return path.dirname(files[0])
    }

    const parts = files[0].split('/')
    const common: string[] = []
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (files.every((file) => file.split('/')[index] === part)) {
        common.push(part)
      } else {
        break
      }
    }

    return common.join('/') || '/'
  }

  private async recursiveReaddir(dir: string): Promise<string[]> {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(dirents.filter((dirent) => !dirent.isSymbolicLink()).map((dirent) => {
      const resolved = path.resolve(dir, dirent.name)
      if (!SecurityGuard.isPathSafe(resolved)) return []
      return dirent.isDirectory() ? this.recursiveReaddir(resolved) : resolved
    }))

    return Array.prototype.concat(...files)
  }

  private async findConfigFile(searchPath: string): Promise<string | null> {
    const configNames = [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
      'cypress.config.ts',
      'cypress.config.js',
      'cypress.config.mjs',
      'cypress.config.cjs',
    ]

    for (const name of configNames) {
      const filePath = path.join(searchPath, name)
      try {
        const canonical = SecurityGuard.getSafePath(filePath)
        await fs.access(canonical)
        return canonical
      } catch {
        // keep searching
      }
    }

    return null
  }
}
