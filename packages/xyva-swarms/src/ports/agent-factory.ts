import type { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import type { SwarmAgentId, SwarmConfig } from '../contracts'

export interface SwarmAgentFactoryInput {
  agentId: SwarmAgentId
  page: Page
  config: SwarmConfig
  emitter: EventEmitter
  screenshotDir: string
}
