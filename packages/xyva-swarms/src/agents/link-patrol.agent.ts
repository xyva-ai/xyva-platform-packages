import dns from 'node:dns/promises'
import { BaseSwarmAgent } from './base-agent'

const KNOWN_BOT_BLOCKERS = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com',
])

export class LinkPatrolAgent extends BaseSwarmAgent {
  private visited = new Set<string>()
  private origin = ''

  async execute(targetUrl: string): Promise<void> {
    this.origin = new URL(targetUrl).origin
    await this.crawl(targetUrl, targetUrl, 0, this.crawlDepth)
  }

  private async crawl(url: string, parentUrl: string, depth: number, maxDepth: number): Promise<void> {
    const normalized = this.normalizeUrl(url)
    if (this.visited.has(normalized)) return
    this.visited.add(normalized)
    this.checkBudget()

    const isInternal = normalized.startsWith(this.origin)

    if (isInternal) {
      const ok = await this.safeGoto(normalized)
      if (!ok) {
        this.addFinding({
          type: 'broken-link',
          title: `Navigation failed: ${normalized}`,
          description: `Could not load ${normalized}`,
          url: normalized,
          pageUrl: parentUrl,
          evidence: [],
        })
        return
      }

      if (depth < maxDepth) {
        const links = await this.page.evaluate(() =>
          [...document.querySelectorAll('a[href]')]
            .map(a => (a as HTMLAnchorElement).href)
            .filter(h => h.startsWith('http')),
        )
        for (const link of links) {
          await this.crawl(link, normalized, depth + 1, maxDepth)
        }
      }
    } else {
      await this.validateExternal(normalized)
    }
  }

  private async validateExternal(url: string): Promise<void> {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    if (KNOWN_BOT_BLOCKERS.has(hostname)) return

    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XYVA-QA/1.0)' },
        redirect: 'follow',
      })
      if (resp.ok) return
      if (resp.status === 429 || resp.status === 403) {
        this.addFinding({
          type: 'inconclusive-link',
          title: `External link needs manual check: ${url}`,
          description: `HEAD returned ${resp.status} - likely bot-blocked, not necessarily broken`,
          url,
          pageUrl: this.page.url(),
          needsManualCheck: true,
          evidence: [{ type: 'network-log', label: 'HEAD response', data: { statusCode: resp.status, inconclusive: true } }],
        })
        return
      }
    } catch {
      // fall through
    }

    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html' },
        redirect: 'follow',
      })
      if (resp.ok) return
      if (resp.status === 403 || resp.status === 429) {
        this.addFinding({
          type: 'inconclusive-link',
          title: `External link needs manual check: ${url}`,
          description: `GET returned ${resp.status} - access restricted`,
          url,
          pageUrl: this.page.url(),
          needsManualCheck: true,
          evidence: [{ type: 'network-log', label: 'GET response', data: { statusCode: resp.status, inconclusive: true } }],
        })
        return
      }

      this.addFinding({
        type: 'broken-link',
        title: `Broken external link: ${url} (${resp.status})`,
        description: `GET returned ${resp.status}`,
        url,
        pageUrl: this.page.url(),
        statusCode: resp.status,
        evidence: [{ type: 'network-log', label: 'GET response', data: { statusCode: resp.status } }],
      })
      return
    } catch {
      // fall through
    }

    try {
      await dns.resolve(new URL(url).hostname)
      this.addFinding({
        type: 'inconclusive-link',
        title: `External link unreachable: ${url}`,
        description: 'DNS resolves but server did not respond',
        url,
        pageUrl: this.page.url(),
        needsManualCheck: true,
        evidence: [{ type: 'network-log', label: 'Timeout', data: { reason: 'no-response' } }],
      })
    } catch {
      this.addFinding({
        type: 'broken-link',
        title: `DNS failure: ${url}`,
        description: `Domain ${new URL(url).hostname} does not resolve`,
        url,
        pageUrl: this.page.url(),
        statusCode: 0,
        evidence: [{ type: 'network-log', label: 'DNS failure', data: { reason: 'NXDOMAIN' } }],
      })
    }
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url)
      u.hash = ''
      return u.href.replace(/\/$/, '')
    } catch {
      return url
    }
  }
}
