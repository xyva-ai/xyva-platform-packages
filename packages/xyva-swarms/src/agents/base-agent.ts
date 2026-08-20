import path from 'node:path'
import type { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import { classifyAction, isAllowedForAgent, type ElementInfo } from '../core/policy/action-policy'
import { mapRawFindingSeverity } from '../core/findings/findings-normalizer'
import type { AgentStatus, GuardrailSkipEvent, SwarmAgentUpdate, SwarmFindingEvent } from '../contracts/run-events'
import type { Evidence, RawFinding, SwarmAgentId } from '../contracts/findings'
import type { SwarmBudgets } from '../contracts/presets'

export abstract class BaseSwarmAgent {
  private _pagesVisited = 0
  private _findings: RawFinding[] = []
  private _skippedActions = 0
  private _startTime = 0
  private _screenshotCount = 0
  private _stopRequested = false
  private _status: AgentStatus = 'pending'

  constructor(
    public readonly agentId: SwarmAgentId,
    protected page: Page,
    protected budgets: SwarmBudgets,
    protected emitter: EventEmitter,
    protected screenshotDir: string,
    protected activeAgentCount: number,
    protected crawlDepth: number,
  ) {}

  abstract execute(targetUrl: string): Promise<void>

  get pagesVisited(): number { return this._pagesVisited }
  get findings(): RawFinding[] { return this._findings }
  get skippedActions(): number { return this._skippedActions }
  get status(): AgentStatus { return this._status }

  requestStop(): void {
    this._stopRequested = true
  }

  async run(targetUrl: string): Promise<RawFinding[]> {
    this._startTime = Date.now()
    this.emitProgress('running')
    try {
      await this.execute(targetUrl)
      this.emitProgress(this._stopRequested ? 'stopped' : 'completed')
    } catch (err: any) {
      if (err?.message === 'BUDGET_EXCEEDED') {
        this.emitProgress('timeout')
      } else if (err?.message === 'STOP_REQUESTED') {
        this.emitProgress('stopped')
      } else {
        this.emitProgress('error', err?.message ?? 'Unknown error')
        throw err
      }
    }
    return this._findings
  }

  protected checkBudget(): void {
    if (this._stopRequested) throw new Error('STOP_REQUESTED')

    const elapsed = Date.now() - this._startTime
    const perAgentTime = this.budgets.maxTotalTimeMs / Math.max(1, this.activeAgentCount)
    if (elapsed > perAgentTime) throw new Error('BUDGET_EXCEEDED')
    if (this._pagesVisited >= this.budgets.maxPagesPerAgent) throw new Error('BUDGET_EXCEEDED')
  }

  protected async safeGoto(url: string): Promise<boolean> {
    this.checkBudget()
    try {
      const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      this._pagesVisited++
      this.emitProgress('running')
      return resp !== null
    } catch {
      return false
    }
  }

  protected async safeClick(selector: string): Promise<boolean> {
    try {
      const info = await this.page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        return {
          tagName: el.tagName,
          text: (el as HTMLElement).innerText?.slice(0, 100) ?? '',
          type: (el as HTMLInputElement).type ?? undefined,
          href: (el as HTMLAnchorElement).href ?? undefined,
          classList: [...el.classList],
          formAction: (el as HTMLButtonElement).formAction ?? undefined,
        }
      }, selector)

      if (!info) return false

      const decision = classifyAction(info as ElementInfo)
      if (!isAllowedForAgent(this.agentId, decision)) {
        this._skippedActions++
        const skipEvent: GuardrailSkipEvent = {
          agentId: this.agentId,
          selector,
          elementText: String((info as { text?: string }).text ?? '').slice(0, 60),
          reason: decision.reason,
          riskLevel: decision.riskLevel,
          timestamp: new Date().toISOString(),
        }
        this.emitter.emit('swarm:guardrail-skip', skipEvent)
        return false
      }

      await this.page.click(selector, { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  protected async screenshot(label: string): Promise<Evidence | null> {
    if (this._screenshotCount >= this.budgets.maxScreenshots) return null
    try {
      const filename = `${this.agentId}-${this._screenshotCount++}-${label.replace(/[^a-z0-9]/gi, '_')}.png`
      const filepath = path.join(this.screenshotDir, filename)
      await this.page.screenshot({ path: filepath, fullPage: false })
      return { type: 'screenshot', label, data: { path: filepath } }
    } catch {
      return null
    }
  }

  protected addFinding(finding: RawFinding): void {
    this._findings.push(finding)
    const event: SwarmFindingEvent = {
      agentId: this.agentId,
      finding: { title: finding.title, type: finding.type, severity: mapRawFindingSeverity(finding) },
    }
    this.emitter.emit('swarm:finding', event)
    this.emitProgress('running')
  }

  private emitProgress(status: AgentStatus, _error?: string): void {
    this._status = status
    const update: SwarmAgentUpdate = {
      agentId: this.agentId,
      status,
      pagesVisited: this._pagesVisited,
      findingsCount: this._findings.length,
      elapsed: Date.now() - this._startTime,
    }
    this.emitter.emit('swarm:agent-update', update)
  }
}
