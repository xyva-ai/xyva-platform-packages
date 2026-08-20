import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getAgentDataRoot } from '../utils/platform.js'

export type RunHistoryStatus = 'passed' | 'failed' | 'skipped' | 'error'
export type RunHistoryRunMode = 'all' | 'file' | 'name' | 'smart' | 'review-quick'

export interface RunHistoryEntry {
  id: string
  projectPath: string
  startedAt: number
  finishedAt: number
  durationMs: number
  status: RunHistoryStatus
  passed: number
  failed: number
  skipped: number
  errorCount: number
  skipReason: string | null
  runMode: RunHistoryRunMode
  testFiles: string[]
  summary: string | null
}

export type RunHistoryEntryInput = Omit<RunHistoryEntry, 'id' | 'projectPath'> & { id?: string }

interface RunHistoryFile {
  version: 1
  projectPath: string
  runs: RunHistoryEntry[]
}

const MAX_ENTRIES = 10
const SCHEMA_VERSION = 1
const writeQueues = new Map<string, Promise<RunHistoryEntry[] | void>>()

function getHistoryRoot(): string {
  const root = path.resolve(getAgentDataRoot(), 'run-history')
  return root
}

function hashProjectPath(projectPath: string): string {
  return crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 16)
}

function getHistoryFilePath(projectPath: string): string {
  const root = getHistoryRoot()
  return SecurityGuard.resolveSafeChildPath(root, `${hashProjectPath(projectPath)}.json`)
}

async function ensureHistoryDir(): Promise<void> {
  await fs.mkdir(getHistoryRoot(), { recursive: true })
}

function isValidRunHistoryEntry(value: unknown): value is RunHistoryEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.projectPath === 'string'
    && typeof entry.startedAt === 'number'
    && typeof entry.finishedAt === 'number'
    && typeof entry.durationMs === 'number'
    && typeof entry.status === 'string'
    && typeof entry.passed === 'number'
    && typeof entry.failed === 'number'
    && typeof entry.skipped === 'number'
    && typeof entry.errorCount === 'number'
    && (typeof entry.skipReason === 'string' || entry.skipReason === null)
    && typeof entry.runMode === 'string'
    && Array.isArray(entry.testFiles)
    && (typeof entry.summary === 'string' || entry.summary === null)
}

async function readHistoryFile(filePath: string, projectPath: string): Promise<RunHistoryFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RunHistoryFile>
    if (parsed?.version !== SCHEMA_VERSION || parsed.projectPath !== projectPath || !Array.isArray(parsed.runs)) {
      return null
    }

    if (!parsed.runs.every(isValidRunHistoryEntry)) {
      return null
    }

    return {
      version: SCHEMA_VERSION,
      projectPath,
      runs: parsed.runs.slice(0, MAX_ENTRIES),
    }
  } catch {
    return null
  }
}

async function writeHistoryFileAtomic(filePath: string, data: RunHistoryFile): Promise<void> {
  await ensureHistoryDir()
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tempPath, filePath).catch(async (error: NodeJS.ErrnoException) => {
      if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
        await fs.rm(filePath, { force: true })
        await fs.rename(tempPath, filePath)
        return
      }

      throw error
    })
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function waitForPendingWrite(filePath: string): Promise<void> {
  const pending = writeQueues.get(filePath)
  if (!pending) {
    return
  }

  await pending.catch(() => {})
}

async function enqueueWrite<T extends RunHistoryEntry[] | void>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  writeQueues.set(filePath, next)
  try {
    return await next
  } finally {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath)
    }
  }
}

function buildDefaultHistory(projectPath: string): RunHistoryFile {
  return {
    version: SCHEMA_VERSION,
    projectPath,
    runs: [],
  }
}

function normalizeInput(projectPath: string, entry: RunHistoryEntryInput): RunHistoryEntry {
  return {
    id: entry.id ?? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    projectPath,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    status: entry.status,
    passed: entry.passed,
    failed: entry.failed,
    skipped: entry.skipped,
    errorCount: entry.errorCount,
    skipReason: entry.skipReason,
    runMode: entry.runMode,
    testFiles: Array.isArray(entry.testFiles) ? entry.testFiles.filter((value): value is string => typeof value === 'string') : [],
    summary: typeof entry.summary === 'string' ? entry.summary : null,
  }
}

export class AgentRunHistoryService {
  async load(projectPath: string): Promise<RunHistoryEntry[]> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return []
    }

    const filePath = getHistoryFilePath(projectPath)
    await waitForPendingWrite(filePath)
    const data = await readHistoryFile(filePath, projectPath)
    return data?.runs ?? []
  }

  async append(projectPath: string, entry: RunHistoryEntryInput): Promise<RunHistoryEntry[]> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return []
    }

    const filePath = getHistoryFilePath(projectPath)
    return enqueueWrite(filePath, async () => {
      const current = (await readHistoryFile(filePath, projectPath)) ?? buildDefaultHistory(projectPath)
      const nextEntry = normalizeInput(projectPath, entry)
      const next: RunHistoryFile = {
        version: SCHEMA_VERSION,
        projectPath,
        runs: [nextEntry, ...current.runs].slice(0, MAX_ENTRIES),
      }
      await writeHistoryFileAtomic(filePath, next)
      return next.runs
    })
  }

  async clear(projectPath: string): Promise<boolean> {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      return false
    }

    const filePath = getHistoryFilePath(projectPath)
    await enqueueWrite(filePath, async () => {
      await fs.rm(filePath, { force: true }).catch(() => {})
    })
    return true
  }
}
