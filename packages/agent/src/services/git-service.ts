import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getGitBinary } from '../utils/platform.js'

const execFileAsync = promisify(execFile)
const GITLAB_USER_ENDPOINT = 'https://gitlab.com/api/v4/user'
const MAX_GITLAB_RESPONSE_BYTES = 64 * 1024

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITLAB_RESPONSE_BYTES) {
    throw new Error('GitLab response exceeds the allowed size')
  }
  if (!response.body) throw new Error('GitLab response body is missing')

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_GITLAB_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('GitLab response exceeds the allowed size')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export interface GitChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GitAiConfig extends Record<string, unknown> {
  systemInstructions?: string
}

export interface GitAiPort {
  chat(messages: GitChatMessage[], config: GitAiConfig): Promise<{ message?: string }>
}

export interface GitStatusEntry {
  status: string
  file: string
}

export interface GitServiceOptions {
  aiClient?: GitAiPort
  gitBinary?: string
}

export class AgentGitService {
  private readonly protectedBranches = new Set(['main', 'master', 'develop', 'production'])
  private readonly aiClient?: GitAiPort
  private readonly gitBinary: string

  constructor(options: GitServiceOptions = {}) {
    this.aiClient = options.aiClient
    this.gitBinary = options.gitBinary || getGitBinary()
  }

  private ensureSafeRoot(rootPath: string) {
    if (!rootPath || !SecurityGuard.isApprovedProjectRoot(rootPath)) {
      throw new Error('Unauthorized project path')
    }
  }

  private async runGit(rootPath: string, args: string[]) {
    this.ensureSafeRoot(rootPath)
    return execFileAsync(this.gitBinary, args, { cwd: rootPath })
  }

