import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getAgentModePolicy, type AgentMode, type McpCatalogPolicyEntry } from './agent-policy.js'
import { getAgentDataRoot, getUserHome } from './platform.js'

export interface AgentAuditEntry {
  timestamp: string
  mode: AgentMode
  action: string
  allowed: boolean
  reason: string
  metadata?: Record<string, unknown>
}

export class SecurityGuard {
  private static approvedProjectRoots = new Set<string>()

  private static workspaceRoot: string | null = null
  private static sandboxEnabled = false
  private static sandboxRoot: string | null = null
  private static agentMode: AgentMode = 'advisor'
  private static agentAuditLog: AgentAuditEntry[] = []

  static approveProjectRoot(dir: string): string {
    const canonical = this.canonicalizePath(dir)
    const stats = fs.statSync(canonical)
    if (!stats.isDirectory()) {
      throw new Error('Approved project root must be a directory')
    }
    if (this.isForbiddenProjectRoot(canonical)) {
      throw new Error(`Project root is too broad or protected: ${dir}`)
    }

    this.approvedProjectRoots.add(canonical)
    return canonical
  }

  /** @deprecated Project roots must be explicitly approved after validation. */
  static addAllowedRoot(dir: string) {
    return this.approveProjectRoot(dir)
  }

  static revokeProjectRoot(dir: string): void {
    try {
      this.approvedProjectRoots.delete(this.canonicalizePath(dir))
    } catch {
      // Nothing to revoke when the target cannot be canonicalized.
    }
  }

  static resetApprovedProjectRoots(): void {
    this.approvedProjectRoots.clear()
    this.workspaceRoot = null
  }

  static getApprovedProjectRoots(): string[] {
    return [...this.approvedProjectRoots]
  }

  static isApprovedProjectRoot(dir: string): boolean {
    try {
      return this.approvedProjectRoots.has(this.canonicalizePath(dir))
    } catch {
      return false
    }
  }

  static setWorkspaceRoot(root: string | null) {
    if (root) {
      const canonical = this.approveProjectRoot(root)
      this.workspaceRoot = canonical
      this.recordAgentDecision('workspace.root.set', true, 'Workspace root updated', { root: canonical })
      return
    }

    this.workspaceRoot = null
  }

  static getWorkspaceRoot(): string | null {
    return this.workspaceRoot
  }

  static isWorkspaceWriteAllowed(targetPath: string): boolean {
    if (!this.workspaceRoot) {
      return false
    }

    try {
      const canonical = this.canonicalizePath(targetPath)
      return !this.isInternalPath(canonical) && this.isPathWithinRoot(this.workspaceRoot, canonical)
    } catch {
      return false
    }
  }

  static setSandbox(enabled: boolean, projectPath: string | null) {
    this.sandboxEnabled = enabled
    this.sandboxRoot = projectPath ? this.canonicalizePath(projectPath) : null
  }

  static setAgentMode(mode: AgentMode | string | null | undefined) {
    const policy = getAgentModePolicy(mode)
    this.agentMode = policy.id
    this.recordAgentDecision('agent.mode.set', true, 'Agent mode updated', { mode: policy.id })
  }

  static getAgentMode(): AgentMode {
    return this.agentMode
  }

  static getAgentAuditLog(): AgentAuditEntry[] {
    return [...this.agentAuditLog]
  }

  static isSandboxActive(): boolean {
    return this.sandboxEnabled && !!this.sandboxRoot
  }

  static isAiPathAllowed(targetPath: string): boolean {
    if (!this.sandboxEnabled || !this.sandboxRoot) {
      return true
    }

    try {
      const canonical = this.canonicalizePath(targetPath)
      return !this.isInternalPath(canonical) && this.isPathWithinRoot(this.sandboxRoot, canonical)
    } catch {
      return false
    }
  }

  static isFileWriteAllowed(): { ok: boolean; reason: string } {
    const policy = getAgentModePolicy(this.agentMode)
    if (policy.allowFileWrite) {
      return { ok: true, reason: `${policy.label} mode allows file writes inside approved boundaries.` }
    }

    return { ok: false, reason: `${policy.label} mode is read-only. File writes are blocked.` }
  }

  static isPlaywrightMcpAllowed(): { ok: boolean; reason: string } {
    const policy = getAgentModePolicy(this.agentMode)
    if (policy.allowBrowserMcp) {
      return { ok: true, reason: `${policy.label} mode allows built-in browser MCP execution.` }
    }

    return { ok: false, reason: `${policy.label} mode blocks built-in browser MCP execution.` }
  }

  static isMcpEntryAllowed(entry: Pick<McpCatalogPolicyEntry, 'id' | 'chatAllowed' | 'adminOnly'>): { ok: boolean; reason: string } {
    const policy = getAgentModePolicy(this.agentMode)
    if (entry.adminOnly) {
      if (policy.allowAdminExtensions) {
        return { ok: true, reason: `${policy.label} mode allows admin-only MCP extensions.` }
      }

      return { ok: false, reason: `${policy.label} mode blocks admin-only MCP extensions.` }
    }

    if (entry.chatAllowed) {
      if (policy.allowChatMcpExtensions) {
        return { ok: true, reason: `${policy.label} mode allows chat-safe MCP extensions.` }
      }

      return { ok: false, reason: `${policy.label} mode blocks chat-safe MCP extensions.` }
    }

    if (policy.allowOpsMcpExtensions) {
      return { ok: true, reason: `${policy.label} mode allows ops-grade MCP extensions.` }
    }

    return { ok: false, reason: `${policy.label} mode blocks ops-grade MCP extensions.` }
  }

