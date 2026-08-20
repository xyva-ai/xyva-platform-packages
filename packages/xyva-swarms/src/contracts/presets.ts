import type { SwarmAgentId } from './findings'

export type ScanPresetId = 'quick-smoke' | 'standard' | 'deep-audit'
export type SwarmRunMode = 'preset' | 'expert'

export interface SwarmBudgets {
  maxTotalTimeMs: number
  maxPagesPerAgent: number
  maxScreenshots: number
  maxAiTokens: number
}

export interface ScanPreset {
  id: ScanPresetId
  label: string
  description: string
  agents: SwarmAgentId[]
  budgets: SwarmBudgets
  headless: boolean
  crawlDepth: number
}

export interface SwarmAdvancedSettings {
  agents: SwarmAgentId[]
  budgets: SwarmBudgets
  headless: boolean
  crawlDepth: number
}
