import type { SwarmAuthConfig } from '../contracts'

export interface SwarmAuthSessionPort {
  createStorageState(browser: unknown, auth: SwarmAuthConfig, password: string): Promise<unknown>
}
