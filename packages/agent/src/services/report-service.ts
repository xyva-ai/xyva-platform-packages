import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { SecurityGuard } from '../utils/SecurityGuard.js'
import { getAgentDataRoot, getGitBinary } from '../utils/platform.js'

export interface TestCaseResult {
  title: string
  file: string
  status: 'passed' | 'failed' | 'skipped' | 'timedOut'
  duration: number
  error?: string
}

export interface TestRun {
  id: string
  timestamp: number
  duration: number
  status: 'passed' | 'failed'
  stats: {
    total: number
    passed: number
    failed: number
    skipped: number
  }
  project: string
  commitHash?: string
  tests: TestCaseResult[]
}

export interface ReportServiceOptions {
  historyPath?: string
}

export class AgentReportService {
  private readonly historyPath: string

  constructor(options: ReportServiceOptions = {}) {
    // TODO: keep this path configurable until the SaaS agent settles on its durable local storage contract.
    this.historyPath = options.historyPath || path.join(getAgentDataRoot(), 'report-history.json')
  }

  async ensureHistoryFile(): Promise<void> {
    try {
      await fs.access(this.historyPath)
    } catch {
      await fs.mkdir(path.dirname(this.historyPath), { recursive: true })
      await fs.writeFile(this.historyPath, JSON.stringify([]), 'utf-8')
    }
  }

  private getCommitHash(projectPath: string): string {
    try {
      return execFileSync(getGitBinary(), ['rev-parse', '--short', 'HEAD'], {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim()
    } catch {
      return 'unknown'
    }
  }

  private extractTestsRecursively(suite: any, file = ''): TestCaseResult[] {
    let results: TestCaseResult[] = []
    const currentFile = suite.file || file

    if (suite.specs) {
      suite.specs.forEach((spec: any) => {
        spec.tests.forEach((test: any) => {
          test.results.forEach((result: any) => {
            results.push({
              title: spec.title,
              file: currentFile,
              status: result.status,
              duration: result.duration,
              error: result.error?.message,
            })
          })
        })
      })
    }

    if (suite.suites) {
      suite.suites.forEach((childSuite: any) => {
        results = results.concat(this.extractTestsRecursively(childSuite, currentFile))
      })
    }

    return results
  }

  async ingest(projectPath: string, reportJsonPath: string) {
    try {
      if (!SecurityGuard.isApprovedProjectRoot(projectPath)) {
        return { ok: false, error: 'Unauthorized project path' }
      }

      const canonicalProjectPath = SecurityGuard.canonicalizePath(projectPath)

      await this.ensureHistoryFile()
      const fullPath = path.isAbsolute(reportJsonPath)
        ? SecurityGuard.canonicalizePath(reportJsonPath)
        : SecurityGuard.resolveSafeChildPath(canonicalProjectPath, reportJsonPath)

      if (!SecurityGuard.isPathWithinRoot(canonicalProjectPath, fullPath) || !SecurityGuard.isPathSafe(fullPath)) {
        return { ok: false, error: 'Report path escapes project root' }
      }

      try {
        if (!(await fs.stat(fullPath)).isFile()) {
          return { ok: false, error: `Report file not found at: ${fullPath}` }
        }
      } catch {
        return { ok: false, error: `Report file not found at: ${fullPath}` }
      }

      const content = await fs.readFile(fullPath, 'utf-8')
      const raw = JSON.parse(content)

      let testResults: TestCaseResult[] = []
      if (raw.suites) {
        raw.suites.forEach((suite: any) => {
          testResults = testResults.concat(this.extractTestsRecursively(suite))
        })
      }

      const run: TestRun = {
        id: `run_${Date.now()}`,
        timestamp: Date.now(),
        duration: raw.stats?.duration || 0,
        status: (raw.stats?.unexpected || 0) === 0 ? 'passed' : 'failed',
        stats: {
          total: raw.stats?.total || 0,
          passed: raw.stats?.expected || 0,
          failed: raw.stats?.unexpected || 0,
          skipped: raw.stats?.skipped || 0,
        },
        project: path.basename(canonicalProjectPath),
        commitHash: this.getCommitHash(canonicalProjectPath),
        tests: testResults,
      }

      const historyContent = await fs.readFile(this.historyPath, 'utf-8')
      const history = JSON.parse(historyContent) as TestRun[]
      history.unshift(run)

      await fs.writeFile(this.historyPath, JSON.stringify(history.slice(0, 100), null, 2), 'utf-8')

      return { ok: true, run }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async getHistory(): Promise<TestRun[]> {
    try {
      await this.ensureHistoryFile()
      const content = await fs.readFile(this.historyPath, 'utf-8')
      return JSON.parse(content) as TestRun[]
    } catch {
      return []
    }
  }

  async exportCsv(): Promise<string> {
    try {
      await this.ensureHistoryFile()
      const history = await this.getHistory()
      let csv = 'Timestamp,Project,Passed,Failed,Total,PassRate%\n'

      history.forEach((run) => {
        const total = run.stats.passed + run.stats.failed
        const rate = Math.round((run.stats.passed / total) * 100) || 0
        csv += `${new Date(run.timestamp).toISOString()},${run.project},${run.stats.passed},${run.stats.failed},${total},${rate}%\n`
      })

      return csv
    } catch {
      return ''
    }
  }
}
