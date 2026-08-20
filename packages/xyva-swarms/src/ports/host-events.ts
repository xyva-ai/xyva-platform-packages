import type { GuardrailSkipEvent, SwarmAgentUpdate, SwarmFindingEvent, SwarmRun } from '../contracts'

export interface SwarmHostEventsPort {
  sendAgentUpdate(update: SwarmAgentUpdate): void
  sendFinding(event: SwarmFindingEvent): void
  sendGuardrailSkip(event: GuardrailSkipEvent): void
  sendError(message: string): void
  sendComplete(payload: { ok: boolean; run?: SwarmRun; runDir?: string; error?: string }): void
}