  private normalizeBranchName(branchName: string): string {
    const candidate = String(branchName || '').trim()
    if (
      !candidate
      || candidate.length > 200
      || candidate.startsWith('-')
      || candidate.startsWith('/')
      || candidate.endsWith('/')
      || candidate.endsWith('.')
      || candidate.includes('..')
      || candidate.includes('@{')
      || candidate.includes('//')
      || candidate === '@'
      || candidate.split('/').some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))
      || !/^[A-Za-z0-9._/-]+$/.test(candidate)
    ) {
      throw new Error('Invalid branch name')
    }

    return candidate
  }

  private resolveFileInRepo(rootPath: string, filePath: string): string {
    this.ensureSafeRoot(rootPath)
    return SecurityGuard.resolveSafeChildPath(rootPath, filePath)
  }

  async generateCommitMessage(diff: string, config: GitAiConfig) {
    if (!this.aiClient) {
      return { ok: false, error: 'AI client not configured for commit message generation' }
    }

    const prompt = `Generate a concise, professional Git commit message based on this diff:\n${diff.substring(0, 5000)}`

    try {
      const response = await this.aiClient.chat([{ role: 'user', content: prompt }], {
        ...config,
        systemInstructions: 'You are an expert developer. Respond with ONLY the commit message text, no quotes or prefix.',
      })

      return { ok: true, message: response.message }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async getStatus(rootPath: string): Promise<{ ok: boolean; modified?: GitStatusEntry[]; error?: string }> {
    try {
      const { stdout } = await this.runGit(rootPath, ['status', '--porcelain'])
      const lines = stdout.split('\n').filter(Boolean)
      return {
        ok: true,
        modified: lines.map((line) => ({
          status: line.substring(0, 2).trim(),
          file: line.substring(3).trim(),
        })),
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async validateGitLabToken(token: string) {
    try {
      const normalizedToken = String(token || '').trim()
      if (normalizedToken.length < 8 || normalizedToken.length > 512) {
        return { ok: false, error: 'GitLab token validation failed.' }
      }

      const response = await fetch(GITLAB_USER_ENDPOINT, {
        headers: { Accept: 'application/json', 'PRIVATE-TOKEN': normalizedToken },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      })

      if (response.ok) {
        const user = await readBoundedJson(response) as { username?: unknown }
        if (typeof user.username !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/u.test(user.username)) {
          return { ok: false, error: 'GitLab token validation failed.' }
        }
        return { ok: true, user: user.username }
      }

      return { ok: false, error: 'GitLab token validation failed.' }
    } catch {
      return { ok: false, error: 'GitLab token validation failed.' }
    }
  }

  async getDiff(rootPath: string) {
    try {
      const { stdout } = await this.runGit(rootPath, ['diff', 'HEAD'])
      return { ok: true, diff: stdout }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async pull(rootPath: string, branch = 'main') {
    try {
      const safeBranch = this.normalizeBranchName(branch)
      await this.runGit(rootPath, ['pull', 'origin', safeBranch])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async listBranches(rootPath: string) {
    try {
      const { stdout } = await this.runGit(rootPath, ['branch', '-a'])
      const branches = stdout
        .split('\n')
        .map((branch) => branch.replace('*', '').trim())
        .filter(Boolean)
        .filter((branch) => !branch.includes('->'))

      return { ok: true, branches }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async createBranch(rootPath: string, branchName: string) {
    try {
      const safeBranch = this.normalizeBranchName(branchName)
      await this.runGit(rootPath, ['checkout', '-b', safeBranch])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async checkout(rootPath: string, branchName: string) {
    try {
      const safeBranch = this.normalizeBranchName(branchName)
      await this.runGit(rootPath, ['checkout', safeBranch])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async commitAndPush(rootPath: string, message: string, branch = 'main') {
    try {
      const safeBranch = this.normalizeBranchName(branch)
      if (this.protectedBranches.has(safeBranch.toLowerCase()) || safeBranch.toLowerCase().startsWith('release/')) {
        return { ok: false, error: `Protected branch blocked: ${safeBranch}` }
      }

      const commitMessage = (message || '').replace(/\r?\n/g, ' ').trim()
      if (!commitMessage || commitMessage.length > 500 || commitMessage.includes('\0')) {
        return { ok: false, error: 'Commit message must contain between 1 and 500 safe characters' }
      }

      await this.runGit(rootPath, ['add', '.'])
      await this.runGit(rootPath, ['commit', '-m', commitMessage])
      await this.runGit(rootPath, ['push', 'origin', safeBranch])
      return { ok: true }
    } catch (error) {
      const message = String((error as Error).message || '')
      const lower = message.toLowerCase()
      const conflict = lower.includes('conflict') || lower.includes('merge failed') || lower.includes('automatic merge failed')
      return { ok: false, error: message, conflict }
    }
  }

  async getConflictingFiles(rootPath: string) {
    try {
      const { stdout } = await this.runGit(rootPath, ['diff', '--name-only', '--diff-filter=U'])
      const files = stdout.split('\n').map((file) => file.trim()).filter(Boolean)
      return { ok: true, files }
    } catch (error) {
      return { ok: false, error: (error as Error).message, files: [] as string[] }
    }
  }

  async getFileWithMarkers(rootPath: string, filePath: string) {
    try {
      const resolved = this.resolveFileInRepo(rootPath, filePath)
      if (!SecurityGuard.isPathSafe(resolved)) {
        return { ok: false, error: 'Unauthorized file path' }
      }

      const content = await fs.readFile(resolved, 'utf-8')
      const hasMarkers = content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>')
      return { ok: true, content, hasMarkers }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async resolveConflictWithAI(req: { rootPath: string; filePath: string; content: string; config?: GitAiConfig }) {
    if (!this.aiClient) {
      return { ok: false, error: 'AI client not configured for conflict resolution' }
    }

    try {
      this.resolveFileInRepo(req.rootPath, req.filePath)
      const prompt = [
        'Du bist ein Senior Lead Engineer. Loese den folgenden Merge-Konflikt fachlich korrekt auf.',
        'Behalte die Logik beider Seiten bei, wenn sinnvoll, und entferne die Git-Marker.',
        'Antworte NUR mit dem bereinigten Code.',
        '',
        `Datei: ${req.filePath}`,
        'Konfliktinhalt:',
        req.content,
      ].join('\n')

      const response = await this.aiClient.chat([{ role: 'user', content: prompt }], {
        ...(req.config || {}),
        systemInstructions: 'Resolve Git merge conflicts. Return only valid cleaned file content, no markdown fences.',
      })

      const resolved = String(response.message || '')
        .replace(/^```[a-zA-Z]*\n?/, '')
        .replace(/\n?```$/, '')

      const stillMarked = resolved.includes('<<<<<<<') || resolved.includes('=======') || resolved.includes('>>>>>>>')
      if (!resolved.trim()) {
        return { ok: false, error: 'AI returned empty resolution' }
      }

      if (stillMarked) {
        return { ok: false, error: 'AI response still contains conflict markers' }
      }

      return { ok: true, resolvedContent: resolved }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async applyResolvedConflict(rootPath: string, filePath: string, resolvedContent: string) {
    try {
      const resolved = this.resolveFileInRepo(rootPath, filePath)
      if (!SecurityGuard.isPathSafe(resolved)) {
        return { ok: false, error: 'Unauthorized file path' }
      }

      if (!resolvedContent || !String(resolvedContent).trim()) {
        return { ok: false, error: 'Resolved content is empty' }
      }

      await fs.writeFile(resolved, resolvedContent, 'utf-8')
      await this.runGit(rootPath, ['add', filePath])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }
}
