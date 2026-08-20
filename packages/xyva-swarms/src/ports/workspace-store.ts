import type { CoverageGap, RunKnowledge, SuggestedTest, SwarmKnowledgeSnapshot, SwarmRun } from '../contracts'

export interface SwarmRunPaths {
  runDir: string
  screenshotDir: string
}

export interface SwarmDiscoveredTest {
  file: string
  tests: string[]
  content?: string
}

export interface SwarmKnowledgeArtifacts {
  snapshot: SwarmKnowledgeSnapshot
  gaps: CoverageGap[]
  suggestions: SuggestedTest[]
}

export interface SwarmWorkspaceStorePort {
  prepareRun(projectPath: string, runId: string): Promise<SwarmRunPaths>
  writeRunArtifacts(projectPath: string, runId: string, run: SwarmRun, runKnowledge: RunKnowledge): Promise<{ runDir: string }>
  readKnowledge(projectPath: string, initialSnapshot: SwarmKnowledgeSnapshot): Promise<SwarmKnowledgeArtifacts>
  writeKnowledge(projectPath: string, artifacts: SwarmKnowledgeArtifacts): Promise<void>
  discoverTests(projectPath: string): Promise<SwarmDiscoveredTest[]>
  writeGeneratedSkeleton(projectPath: string, filePath: string, code: string): Promise<{ targetPath: string }>
}
