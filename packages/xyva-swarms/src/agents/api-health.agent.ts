import { BaseSwarmAgent } from './base-agent'

interface ApiEndpoint {
  url: string
  method: string
  source: 'intercepted' | 'well-known'
}

interface ApiCheckResult {
  url: string
  method: string
  status: number | null
  responseTimeMs: number
  isJson: boolean
  error: string | null
}

const SLOW_THRESHOLD_MS = 2000

const WELL_KNOWN_PATHS = ['/health', '/api/status', '/api/health', '/graphql']

export class ApiHealthAgent extends BaseSwarmAgent {
  async execute(targetUrl: string): Promise<void> {
    const origin = new URL(targetUrl).origin
    const discovered = await this.discoverApiEndpoints(targetUrl, origin)
    const wellKnown = WELL_KNOWN_PATHS.map((p) => ({
      url: `${origin}${p}`,
      method: 'GET',
      source: 'well-known' as const,
    }))

    const allEndpoints = this.deduplicateEndpoints([...discovered, ...wellKnown])

    for (const endpoint of allEndpoints) {
      this.checkBudget()
      await this.checkEndpoint(endpoint, targetUrl)
    }
  }

  private async discoverApiEndpoints(targetUrl: string, origin: string): Promise<ApiEndpoint[]> {
    const endpoints: ApiEndpoint[] = []

    await this.page.route('**/*', async (route) => {
      const request = route.request()
      const url = request.url()
      const resourceType = request.resourceType()

      if (resourceType === 'fetch' || resourceType === 'xhr') {
        endpoints.push({
          url,
          method: request.method(),
          source: 'intercepted',
        })
      }

      await route.continue()
    })

    const ok = await this.safeGoto(targetUrl)
    if (ok) {
      // Wait for async requests to fire
      await this.page.waitForTimeout(3000)
    }

    // Remove route handler
    await this.page.unroute('**/*')

    return endpoints
  }

  private deduplicateEndpoints(endpoints: ApiEndpoint[]): ApiEndpoint[] {
    const seen = new Set<string>()
    const unique: ApiEndpoint[] = []

    for (const ep of endpoints) {
      const key = `${ep.method}::${ep.url}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(ep)
      }
    }

    return unique.slice(0, this.budgets.maxPagesPerAgent)
  }

  private async checkEndpoint(endpoint: ApiEndpoint, pageUrl: string): Promise<void> {
    const result = await this.probeEndpoint(endpoint)

    // Unreachable endpoint
    if (result.error !== null) {
      this.addFinding({
        type: 'api-health-issue',
        title: `Unreachable API endpoint: ${endpoint.method} ${endpoint.url}`,
        description: `API endpoint ${endpoint.url} could not be reached. Error: ${result.error}`,
        url: endpoint.url,
        pageUrl,
        statusCode: result.status ?? undefined,
        responseTime: result.responseTimeMs,
        evidence: [{
          type: 'api-response',
          label: 'Unreachable endpoint',
          data: { method: endpoint.method, url: endpoint.url, error: result.error, source: endpoint.source },
        }],
      })
      return
    }

    // Non-2xx status
    if (result.status !== null && (result.status < 200 || result.status >= 300)) {
      const severity = result.status >= 500 ? 'high' : 'medium'
      this.addFinding({
        type: 'api-health-issue',
        title: `API returned HTTP ${result.status}: ${endpoint.method} ${endpoint.url}`,
        description: `API endpoint ${endpoint.url} returned status ${result.status}. Expected a 2xx response.`,
        url: endpoint.url,
        pageUrl,
        statusCode: result.status,
        responseTime: result.responseTimeMs,
        evidence: [{
          type: 'api-response',
          label: `HTTP ${result.status}`,
          data: { method: endpoint.method, url: endpoint.url, status: result.status, responseTimeMs: result.responseTimeMs, source: endpoint.source },
        }],
      })
    }

    // Slow response
    if (result.responseTimeMs > SLOW_THRESHOLD_MS) {
      this.addFinding({
        type: 'api-health-issue',
        title: `Slow API response: ${Math.round(result.responseTimeMs)}ms on ${endpoint.url}`,
        description: `API endpoint ${endpoint.url} took ${Math.round(result.responseTimeMs)}ms to respond (threshold: ${SLOW_THRESHOLD_MS}ms).`,
        url: endpoint.url,
        pageUrl,
        statusCode: result.status ?? undefined,
        responseTime: result.responseTimeMs,
        evidence: [{
          type: 'api-response',
          label: 'Slow response',
          data: { method: endpoint.method, url: endpoint.url, responseTimeMs: result.responseTimeMs, threshold: SLOW_THRESHOLD_MS, source: endpoint.source },
        }],
      })
    }
  }

  private async probeEndpoint(endpoint: ApiEndpoint): Promise<ApiCheckResult> {
    const start = Date.now()

    try {
      const response = await this.page.request.fetch(endpoint.url, {
        method: endpoint.method,
        timeout: 10_000,
        headers: { Accept: 'application/json, */*' },
      })

      const responseTimeMs = Date.now() - start
      const contentType = response.headers()['content-type'] ?? ''
      const isJson = contentType.includes('application/json')

      return {
        url: endpoint.url,
        method: endpoint.method,
        status: response.status(),
        responseTimeMs,
        isJson,
        error: null,
      }
    } catch (err: any) {
      return {
        url: endpoint.url,
        method: endpoint.method,
        status: null,
        responseTimeMs: Date.now() - start,
        isJson: false,
        error: err?.message ?? 'Unknown error',
      }
    }
  }
}
