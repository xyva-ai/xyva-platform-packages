import type { SwarmAuthConfig } from './auth'
import type { SwarmAgentId } from './findings'
import type { ScanPresetId, SwarmBudgets, SwarmRunMode } from './presets'

export interface SwarmConfig {
  targetUrl: string
  agents: SwarmAgentId[]
  budgets: SwarmBudgets
  headless: boolean
  crawlDepth: number
  mode: SwarmRunMode
  presetId?: ScanPresetId
  auth?: SwarmAuthConfig
}
