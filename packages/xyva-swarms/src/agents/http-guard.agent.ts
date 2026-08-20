import { BaseSwarmAgent } from './base-agent'
import type { Evidence } from '../contracts/findings'

export class HttpGuardAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    const pagesToVisit = await this.discoverPages(targetUrl)

    for (const url of pagesToVisit) {
      this.checkBudget()
      await this.auditPage(url)
    }
  }

  private async discoverPages(startUrl: string): Promise<string[]> {
    await this.safeGoto(startUrl)
    const links = await this.page.evaluate((origin) => {
      return [...new Set(
        [...document.querySelectorAll('a[href]')]
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => h.startsWith(origin)),
      )].slice(0, 10)
    }, new URL(startUrl).origin)

    return [startUrl, ...links.slice(0, this.budgets.maxPagesPerAgent - 1)]
  }

  private async auditPage(url: string): Promise<void> {
    const networkErrors: Evidence[] = []
    const consoleErrors: Evidence[] = []

    const onResponse = (response: any) => {
      if (response.status() >= 400) {
        networkErrors.push({
          type: 'network-log',
          label: `${response.status()} ${response.url()}`,
          data: { statusCode: response.status(), method: response.request().method(), url: response.url() },
        })
      }
    }

    const onRequestFailed = (request: any) => {
      networkErrors.push({
        type: 'network-log',
        label: `Failed: ${request.url()}`,
        data: { url: request.url(), method: request.method(), failure: request.failure()?.errorText },
      })
    }

    const onConsole = (msg: any) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push({
          type: 'console-log',
          label: msg.type(),
          data: { level: msg.type(), message: msg.text().slice(0, 500), url },
        })
      }
    }

    this.page.on('response', onResponse)
    this.page.on('requestfailed', onRequestFailed)
    this.page.on('console', onConsole)

    await this.safeGoto(url)
    await this.page.waitForTimeout(3000)

    this.page.off('response', onResponse)
    this.page.off('requestfailed', onRequestFailed)
    this.page.off('console', onConsole)

    for (const e of networkErrors) {
      const code = (e.data as { statusCode?: number }).statusCode
      this.addFinding({
        type: code ? 'http-error' : 'network-failure',
        title: e.label,
        description: `${String((e.data as { method?: string }).method ?? 'GET')} ${String((e.data as { url?: string }).url ?? url)} -> ${String(code ?? 'failed')}`,
        url: String((e.data as { url?: string }).url ?? url),
        pageUrl: url,
        statusCode: code,
        evidence: [e],
      })
    }

    for (const e of consoleErrors) {
      this.addFinding({
        type: 'console-error',
        title: `Console ${String((e.data as { level?: string }).level)}: ${String((e.data as { message?: string }).message ?? '').slice(0, 80)}`,
        description: String((e.data as { message?: string }).message ?? ''),
        url,
        pageUrl: url,
        consoleType: (e.data as { level?: 'error' | 'warning' }).level,
        evidence: [e],
      })
    }
  }
}