  static recordAgentDecision(action: string, allowed: boolean, reason: string, metadata?: Record<string, unknown>) {
    const entry: AgentAuditEntry = {
      timestamp: new Date().toISOString(),
      mode: this.agentMode,
      action,
      allowed,
      reason,
      metadata,
    }

    this.agentAuditLog.push(entry)
    if (this.agentAuditLog.length > 250) {
      this.agentAuditLog.shift()
    }

    const logMethod = allowed ? 'log' : 'warn'
    console[logMethod]('[AGENT-POLICY]', JSON.stringify(entry))
  }

  static isPathWithinRoot(rootPath: string, targetPath: string): boolean {
    try {
      const resolvedRoot = path.resolve(path.normalize(rootPath))
      const resolvedTarget = path.resolve(path.normalize(targetPath))
      const relativePath = path.relative(resolvedRoot, resolvedTarget)
      return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
    } catch {
      return false
    }
  }

  static isPathSafe(targetPath: string): boolean {
    try {
      const canonicalTarget = this.canonicalizePath(targetPath)
      if (this.isInternalPath(canonicalTarget)) {
        return false
      }
      return [...this.approvedProjectRoots].some((root) => this.isPathWithinRoot(root, canonicalTarget))
    } catch {
      return false
    }
  }

  static resolveSafeChildPath(rootPath: string, childPath: string): string {
    const normalizedChild = String(childPath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')

    const segments = normalizedChild.split('/')
    if (!normalizedChild || segments.some((segment) => segment === '..') || path.isAbsolute(normalizedChild) || /^[a-zA-Z]:/.test(normalizedChild)) {
      throw new Error(`Invalid child path: ${childPath}`)
    }

    const canonicalRoot = this.canonicalizePath(rootPath)
    const canonicalTarget = this.canonicalizePath(path.resolve(canonicalRoot, normalizedChild))
    if (!this.isPathWithinRoot(canonicalRoot, canonicalTarget)) {
      throw new Error(`Security violation: path escapes root: ${childPath}`)
    }

    return canonicalTarget
  }

  static isSafeFileExtension(filePath: string, allowedExtensions: string[]): boolean {
    const ext = path.extname(String(filePath || '')).toLowerCase()
    return allowedExtensions.map((entry) => entry.toLowerCase()).includes(ext)
  }

  static sanitizeShellArg(arg: string): string {
    let sanitized = arg.replace(/[\0\r\n]/g, '')
    sanitized = sanitized.replace(/[;&|`$<>(){}\[\]!#~'"\\]/g, '')
    return sanitized
  }

  static isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol)
    } catch {
      return false
    }
  }

  static getSafePath(targetPath: string): string {
    try {
      const canonical = this.canonicalizePath(targetPath)
      if (!this.isPathSafe(canonical)) {
        throw new Error(`Security Violation: Path traversal detected or unauthorized root: ${targetPath}`)
      }

      return canonical
    } catch {
      throw new Error(`Invalid path: ${targetPath}`)
    }
  }

  static canonicalizePath(targetPath: string): string {
    if (!targetPath || typeof targetPath !== 'string' || targetPath.includes('\0')) {
      throw new Error('Invalid path')
    }

    const absolute = path.resolve(path.normalize(targetPath))
    let cursor = absolute
    const suffix: string[] = []

    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw new Error(`No existing ancestor for path: ${targetPath}`)
      }
      suffix.unshift(path.basename(cursor))
      cursor = parent
    }

    const canonicalAncestor = fs.realpathSync.native(cursor)
    return path.resolve(canonicalAncestor, ...suffix)
  }

  static isInternalPath(targetPath: string): boolean {
    try {
      const canonical = this.canonicalizePath(targetPath)
      return this.getInternalRoots().some((root) => this.isPathWithinRoot(root, canonical))
    } catch {
      return true
    }
  }

  private static getInternalRoots(): string[] {
    return [
      path.join(getUserHome(), '.xyva'),
      getAgentDataRoot(),
      path.join(getUserHome(), '.gemini'),
    ].map((root) => this.canonicalizePath(root))
  }

  private static isForbiddenProjectRoot(canonical: string): boolean {
    const parsedRoot = path.parse(canonical).root
    const home = this.canonicalizePath(getUserHome())
    const temporaryRoot = this.canonicalizePath(os.tmpdir())
    if (canonical === parsedRoot || canonical === home || canonical === temporaryRoot || this.isInternalPath(canonical)) {
      return true
    }

    if (process.platform !== 'win32') {
      const protectedRoots = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/System', '/usr']
      if (protectedRoots.some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))) {
        return true
      }
    }

    return false
  }
}
