import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { SwarmRunHistoryEntry, SwarmRunRecord } from '@xyva/bridge-types'

import type { SwarmRun } from '../../../../xyva-swarms/src/contracts/run-events.js'
import { SecurityGuard } from '../../utils/SecurityGuard.js'
import { getAgentDataRoot } from '../../utils/platform.js'
import { toBridgeSwarmHistoryEntry, toBridgeSwarmRun } from './mappers.js'

const RUN_ID_PATTERN = /^swarm-[A-Za-z0-9._-]+$/

function getProjectHash(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex')
}

export class AgentSwarmRunStore {
  async prepareRun(projectPath: string, runId: string): Promise<{ runDir: string; screenshotDir: string }> {
    this.ensureProjectPath(projectPath)
    this.ensureRunId(runId)

    const runDir = path.join(this.getRunsRoot(projectPath), runId)
    const screenshotDir = path.join(runDir, 'screenshots')
    await fs.mkdir(screenshotDir, { recursive: true })

    return { runDir, screenshotDir }
  }

  async writeRunArtifacts(projectPath: string, runId: string, run: SwarmRun): Promise<{ runDir: string }> {
    this.ensureProjectPath(projectPath)
    this.ensureRunId(runId)

    const runDir = path.join(this.getRunsRoot(projectPath), runId)
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2), 'utf-8')

    return { runDir }
  }

  async listRuns(projectPath: string): Promise<SwarmRunHistoryEntry[]> {
    this.ensureProjectPath(projectPath)

    try {
      const entries = await fs.readdir(this.getRunsRoot(projectPath), { withFileTypes: true })
      const runIds = entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .slice(0, 25)

      const runs = await Promise.all(runIds.map((runId) => this.readRun(projectPath, runId)))
      return runs
        .filter((run): run is SwarmRun => !!run)
        .map((run) => toBridgeSwarmHistoryEntry(run))
    } catch {
      return []
    }
  }

  async getRunDetail(projectPath: string, runId: string): Promise<SwarmRunRecord | null> {
    this.ensureProjectPath(projectPath)
    this.ensureRunId(runId)

    const run = await this.readRun(projectPath, runId)
    return run ? toBridgeSwarmRun(run) : null
  }

  private async readRun(projectPath: string, runId: string): Promise<SwarmRun | null> {
    try {
      const raw = await fs.readFile(path.join(this.getRunsRoot(projectPath), runId, 'run.json'), 'utf-8')
      return JSON.parse(raw) as SwarmRun
    } catch {
      return null
    }
  }

  private getRunsRoot(projectPath: string): string {
    const root = path.join(getAgentDataRoot(), 'swarm-runs', getProjectHash(projectPath), 'runs')
    return root
  }

  private ensureProjectPath(projectPath: string): void {
    if (!projectPath || !SecurityGuard.isApprovedProjectRoot(projectPath)) {
      throw new Error('Unauthorized project path')
    }
  }

  private ensureRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(String(runId || ''))) {
      throw new Error('Invalid run id')
    }
  }
}
